import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { WORLD_SIZE, WATER_LEVEL, terrainHeight, terrainSlope, forestDensity } from './terrain.js';
import { mulberry32, fbm } from './noise.js';

const rand = mulberry32(20260611);

// 頂点を法線方向にノイズで変位させ、有機的なシルエットにする
function displace(geometry, amount, freq, seed = 0) {
  geometry.computeVertexNormals();
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const d = (fbm(x * freq + y * freq * 0.7 + seed, z * freq - y * freq * 0.5, 3, seed) - 0.5) * 2 * amount;
    pos.setXYZ(i, x + nor.getX(i) * d, y + nor.getY(i) * d, z + nor.getZ(i) * d);
  }
  geometry.computeVertexNormals();
  return geometry;
}

// 高さ方向のグラデーションで頂点カラーを塗る（下が暗く上が明るい = 簡易 AO + 透過光）
function paintGradient(geometry, bottomHex, topHex, yMin, yMax) {
  const c0 = new THREE.Color(bottomHex);
  const c1 = new THREE.Color(topHex);
  const tmp = new THREE.Color();
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, (pos.getY(i) - yMin) / (yMax - yMin)));
    tmp.lerpColors(c0, c1, t);
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

// スムースシェーディングのブロブ（mergeVertices で法線を共有させる）
function smoothBlob(radius, detail, displaceAmt, freq, seed) {
  let g = new THREE.IcosahedronGeometry(radius, detail);
  g = BufferGeometryUtils.mergeVertices(g);
  displace(g, displaceAmt, freq, seed);
  return g;
}

function standardMaterial(extra = {}) {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
    ...extra,
  });
}

// 条件を満たす地点をばら撒く（rejection sampling）
function scatter(count, accept) {
  const points = [];
  let attempts = 0;
  const maxAttempts = count * 40;
  while (points.length < count && attempts < maxAttempts) {
    attempts++;
    const x = (rand() - 0.5) * WORLD_SIZE * 0.92;
    const z = (rand() - 0.5) * WORLD_SIZE * 0.92;
    const h = terrainHeight(x, z);
    if (accept(x, z, h)) points.push({ x, z, h });
  }
  return points;
}

function buildInstances(geometry, material, points, place) {
  const mesh = new THREE.InstancedMesh(geometry, material, points.length);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const color = new THREE.Color();
  const axisY = new THREE.Vector3(0, 1, 0);

  points.forEach((p, i) => {
    const o = place(p);
    position.set(p.x, p.h + (o.sink ?? 0), p.z);
    quaternion.setFromAxisAngle(axisY, rand() * Math.PI * 2);
    scale.setScalar(o.scale);
    if (o.scaleY) scale.y = o.scale * o.scaleY;
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(i, matrix);
    if (o.tint) {
      color.setHSL(o.tint.h, o.tint.s, o.tint.l);
      mesh.setColorAt(i, color);
    }
  });
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

function createConifers() {
  // 丸みのある段々の樹冠。ブロブを潰して積む
  let trunk = BufferGeometryUtils.mergeVertices(new THREE.CylinderGeometry(0.16, 0.34, 2.2, 7));
  trunk.translate(0, 1.1, 0);
  displace(trunk, 0.05, 1.5, 11);
  paintGradient(trunk, 0x4a3826, 0x5d4630, 0, 2.2);

  const layers = [
    { r: 2.0, y: 2.7, squash: 0.62, seed: 1 },
    { r: 1.5, y: 4.1, squash: 0.66, seed: 2 },
    { r: 1.0, y: 5.3, squash: 0.75, seed: 3 },
  ].map((s) => {
    const g = smoothBlob(s.r, 1, s.r * 0.22, 1.6, s.seed);
    g.scale(1, s.squash, 1);
    g.translate(0, s.y, 0);
    return g;
  });
  // 樹冠全体で下が暗く上が明るいグラデーション
  const crown = BufferGeometryUtils.mergeGeometries(layers);
  paintGradient(crown, 0x2e5526, 0x5a8c3c, 1.6, 6.2);

  const geometry = BufferGeometryUtils.mergeGeometries([trunk, crown]);
  const material = standardMaterial();

  const points = scatter(1400, (x, z, h) => {
    if (h < WATER_LEVEL + 2 || h > 30) return false;
    if (terrainSlope(x, z) > 0.85) return false;
    return forestDensity(x, z) > 0.55;
  });

  const mesh = buildInstances(geometry, material, points, () => ({
    scale: 0.8 + rand() * 1.1,
    sink: -0.15,
    tint: { h: 0.28 + rand() * 0.06, s: 0.25 + rand() * 0.2, l: 0.5 + rand() * 0.18 },
  }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function createBroadleaves() {
  let trunk = BufferGeometryUtils.mergeVertices(new THREE.CylinderGeometry(0.2, 0.42, 2.8, 7));
  trunk.translate(0, 1.4, 0);
  displace(trunk, 0.07, 1.2, 21);
  paintGradient(trunk, 0x55432e, 0x6b5238, 0, 2.8);

  const crownSpec = [
    { r: 1.9, x: 0, y: 3.9, z: 0, seed: 31 },
    { r: 1.4, x: 1.3, y: 3.3, z: 0.4, seed: 32 },
    { r: 1.3, x: -1.2, y: 3.4, z: -0.3, seed: 33 },
    { r: 1.2, x: 0.3, y: 5.0, z: 0.5, seed: 34 },
    { r: 1.1, x: -0.4, y: 4.6, z: 0.9, seed: 35 },
  ];
  const crowns = crownSpec.map((s) => {
    const g = smoothBlob(s.r, 2, s.r * 0.24, 1.4, s.seed);
    g.scale(1, 0.85, 1);
    g.translate(s.x, s.y, s.z);
    return g;
  });
  const crown = BufferGeometryUtils.mergeGeometries(crowns);
  paintGradient(crown, 0x39602a, 0x77a844, 2.2, 6.0);

  const geometry = BufferGeometryUtils.mergeGeometries([trunk, crown]);
  const material = standardMaterial();

  // 草原にぽつぽつ生える広葉樹（森の外側）
  const points = scatter(280, (x, z, h) => {
    if (h < WATER_LEVEL + 2 || h > 26) return false;
    if (terrainSlope(x, z) > 0.7) return false;
    const f = forestDensity(x, z);
    return f > 0.35 && f < 0.55 && rand() < 0.5;
  });

  const mesh = buildInstances(geometry, material, points, () => ({
    scale: 0.7 + rand() * 0.9,
    sink: -0.15,
    tint: { h: 0.26 + rand() * 0.08, s: 0.35 + rand() * 0.2, l: 0.5 + rand() * 0.15 },
  }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function createRocks() {
  const geometry = smoothBlob(1, 2, 0.38, 0.9, 41);
  paintGradient(geometry, 0x5f594c, 0x9a948a, -1, 1);
  const material = standardMaterial({ roughness: 1.0 });

  const points = scatter(180, (x, z, h) => h > WATER_LEVEL - 2 && h < 35);

  const mesh = buildInstances(geometry, material, points, () => ({
    scale: 0.4 + rand() * 1.6,
    scaleY: 0.6 + rand() * 0.4,
    sink: -0.3,
    tint: { h: 0.1, s: 0.02 + rand() * 0.06, l: 0.45 + rand() * 0.2 },
  }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function createFlowers() {
  // 細い茎 + 十字の花弁。花弁だけインスタンスカラーで彩色する
  // 草（高さ ~0.7m）から花が覗くように少し背を高くする
  const stem = new THREE.PlaneGeometry(0.03, 0.55).translate(0, 0.275, 0);
  {
    const c = new THREE.Color(0x3f7a33);
    const n = stem.attributes.position.count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    stem.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  const petal = new THREE.PlaneGeometry(0.16, 0.16).translate(0, 0.58, 0);
  const petalCross = petal.clone().rotateY(Math.PI / 2);
  const count = petal.attributes.position.count;
  const white = new Float32Array(count * 3).fill(1);
  petal.setAttribute('color', new THREE.BufferAttribute(white, 3));
  petalCross.setAttribute('color', new THREE.BufferAttribute(white.slice(), 3));
  const geometry = BufferGeometryUtils.mergeGeometries([stem, petal, petalCross]);

  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  material.reflectivity = 0;

  // 開けた草原（森の外）に群生させる
  const points = scatter(9000, (x, z, h) => {
    if (h < WATER_LEVEL + 1.6 || h > 22) return false;
    if (forestDensity(x, z) > 0.5) return false;
    return terrainSlope(x, z) < 0.5;
  });

  const palette = [
    { h: 0.12, s: 0.85, l: 0.62 }, // 黄
    { h: 0.0, s: 0.0, l: 0.95 },   // 白
    { h: 0.9, s: 0.55, l: 0.72 },  // 桃
    { h: 0.75, s: 0.45, l: 0.68 }, // 紫
  ];
  const mesh = buildInstances(geometry, material, points, () => {
    const p = palette[Math.floor(rand() * palette.length)];
    return {
      scale: 0.8 + rand() * 0.6,
      tint: { h: p.h + rand() * 0.02, s: p.s, l: p.l + rand() * 0.06 },
    };
  });
  // 反射に映す必要はない
  mesh.layers.set(1);
  return mesh;
}

export function createVegetation() {
  const group = new THREE.Group();
  group.add(createConifers());
  group.add(createBroadleaves());
  group.add(createRocks());
  group.add(createFlowers());
  return group;
}
