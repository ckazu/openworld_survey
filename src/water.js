import * as THREE from 'three';
import { Water } from 'three/addons/objects/Water.js';
import { WORLD_SIZE, WATER_LEVEL, terrainHeight } from './terrain.js';
import { tileableFbm } from './noise.js';

// three の Water（平面リフレクション）を使った反射する水面。
// 法線マップは外部画像に頼らず、タイル化可能ノイズから生成する。

function generateWaterNormals(size = 256) {
  const period = 10;
  const heights = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      heights[y * size + x] = tileableFbm((x / size) * period, (y / size) * period, period, 4, 42);
    }
  }

  const data = new Uint8Array(size * size * 4);
  const strength = 3.0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xp = (x + 1) % size;
      const xm = (x - 1 + size) % size;
      const yp = (y + 1) % size;
      const ym = (y - 1 + size) % size;
      const dx = (heights[y * size + xp] - heights[y * size + xm]) * strength;
      const dy = (heights[yp * size + x] - heights[ym * size + x]) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * size + x) * 4;
      data[i] = (-dx * inv * 0.5 + 0.5) * 255;
      data[i + 1] = (-dy * inv * 0.5 + 0.5) * 255;
      data[i + 2] = inv * 255;
      data[i + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

// 湖周辺の「水面からの高さ」をテクスチャに焼く（ショアマスク）。
// フォームシェーダはこれを引いて水際・浅瀬を判定する
const SHORE_AREA = 500; // 湖を覆う焼き込み範囲（m）
const SHORE_CENTER = { x: -150, z: 120 }; // terrain.js の LAKE と同じ中心
const SHORE_RANGE = 8; // 高さの符号化レンジ（±m）

function bakeShoreMask(size = 256) {
  const data = new Uint8Array(size * size * 4);
  for (let iz = 0; iz < size; iz++) {
    for (let ix = 0; ix < size; ix++) {
      const x = SHORE_CENTER.x + (ix / (size - 1) - 0.5) * SHORE_AREA;
      const z = SHORE_CENTER.z + (iz / (size - 1) - 0.5) * SHORE_AREA;
      const h = terrainHeight(x, z) - WATER_LEVEL; // 負 = 水中
      const v = Math.max(0, Math.min(255, ((h + SHORE_RANGE) / (SHORE_RANGE * 2)) * 255));
      const i = (iz * size + ix) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// 岸へ寄せる波頭と水際の泡を描く透明プレーン
function createShoreFoam(uniforms) {
  const geometry = new THREE.PlaneGeometry(SHORE_AREA, SHORE_AREA);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: uniforms.uTime,
      uShore: { value: bakeShoreMask() },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec2 vWorld;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform float uTime;
      uniform sampler2D uShore;
      varying vec2 vUv;
      varying vec2 vWorld;
      float fhash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
      float fnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(fhash(i), fhash(i + vec2(1.0, 0.0)), f.x),
          mix(fhash(i + vec2(0.0, 1.0)), fhash(i + vec2(1.0, 1.0)), f.x),
          f.y
        );
      }
      void main() {
        // ショアマスクから水面基準の高さを復元（負 = 水中）
        float h = (texture2D(uShore, vUv).r - 0.5) * ${(SHORE_RANGE * 2).toFixed(1)};
        if (h > 0.05) discard; // 陸の上には描かない

        float depth = -h; // 水深
        // 水際の泡（細い縁）。ノイズで縁を揺らす
        float edgeWobble = fnoise(vWorld * 1.7 + uTime * 0.15) * 0.15;
        float edge = smoothstep(0.28 + edgeWobble, 0.03, depth);
        // 浅瀬を岸へゆっくり進む波頭（深さの等高線を時間で押し出す）
        float shallow = smoothstep(2.2, 0.3, depth);
        float front = sin(depth * 5.0 - uTime * 0.7 + fnoise(vWorld * 0.35) * 2.2) * 0.5 + 0.5;
        float wave = smoothstep(0.88, 0.99, front) * shallow;
        // 細かい泡の粒で塗りを割る
        float sparkle = 0.45 + 0.55 * fnoise(vWorld * 6.0 + uTime * 0.4);
        float a = clamp(edge * 0.7 + wave * 0.35, 0.0, 1.0) * sparkle;
        if (a < 0.01) discard;
        gl_FragColor = vec4(vec3(0.93, 0.96, 0.97), a * 0.6);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(SHORE_CENTER.x, WATER_LEVEL + 0.03, SHORE_CENTER.z);
  mesh.renderOrder = 1; // 水面の後に重ねる
  // 反射に映す必要はない
  mesh.layers.set(1);
  return mesh;
}

export function createWater(sunDirection, uniforms) {
  const group = new THREE.Group();
  const geometry = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE);

  const water = new Water(geometry, {
    textureWidth: 1024,
    textureHeight: 1024,
    waterNormals: generateWaterNormals(),
    sunDirection: sunDirection.clone(),
    sunColor: 0xfff0dd,
    waterColor: 0x15718e,
    distortionScale: 2.4,
    alpha: 0.96,
    fog: true,
  });

  water.rotation.x = -Math.PI / 2;
  water.position.y = WATER_LEVEL;
  water.name = 'water';

  // 波紋のスケールをワールドサイズに合わせて細かくする
  water.material.uniforms.size.value = 6.0;
  water.material.transparent = true;

  group.add(water);
  group.add(createShoreFoam(uniforms));

  group.userData.update = (time) => {
    water.material.uniforms.time.value = time * 0.5;
  };

  return group;
}
