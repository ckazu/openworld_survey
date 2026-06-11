import * as THREE from 'three';
import { WATER_LEVEL, terrainHeight } from './terrain.js';
import { mulberry32, fbm } from './noise.js';

// プレイヤー周辺のタイルにだけ草を生やす動的グラスフィールド。
// 16m 四方のタイル単位で生成・破棄し、近距離タイルは高密度・遠距離は低密度の 2 段 LOD。
// 1 タイル内で 3 種のブレード形状を別 InstancedMesh に振り分けて多様性を出す。

const TILE_SIZE = 16;
const VIEW_TILES = 8;     // 視界半径（タイル数）≒ 128m
const NEAR_TILES = 4;     // この距離までは高密度
const BLADES_NEAR = 2200;
const BLADES_FAR = 650;
const BUILDS_PER_FRAME = 3;
const BLADE_HEIGHT = 0.7;

// 幅と反りの異なる 3 種のブレード。高さ基準は共通（BLADE_HEIGHT）に揃え、
// 風シェーダの穂先計算（position.y / BLADE_HEIGHT）が全形状で成立するようにする。
const BLADE_SHAPES = [
  { width: 0.10, curl: 0.30 }, // 細く反りの強い草
  { width: 0.16, curl: 0.22 }, // 標準
  { width: 0.26, curl: 0.12 }, // 幅広で立った草
];

function createBladeGeometry({ width, curl }) {
  // 先細り + 先端が反り返る 1 枚ブレード
  const geometry = new THREE.PlaneGeometry(width, BLADE_HEIGHT, 1, 4);
  geometry.translate(0, BLADE_HEIGHT / 2, 0);
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) / BLADE_HEIGHT;
    pos.setX(i, pos.getX(i) * (1 - t * 0.85));
    pos.setZ(i, pos.getZ(i) + t * t * curl); // 反り
  }
  // 法線を上向きに揃えて、地面と同じ陰影で馴染ませる
  const normals = geometry.attributes.normal;
  for (let i = 0; i < normals.count; i++) normals.setXYZ(i, 0, 1, 0);
  // 根元を暗く、穂先を明るくするグラデーション
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) / BLADE_HEIGHT;
    const v = 0.55 + t * 0.55;
    colors[i * 3] = v;
    colors[i * 3 + 1] = v;
    colors[i * 3 + 2] = v;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function createGrassMaterial(uniforms) {
  const material = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
    vertexColors: true,
  });
  material.reflectivity = 0; // scene.environment の映り込みで白飛びさせない

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uSunDir = uniforms.uSunDir;
    shader.uniforms.uSunColor = uniforms.uSunColor;

    // 風。インスタンス変換後のワールド座標で曲げることで、
    // ブレードの向きに依存しない「草原を渡る風のうねり」を作る。
    // 穂先の度合い vTip をフラグメントへ渡し、逆光透過に使う。
    shader.vertexShader =
      'uniform float uTime;\nvarying float vTip;\n' +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        `vec4 mvPosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
        #endif
        {
          float tip = clamp(position.y / ${BLADE_HEIGHT.toFixed(2)}, 0.0, 1.0);
          vTip = tip;
          float bend = tip * tip;
          vec2 w = mvPosition.xz;
          float gust = sin(uTime * 1.4 + w.x * 0.06 + w.y * 0.045)
                     + sin(uTime * 2.3 + w.x * 0.16 - w.y * 0.11) * 0.5;
          float flutter = sin(uTime * 5.0 + w.x * 1.7 + w.y * 1.3) * 0.10;
          mvPosition.xz += vec2(0.912, 0.41) * (gust * 0.16 + flutter) * bend;
        }
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`
      );

    // サブサーフェス透過: カメラが太陽を向く逆光のとき、薄い葉を光が透ける。
    // 穂先ほど薄いので vTip で強める。
    shader.fragmentShader =
      'uniform vec3 uSunDir;\nuniform vec3 uSunColor;\nvarying float vTip;\n' +
      shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `vec3 sunView = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
        vec3 viewDir = normalize(vViewPosition);
        float trans = pow(max(dot(-viewDir, sunView), 0.0), 3.0);
        outgoingLight += uSunColor * vec3(0.55, 1.0, 0.4) * trans * vTip * 0.65;
        #include <opaque_fragment>`
      );
  };
  return material;
}

export function createGrassField(uniforms) {
  const group = new THREE.Group();
  group.name = 'grass';
  const geometries = BLADE_SHAPES.map(createBladeGeometry);
  const material = createGrassMaterial(uniforms);

  const tiles = new Map(); // "ix,iz" -> { meshes: InstancedMesh[], lod: 0 | 1 }
  const buildQueue = [];
  const queued = new Set();
  let lastCx = Infinity;
  let lastCz = Infinity;

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scaleV = new THREE.Vector3();
  const color = new THREE.Color();

  function buildTile(ix, iz, lod) {
    const rand = mulberry32(ix * 73856093 ^ iz * 19349663 ^ 0x9e3779b9);
    const blades = lod === 0 ? BLADES_NEAR : BLADES_FAR;
    // 形状ごとにインスタンスを振り分ける
    const itemsByShape = BLADE_SHAPES.map(() => []);
    for (let i = 0; i < blades; i++) {
      const x = (ix + rand()) * TILE_SIZE;
      const z = (iz + rand()) * TILE_SIZE;
      const h = terrainHeight(x, z);
      if (h < WATER_LEVEL + 1.2 || h > 30) continue;
      // 草の生え方にムラをつける
      if (fbm(x * 0.015 + 50, z * 0.015 + 80, 2) < 0.33) continue;
      const shape = Math.floor(rand() * BLADE_SHAPES.length);
      itemsByShape[shape].push({ x, z, h, r: rand(), s: rand(), t: rand() });
    }

    const meshes = [];
    itemsByShape.forEach((items, s) => {
      if (items.length === 0) return;
      const mesh = new THREE.InstancedMesh(geometries[s], material, items.length);
      items.forEach((p, i) => {
        position.set(p.x, p.h - 0.04, p.z);
        euler.set((p.t - 0.5) * 0.35, p.r * Math.PI * 2, 0);
        quaternion.setFromEuler(euler);
        // 幅は据え置き、高さだけ個体差をつけて密度感を出す
        scaleV.set(0.7 + p.s * 0.75, 0.7 + p.s * 0.9, 0.7 + p.s * 0.75);
        matrix.compose(position, quaternion, scaleV);
        mesh.setMatrixAt(i, matrix);
        // 黄緑寄りの暖かいパレット。大きなパッチで明度・色相が移ろう
        const patch = fbm(p.x * 0.012, p.z * 0.012, 2, 3);
        color.setHSL(
          0.2 + patch * 0.06 + p.r * 0.03,
          0.48 + p.s * 0.2,
          0.28 + patch * 0.22 + p.t * 0.06
        );
        mesh.setColorAt(i, color);
      });
      mesh.instanceColor.needsUpdate = true;
      mesh.frustumCulled = true;
      // レイヤー 1 = 水面反射に映さないオブジェクト（反射描画を節約）
      mesh.layers.set(1);
      meshes.push(mesh);
    });

    return meshes.length > 0 ? meshes : null;
  }

  function disposeTile(key) {
    const tile = tiles.get(key);
    if (tile?.meshes) {
      for (const mesh of tile.meshes) {
        group.remove(mesh);
        mesh.dispose(); // インスタンスバッファのみ。geometry/material は共有
      }
    }
    tiles.delete(key);
  }

  function update(playerPos) {
    const cx = Math.floor(playerPos.x / TILE_SIZE);
    const cz = Math.floor(playerPos.z / TILE_SIZE);

    if (cx !== lastCx || cz !== lastCz) {
      lastCx = cx;
      lastCz = cz;

      // 必要なタイルをキューに積む。LOD が変わったタイルは作り直す
      for (let dx = -VIEW_TILES; dx <= VIEW_TILES; dx++) {
        for (let dz = -VIEW_TILES; dz <= VIEW_TILES; dz++) {
          const d2 = dx * dx + dz * dz;
          if (d2 > VIEW_TILES * VIEW_TILES) continue;
          const lod = d2 <= NEAR_TILES * NEAR_TILES ? 0 : 1;
          const key = `${cx + dx},${cz + dz}`;
          const existing = tiles.get(key);
          if ((!existing || existing.lod !== lod) && !queued.has(key)) {
            queued.add(key);
            buildQueue.push([cx + dx, cz + dz, key, lod]);
          }
        }
      }

      // 視界から外れたタイルを破棄
      const limit = (VIEW_TILES + 2) * (VIEW_TILES + 2);
      for (const key of [...tiles.keys()]) {
        const [ix, iz] = key.split(',').map(Number);
        const ddx = ix - cx;
        const ddz = iz - cz;
        if (ddx * ddx + ddz * ddz > limit) disposeTile(key);
      }
    }

    // フレームあたりの生成数を制限してヒッチを防ぐ
    let built = 0;
    while (buildQueue.length > 0 && built < BUILDS_PER_FRAME) {
      const [ix, iz, key, lod] = buildQueue.shift();
      queued.delete(key);
      const existing = tiles.get(key);
      if (existing) {
        if (existing.lod === lod) continue;
        disposeTile(key); // LOD 変更による作り直し
      }
      const meshes = buildTile(ix, iz, lod);
      tiles.set(key, { meshes, lod });
      if (meshes) for (const mesh of meshes) group.add(mesh);
      built++;
    }
  }

  return { group, update };
}
