import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { WATER_LEVEL, terrainHeight } from './terrain.js';
import { mulberry32, fbm } from './noise.js';
import { grassBladeTexture } from './textures.js';

// プレイヤー周辺のタイルにだけ草を生やす動的グラスフィールド。
// 16m 四方のタイル単位で生成・破棄し、近距離タイルは高密度・遠距離は低密度の 2 段 LOD。
// 1 インスタンス = 1 株（クランプ）。傾き・向き・高さを乱した複数ブレードの束で、
// 「均一に直立する草」ではなく実物の草地の絡み・乱れを出す。3 変種を振り分ける。

const TILE_SIZE = 16;
const VIEW_TILES = 8;     // 視界半径（タイル数）≒ 128m
const NEAR_TILES = 4;     // この距離までは高密度
const CLUMPS_NEAR = 1150;
const CLUMPS_FAR = 400;
const BUILDS_PER_FRAME = 3;
const BLADE_HEIGHT = 0.7;

function createBladeGeometry(width, curl) {
  // 先細り + 先端が反り返るブレード。中央列を持つ 2x4 分割で、
  // 先端の尖りと縦フォールド（浅い V 字断面）を作る
  const geometry = new THREE.PlaneGeometry(width, BLADE_HEIGHT, 2, 4);
  geometry.translate(0, BLADE_HEIGHT / 2, 0);
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) / BLADE_HEIGHT;
    const x = pos.getX(i);
    // 先細り（最上段は一点に収束 = 尖頭）
    pos.setX(i, t >= 0.999 ? 0 : x * (1 - t * 0.85));
    // 反り + 中央列を手前に出すフォールドで厚みの錯覚
    const fold = (1 - Math.abs(x) / (width / 2 + 1e-6)) * width * 0.18;
    pos.setZ(i, pos.getZ(i) + t * t * curl + fold * (1 - t));
  }
  // 法線を上向きに揃えて、地面と同じ陰影で馴染ませる
  const normals = geometry.attributes.normal;
  for (let i = 0; i < normals.count; i++) normals.setXYZ(i, 0, 1, 0);
  return geometry;
}

// 株ジオメトリ: 細いブレード 5〜7 本を、ヨー・傾き・高さ・位置を乱してマージ。
// 頂点カラーに「根元の暗さ × ブレードごとの色（緑/枯れ）」を焼き込む
function createClumpGeometry(seed) {
  const r = mulberry32(seed);
  const blades = [];
  const count = 5 + Math.floor(r() * 3);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const width = 0.06 + r() * 0.08;
    const curl = 0.1 + r() * 0.25;
    const g = createBladeGeometry(width, curl);
    // 傾き: 大半は 0〜30°、1 本は大きく倒れかける（〜65°）
    const tilt = i === 0 ? 0.7 + r() * 0.45 : r() * 0.5;
    e.set(tilt, r() * Math.PI * 2, 0, 'YXZ');
    q.setFromEuler(e);
    p.set((r() - 0.5) * 0.12, 0, (r() - 0.5) * 0.12);
    const h = 0.55 + r() * 0.75;
    s.set(1, h, 1);
    m.compose(p, q, s);
    g.applyMatrix4(m);

    // ブレードの色: 大半は白（インスタンスカラーの緑がそのまま乗る）、
    // 1〜2 割は枯れ色（黄褐色）を焼き込んで色の現実感を出す
    const dry = r() < 0.09;
    const tintR = dry ? 1.15 : 0.95 + r() * 0.1;
    const tintG = dry ? 1.0 : 1.0;
    const tintB = dry ? 0.55 : 0.85 + r() * 0.15;
    const pos = g.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    for (let j = 0; j < pos.count; j++) {
      // 根元を強めに暗くして接地感（変換後の y を株の高さで正規化）
      const t = Math.min(1, Math.max(0, pos.getY(j) / (BLADE_HEIGHT * h)));
      const v = 0.3 + t * 0.8;
      colors[j * 3] = v * tintR;
      colors[j * 3 + 1] = v * tintG;
      colors[j * 3 + 2] = v * tintB;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    blades.push(g);
  }
  return BufferGeometryUtils.mergeGeometries(blades);
}

function createGrassMaterial(uniforms) {
  // Phong で弱い艶を持たせ、風で揺れたとき穂が鈍く光る
  const material = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
    vertexColors: true,
    map: grassBladeTexture(),
    alphaTest: 0.4,
    specular: new THREE.Color(0x1a2412),
    shininess: 18,
  });
  material.reflectivity = 0; // scene.environment の映り込みで白飛びさせない

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uSunDir = uniforms.uSunDir;
    shader.uniforms.uSunColor = uniforms.uSunColor;
    shader.uniforms.uPlayerPos = uniforms.uPlayerPos;

    // 風。インスタンス変換後のワールド座標で曲げることで、
    // ブレードの向きに依存しない「草原を渡る風のうねり」を作る。
    // 穂先の度合い vTip をフラグメントへ渡し、逆光透過に使う。
    shader.vertexShader =
      'uniform float uTime;\nuniform vec2 uPlayerPos;\nvarying float vTip;\n' +
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
          // プレイヤーの踏み分け: 足元の草を外側へ押し倒す
          vec2 pd = w - uPlayerPos;
          float pl = length(pd);
          float push = (1.0 - smoothstep(0.25, 1.1, pl)) * bend; // 逆順 smoothstep は GLSL 仕様で未定義
          mvPosition.xz += (pd / max(pl, 0.001)) * push * 0.45;
          mvPosition.y -= push * 0.3;
        }
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`
      );

    // 薄板透過の近似（Barré-Brisebois & Bouchard, GDC 2011）。
    // 透過ローブを法線（上向き）で歪ませ、上からの光が下へ抜ける挙動を再現。
    // 穂先ほど薄いので vTip で強める。
    shader.fragmentShader =
      'uniform vec3 uSunDir;\nuniform vec3 uSunColor;\nvarying float vTip;\n' +
      shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `vec3 sunView = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
        vec3 viewDir = normalize(vViewPosition);
        vec3 transH = normalize(sunView + normal * 0.4);
        float trans = pow(clamp(dot(viewDir, -transH), 0.0, 1.0), 3.0);
        outgoingLight += uSunColor * vec3(0.55, 1.0, 0.4) * trans * vTip * 0.7;
        #include <opaque_fragment>`
      );
  };
  return material;
}

export function createGrassField(uniforms) {
  const group = new THREE.Group();
  group.name = 'grass';
  // 株ジオメトリ 3 変種（シードを変えて構成を変える）
  const geometries = [101, 202, 303].map(createClumpGeometry);
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
    const clumps = lod === 0 ? CLUMPS_NEAR : CLUMPS_FAR;
    // 変種ごとにインスタンスを振り分ける
    const itemsByShape = geometries.map(() => []);
    for (let i = 0; i < clumps; i++) {
      const x = (ix + rand()) * TILE_SIZE;
      const z = (iz + rand()) * TILE_SIZE;
      const h = terrainHeight(x, z);
      if (h < WATER_LEVEL + 1.2 || h > 30) continue;
      // 草の生え方にムラをつける
      if (fbm(x * 0.015 + 50, z * 0.015 + 80, 2) < 0.33) continue;
      const shape = Math.floor(rand() * geometries.length);
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
        // 彩度を抑えた自然な草色。大きなパッチで明度・色相が移ろい、乾いた黄味が混ざる
        const patch = fbm(p.x * 0.012, p.z * 0.012, 2, 3);
        color.setHSL(
          0.17 + patch * 0.07 + p.r * 0.03,
          0.32 + p.s * 0.16,
          0.3 + patch * 0.18 + p.t * 0.06
        );
        mesh.setColorAt(i, color);
      });
      mesh.instanceColor.needsUpdate = true;
      mesh.frustumCulled = true;
      // 木陰では草も暗くなる（影を受けないと木陰だけ草が浮いて見える）
      mesh.receiveShadow = true;
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
