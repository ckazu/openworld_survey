import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { WORLD_SIZE, WATER_LEVEL, terrainHeight, terrainSlope, forestDensity } from './terrain.js';
import { mulberry32, fbm } from './noise.js';
import { barkNormalMap, rockNormalMap, rockRoughnessMap, leafClusterTexture, flowerTexture } from './textures.js';

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

function standardMaterial(extra = {}) {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
    ...extra,
  });
}

// 葉用マテリアル。アルファカットアウトでベタ塗りカードを「葉の塊」に見せる。
// 逆光時は太陽光が葉を透ける（uniforms から uSunDir / uSunColor を受ける）
function leafMaterial(uniforms, extra = {}) {
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.8,
    metalness: 0,
    side: THREE.DoubleSide,
    map: leafClusterTexture(),
    alphaTest: 0.5,
    ...extra,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDir = uniforms.uSunDir;
    shader.uniforms.uSunColor = uniforms.uSunColor;
    shader.uniforms.uTime = uniforms.uTime;
    // 樹冠の風揺れ。草と同じ「風の波」をワールド座標から拾い、
    // 上の葉ほど大きく揺らす（幹元 1.8m から上に向かって増幅）
    shader.vertexShader =
      'uniform float uTime;\n' +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        `vec4 mvPosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
        #endif
        {
          float sway = clamp((position.y - 1.8) / 4.5, 0.0, 1.0);
          vec2 w = mvPosition.xz;
          float gust = sin(uTime * 0.9 + w.x * 0.05 + w.y * 0.04)
                     + sin(uTime * 1.7 + w.x * 0.13 - w.y * 0.09) * 0.5;
          float rustle = sin(uTime * 3.2 + position.x * 2.1 + position.z * 1.7) * 0.25;
          mvPosition.xz += vec2(0.912, 0.41) * (gust * 0.10 + rustle * 0.05) * sway;
        }
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`
      );
    shader.fragmentShader =
      'uniform vec3 uSunDir;\nuniform vec3 uSunColor;\n' +
      shader.fragmentShader.replace(
        // DoubleSide は裏面で法線を反転させるが、外向きに張り替えた樹冠法線が
        // 裏面で内向きになり暗い斑になる。反転させずボリューム陰影を保つ
        '#include <normal_fragment_begin>',
        '#include <normal_fragment_begin>\n normal = normalize( vNormal );'
      ).replace(
        '#include <opaque_fragment>',
        `{
          vec3 sunView = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
          vec3 viewDir = normalize(vViewPosition);
          float trans = pow(max(dot(-viewDir, sunView), 0.0), 4.0);
          outgoingLight += uSunColor * vec3(0.5, 1.0, 0.35) * trans * 0.4 * diffuseColor.rgb;
        }
        #include <opaque_fragment>`
      );
  };
  return material;
}

// 影もアルファ抜きにする（無いと葉カードが矩形の影を落とす）
function leafDepthMaterial() {
  return new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    map: leafClusterTexture(),
    alphaTest: 0.5,
  });
}

// 先端が反り返る小さな葉カード（基部が原点、上方向に伸びる）
function makeLeafCard(w, h) {
  const g = new THREE.PlaneGeometry(w, h, 1, 2);
  g.translate(0, h * 0.5, 0);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) / h;
    pos.setZ(i, pos.getZ(i) + t * t * h * 0.35);
  }
  return g;
}

// ボリューム関数 place(rnd) -> {x,y,z,scale,ao} に従い葉カードを多数ばら撒いて 1 ジオメトリにマージ。
// ブロブ（滑らかな塊）の代わりに、無数の葉が重なった樹冠を作る。
// ao（0..1、内側ほど小）は aoBake 属性に保存し、paintGradient の後で乗算する。
function createLeafCluster(count, place, card, seed) {
  const r = mulberry32(seed);
  const cards = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const o = place(r);
    const g = card.clone();
    e.set((r() - 0.5) * Math.PI * 1.2, r() * Math.PI * 2, (r() - 0.5) * Math.PI);
    q.setFromEuler(e);
    p.set(o.x, o.y, o.z);
    s.setScalar(o.scale ?? 1);
    m.compose(p, q, s);
    g.applyMatrix4(m);
    const ao = new Float32Array(g.attributes.position.count).fill(o.ao ?? 1);
    g.setAttribute('aoBake', new THREE.BufferAttribute(ao, 1));
    cards.push(g);
  }
  return BufferGeometryUtils.mergeGeometries(cards);
}

// 葉カードの法線を「樹冠中心から外向き」に張り替える。
// カードごとのフラット法線では面の向きで明暗が割れて紙くず状に見えるため、
// 樹冠全体をひとつのボリュームとして滑らかに陰影させる（実在ゲームの定番手法）。
// normalFn(x, y, z) -> THREE.Vector3（正規化不要、ここで正規化する）
function sphericalNormals(geometry, normalFn) {
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.copy(normalFn(pos.getX(i), pos.getY(i), pos.getZ(i))).normalize();
    nor.setXYZ(i, v.x, v.y, v.z);
  }
  return geometry;
}

// 樹冠の内側・下側ほど暗くする焼き込み AO（paintGradient の後に呼ぶ）
function applyBakedAO(geometry) {
  const ao = geometry.attributes.aoBake;
  const colors = geometry.attributes.color;
  if (!ao || !colors) return geometry;
  for (let i = 0; i < colors.count; i++) {
    const a = ao.getX(i);
    colors.setXYZ(i, colors.getX(i) * a, colors.getY(i) * a, colors.getZ(i) * a);
  }
  geometry.deleteAttribute('aoBake');
  return geometry;
}

// 円錐状ボリューム（針葉樹の樹冠用）。上に行くほど細る
function coneVolume(yMin, yMax, rBase) {
  return (rnd) => {
    const t = rnd();
    const y = yMin + (yMax - yMin) * t;
    const radial = 0.4 + 0.6 * Math.sqrt(rnd()); // 0.4..1（軸からの相対距離）
    const r = rBase * (1 - t * 0.92) * radial;
    const a = rnd() * Math.PI * 2;
    return {
      x: Math.cos(a) * r, y, z: Math.sin(a) * r,
      scale: 0.7 + rnd() * 0.7,
      ao: 0.62 + 0.38 * radial, // 幹に近い内側ほど陰る
    };
  };
}

// 楕円球ボリューム（広葉樹の葉塊用）。球内に一様分布
function blobVolume(cx, cy, cz, rx, ry, rz) {
  return (rnd) => {
    const theta = rnd() * Math.PI * 2;
    const phi = Math.acos(2 * rnd() - 1);
    const rr = Math.cbrt(rnd());
    return {
      x: cx + Math.sin(phi) * Math.cos(theta) * rx * rr,
      y: cy + Math.cos(phi) * ry * rr,
      z: cz + Math.sin(phi) * Math.sin(theta) * rz * rr,
      scale: 0.8 + rnd() * 0.6,
      ao: 0.62 + 0.38 * rr, // 塊の中心ほど陰る
    };
  };
}

// 幹に曲がりと根元の張り出しを与える（displace の前に呼ぶ）
function shapeTrunk(geometry, height, bendAmp, flare) {
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = Math.min(1, Math.max(0, y / height));
    // ゆるい S 字の曲がり
    const bend = Math.sin(t * Math.PI) * bendAmp;
    // 根元のフレア（下端ほど外へ広げる）
    const f = 1 + flare * Math.pow(Math.max(0, 1 - y / (height * 0.25)), 2);
    pos.setX(i, pos.getX(i) * f + bend);
    pos.setZ(i, pos.getZ(i) * f);
  }
  geometry.computeVertexNormals();
  return geometry;
}

// 幹から放射状に伸びる枝（テーパー円柱を傾けて配置しマージ）
function createBranches(specs) {
  const branches = specs.map((b) => {
    let g = BufferGeometryUtils.mergeVertices(new THREE.CylinderGeometry(b.r1, b.r0, b.len, 5));
    g.translate(0, b.len / 2, 0);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(b.pitch, b.yaw, 0));
    m.compose(new THREE.Vector3(0, b.base, 0), q, new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(m);
    return g;
  });
  return BufferGeometryUtils.mergeGeometries(branches);
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

// 配置（位置・回転・スケール・色味）を一度だけ確定させる。
// 幹と樹冠を別メッシュにしても配置がズレないよう、rand の消費をここに集約する。
function computePlacements(points, place) {
  const axisY = new THREE.Vector3(0, 1, 0);
  return points.map((p) => {
    const o = place(p);
    const quaternion = new THREE.Quaternion().setFromAxisAngle(axisY, rand() * Math.PI * 2);
    return { p, o, quaternion };
  });
}

function buildInstances(geometry, material, placements, useTint = true) {
  const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const color = new THREE.Color();

  placements.forEach(({ p, o, quaternion }, i) => {
    position.set(p.x, p.h + (o.sink ?? 0), p.z);
    scale.setScalar(o.scale);
    if (o.scaleY) scale.y = o.scale * o.scaleY;
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(i, matrix);
    if (useTint && o.tint) {
      color.setHSL(o.tint.h, o.tint.s, o.tint.l);
      mesh.setColorAt(i, color);
    }
  });
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

// 幹（樹皮法線マップ）と葉カードの樹冠を別メッシュで作り、同じ配置で重ねる
function assembleTree(trunkGeo, crownGeo, points, place, uniforms) {
  const placements = computePlacements(points, place);
  const trunkMesh = buildInstances(trunkGeo, standardMaterial({
    normalMap: barkNormalMap(),
    normalScale: new THREE.Vector2(0.5, 0.5),
    roughness: 0.9,
  }), placements, false);
  const crownMesh = buildInstances(crownGeo, leafMaterial(uniforms), placements, true);
  crownMesh.customDepthMaterial = leafDepthMaterial();
  const group = new THREE.Group();
  [trunkMesh, crownMesh].forEach((m) => {
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  });
  return group;
}

function createConifers(uniforms) {
  let trunk = BufferGeometryUtils.mergeVertices(new THREE.CylinderGeometry(0.14, 0.34, 2.6, 8, 6));
  trunk.translate(0, 1.3, 0);
  shapeTrunk(trunk, 2.6, 0.06, 0.5);
  displace(trunk, 0.04, 1.5, 11);
  paintGradient(trunk, 0x4a3826, 0x5d4630, 0, 2.6);

  // 葉カードを円錐状に密に積んで樹冠を作る（小さめ・多めで紙感を抑える）
  const card = makeLeafCard(0.42, 0.82);
  const crown = createLeafCluster(440, coneVolume(1.9, 6.4, 2.1), card, 777);
  // 円錐の軸から放射状 + やや上向きの法線で、樹冠全体を滑らかに陰影させる
  sphericalNormals(crown, (x, y, z) => new THREE.Vector3(x, 0.55, z));
  paintGradient(crown, 0x244a1e, 0x5c8f3c, 1.8, 6.2);
  applyBakedAO(crown);

  const points = scatter(1400, (x, z, h) => {
    if (h < WATER_LEVEL + 2 || h > 30) return false;
    if (terrainSlope(x, z) > 0.85) return false;
    return forestDensity(x, z) > 0.55;
  });

  return assembleTree(trunk, crown, points, () => ({
    scale: 0.8 + rand() * 1.1,
    sink: -0.15,
    tint: { h: 0.28 + rand() * 0.06, s: 0.25 + rand() * 0.2, l: 0.5 + rand() * 0.18 },
  }), uniforms);
}

function createBroadleaves(uniforms) {
  let trunk = BufferGeometryUtils.mergeVertices(new THREE.CylinderGeometry(0.18, 0.44, 3.0, 8, 6));
  trunk.translate(0, 1.5, 0);
  shapeTrunk(trunk, 3.0, 0.1, 0.55);
  // 上部から放射状に枝を分岐させる
  const branches = createBranches([
    { base: 2.5, len: 1.9, r0: 0.13, r1: 0.05, pitch: 0.7, yaw: 0.2 },
    { base: 2.7, len: 1.7, r0: 0.12, r1: 0.05, pitch: 0.8, yaw: 2.2 },
    { base: 2.4, len: 1.8, r0: 0.13, r1: 0.05, pitch: 0.75, yaw: 4.3 },
    { base: 2.9, len: 1.4, r0: 0.10, r1: 0.04, pitch: 0.5, yaw: 1.1 },
  ]);
  trunk = BufferGeometryUtils.mergeGeometries([trunk, branches]);
  displace(trunk, 0.05, 1.2, 21);
  paintGradient(trunk, 0x55432e, 0x6b5238, 0, 3.0);

  // 枝先に葉塊を広げる（小さめ・多めで紙感を抑える）
  const card = makeLeafCard(0.46, 0.62);
  const clusterSpec = [
    { x: 0, y: 4.2, z: 0, r: 2.0, n: 400, seed: 801 },
    { x: 1.5, y: 3.6, z: 0.4, r: 1.4, n: 240, seed: 802 },
    { x: -1.4, y: 3.7, z: -0.3, r: 1.3, n: 220, seed: 803 },
    { x: 0.3, y: 5.2, z: 0.5, r: 1.3, n: 210, seed: 804 },
    { x: -0.4, y: 4.8, z: 0.9, r: 1.2, n: 190, seed: 805 },
  ];
  const clusters = clusterSpec.map((s) => {
    const g = createLeafCluster(s.n, blobVolume(s.x, s.y, s.z, s.r, s.r * 0.85, s.r), card, s.seed);
    // 各葉塊の中心から外向きの法線で、塊ごとに滑らかなボリューム陰影にする
    sphericalNormals(g, (x, y, z) => new THREE.Vector3(x - s.x, y - s.y, z - s.z));
    return g;
  });
  const crown = BufferGeometryUtils.mergeGeometries(clusters);
  paintGradient(crown, 0x33591f, 0x79aa46, 2.4, 6.2);
  applyBakedAO(crown);

  // 草原にぽつぽつ生える広葉樹（森の外側）
  const points = scatter(280, (x, z, h) => {
    if (h < WATER_LEVEL + 2 || h > 26) return false;
    if (terrainSlope(x, z) > 0.7) return false;
    const f = forestDensity(x, z);
    return f > 0.35 && f < 0.55 && rand() < 0.5;
  });

  return assembleTree(trunk, crown, points, () => ({
    scale: 0.7 + rand() * 0.9,
    sink: -0.15,
    tint: { h: 0.24 + rand() * 0.08, s: 0.25 + rand() * 0.15, l: 0.5 + rand() * 0.15 },
  }), uniforms);
}

// 上向きの面に苔を、それ以外に露出岩肌を頂点カラーで塗り分ける（簡易 AO 込み）
function paintRock(geometry) {
  const moss = new THREE.Color(0x4a5a32);
  const stoneLow = new THREE.Color(0x4d473d);
  const stoneHigh = new THREE.Color(0x9a948a);
  const tmp = new THREE.Color();
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    // 高さで岩肌の明暗（下＝谷間が暗い簡易 AO）、上向き度で苔の量を決める
    const t = Math.min(1, Math.max(0, (pos.getY(i) + 1) / 2));
    tmp.lerpColors(stoneLow, stoneHigh, t);
    const up = Math.max(0, nor.getY(i));
    const mossiness = Math.pow(up, 2.5) * 0.7 * (0.5 + 0.5 * fbm(pos.getX(i) * 1.5, pos.getZ(i) * 1.5, 3, 61));
    tmp.lerp(moss, mossiness);
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function createRocks() {
  // 高 detail の正二十面体を多重スケールで変位させ、割れ目・段差・ザラつきを作る
  let geometry = BufferGeometryUtils.mergeVertices(new THREE.IcosahedronGeometry(1, 4));
  displace(geometry, 0.42, 0.8, 41);
  displace(geometry, 0.16, 2.2, 47);
  displace(geometry, 0.05, 5.2, 53);
  geometry.computeVertexNormals();
  paintRock(geometry);
  const material = standardMaterial({
    roughness: 1.0,
    normalMap: rockNormalMap(),
    roughnessMap: rockRoughnessMap(),
    normalScale: new THREE.Vector2(0.7, 0.7),
  });

  const points = scatter(180, (x, z, h) => h > WATER_LEVEL - 2 && h < 35);

  const placements = computePlacements(points, () => ({
    scale: 0.4 + rand() * 1.6,
    scaleY: 0.6 + rand() * 0.4,
    sink: -0.3,
    tint: { h: 0.1, s: 0.02 + rand() * 0.06, l: 0.45 + rand() * 0.2 },
  }));
  const mesh = buildInstances(geometry, material, placements);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function createFlowers() {
  // 細い茎 + 花弁テクスチャの上向きヘッド。十字の白い矩形をやめ、
  // 5 弁シルエットのアルファカットアウトで「花」として読めるようにする。
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
  const stemMaterial = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  stemMaterial.reflectivity = 0;

  // 上向きの花ヘッド（少し傾けて表情をつける。向きは配置のヨー回転でばらける）
  const head = new THREE.PlaneGeometry(0.16, 0.16)
    .rotateX(-Math.PI / 2 + 0.35)
    .translate(0, 0.56, 0);
  const headMaterial = new THREE.MeshLambertMaterial({
    side: THREE.DoubleSide,
    map: flowerTexture(),
    alphaTest: 0.5,
  });
  headMaterial.reflectivity = 0;

  // 開けた草原（森の外）に群生させる
  const points = scatter(9000, (x, z, h) => {
    if (h < WATER_LEVEL + 1.6 || h > 22) return false;
    if (forestDensity(x, z) > 0.5) return false;
    return terrainSlope(x, z) < 0.5;
  });

  // Bloom 閾値（0.85）を超えて白飛びしないよう明度を抑える
  const palette = [
    { h: 0.12, s: 0.85, l: 0.6 },  // 黄
    { h: 0.0, s: 0.0, l: 0.82 },   // 白
    { h: 0.9, s: 0.55, l: 0.68 },  // 桃
    { h: 0.75, s: 0.45, l: 0.64 }, // 紫
  ];
  const placements = computePlacements(points, () => {
    const p = palette[Math.floor(rand() * palette.length)];
    return {
      scale: 0.8 + rand() * 0.6,
      tint: { h: p.h + rand() * 0.02, s: p.s, l: p.l + rand() * 0.06 },
    };
  });
  const group = new THREE.Group();
  const stems = buildInstances(stem, stemMaterial, placements, false);
  const heads = buildInstances(head, headMaterial, placements, true);
  // 木陰では花も暗くする。反射に映す必要はない
  for (const m of [stems, heads]) {
    m.receiveShadow = true;
    m.layers.set(1);
  }
  group.add(stems, heads);
  return group;
}

export function createVegetation(uniforms) {
  const group = new THREE.Group();
  group.add(createConifers(uniforms));
  group.add(createBroadleaves(uniforms));
  group.add(createRocks());
  group.add(createFlowers());
  return group;
}
