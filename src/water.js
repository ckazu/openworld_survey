import * as THREE from 'three';
import { WATER_LEVEL, LAKE } from './terrain.js';
import { terrainHeight } from './terrain.js';
import { tileableFbm } from './noise.js';

// ============================================================================
// EXTREME-REALISM カスタム水面（three r0.184, WebGLRenderer）
//
// three の Water アドオン（平面反射のみ）を置き換える自前のメッシュ。構成:
//   - Gerstner 波で実際にうねるジオメトリ + 解析法線（VS）
//   - 真の平面反射 RT（カメラをミラー + Lengyel 斜めクリップで水面下を除外）
//   - 真の屈折 RT（depthTexture 付き。水面上を除外）→ 深度差から水深を復元
//   - Schlick フレネルで反射↔屈折をブレンド
//   - 波長依存の吸収（Beer-Lambert）で「水の厚み」と色（砂→翠→深い青緑）
//   - 海底へのコースティクス、太陽のきらめき（Bloom で光る）、波頭のサブサーフェス散乱
//   - 既存の岸の泡を波高に連動させてアップグレード
//
// 設計の詳細は docs/water-blueprint.md を参照。
// ============================================================================

// ---- 定数 ----
const WATER_SPAN = 540;     // 湖（直径260m）+ 対岸を覆う面の一辺(m)
const WATER_SEG = 512;      // 540/512 ≈ 1.05m/quad
const SHORE_AREA = 500;     // ショアマスクの焼き込み範囲(m)（既存仕様を踏襲）
const SHORE_RANGE = 8;      // 高さの符号化レンジ ±m
const SHORE_CENTER = LAKE;  // 湖の中心（terrain.js と共有）
const RT_CAP = 1536;        // RT 解像度の上限（VRAM/負荷の歯止め）
const RT_SCALE = 0.5;       // RT は描画バッファの 0.5x
const CLIP_BIAS = 0.003;    // 斜めクリップのバイアス（水際の z-fight 回避, 平面定数に適用）
const TIME_SCALE = 0.5;     // 旧 Water の time*0.5 と同じ「凪」のテンポ
const LAKE_MAX_PATH = LAKE.depth + 2.0; // 光路長クランプの上限(=11.0)

// Gerstner 波バンク（ΣQ=0.62 < 1 → ループ/ピンチなし）。dir は単位 XZ。
const WAVES = [
  new THREE.Vector4(0.800, 0.600, 0.090, 18.0), // 風向の長い波
  new THREE.Vector4(0.985, 0.174, 0.060, 11.0),
  new THREE.Vector4(0.515, 0.857, 0.038, 7.0),
  new THREE.Vector4(0.927, 0.375, 0.022, 4.2),
  new THREE.Vector4(0.469, 0.883, 0.013, 2.6), // 細かいさざ波
];
const WAVE_Q = [0.18, 0.16, 0.13, 0.09, 0.06];

// ---- タイル化可能な法線 + きらめき用ノイズ（外部画像に頼らず生成）----
function generateWaterNormals(size = 256) {
  const period = 10;
  const heights = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      heights[y * size + x] =
        tileableFbm((x / size) * period, (y / size) * period, period, 4, 42) * 0.68 +
        tileableFbm((x / size) * period * 3, (y / size) * period * 3, period * 3, 3, 87) * 0.32;
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
      // 別周波のノイズを alpha に焼き、きらめきの瞬き（twinkle）に使う
      data[i + 3] =
        tileableFbm((x / size) * period * 5, (y / size) * period * 5, period * 5, 2, 13) * 255;
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

// ---- ショアマスク（湖周辺の「水面からの高さ」を焼く）----
function bakeShoreMask(size = 512) {
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

// frame-0（RT 未描画）でも黒くならないための 1x1 ニュートラル（暗いリニア teal）
function neutralTexture() {
  const t = new THREE.DataTexture(new Uint8Array([12, 28, 38, 255]), 1, 1, THREE.RGBAFormat);
  t.colorSpace = THREE.LinearSRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

// ============================================================================
// 反射 + 屈折 RT の管理（onBeforeRender で自走）
// ============================================================================
class WaterRT {
  constructor(mesh, foam) {
    this.mesh = mesh;
    this.foam = foam;
    this._rendering = false;
    this._allocated = false;
    this._renderer = null;

    this.reflectionRT = null;
    this.refractionRT = null;

    this._reflCam = new THREE.PerspectiveCamera();
    this._refrCam = new THREE.PerspectiveCamera();
    this._refrCam.matrixAutoUpdate = false;

    this._reflTexMatrix = new THREE.Matrix4();
    this._meshWorld = mesh.matrixWorld; // 静的（matrixAutoUpdate=false 前提）

    // スクラッチ
    this._waterWorldPos = new THREE.Vector3(LAKE.x, WATER_LEVEL, LAKE.z);
    this._normal = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._rot = new THREE.Matrix4();
    this._plane = new THREE.Plane();
    this._clipPlane = new THREE.Vector4();
    this._q = new THREE.Vector4();

    this._onResize = () => this.setSize();
  }

  _clampRT(n) {
    return Math.min(Math.max(1, Math.floor(n)), RT_CAP);
  }

  ensure(renderer) {
    if (this._allocated) return;
    this._renderer = renderer;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = this._clampRT(size.width * RT_SCALE);
    const h = this._clampRT(size.height * RT_SCALE);

    this.reflectionRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, samples: 4, depthBuffer: true, stencilBuffer: false,
    });
    this.reflectionRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.reflectionRT.texture.minFilter = THREE.LinearFilter;
    this.reflectionRT.texture.magFilter = THREE.LinearFilter;

    // 屈折 RT。水深は静的バシメトリ（ショアマスク）から取るため depthTexture は不要。
    // MSAA を効かせて水底のエッジを滑らかに
    this.refractionRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, samples: 4, depthBuffer: true, stencilBuffer: false,
    });
    this.refractionRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.refractionRT.texture.minFilter = THREE.LinearFilter;
    this.refractionRT.texture.magFilter = THREE.LinearFilter;

    const u = this.mesh.material.uniforms;
    u.tReflect.value = this.reflectionRT.texture;
    u.tRefract.value = this.refractionRT.texture;
    // gl_FragCoord は composer RT（フル描画バッファ）基準。screenUV を [0,1] にするには
    // RT(0.5x) ではなくフル解像度で割る
    u.uResolution.value.set(size.width, size.height);

    window.addEventListener('resize', this._onResize);
    this._allocated = true;
  }

  setSize() {
    if (!this._allocated || !this._renderer) return;
    const size = this._renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = this._clampRT(size.width * RT_SCALE);
    const h = this._clampRT(size.height * RT_SCALE);
    this.reflectionRT.setSize(w, h);
    this.refractionRT.setSize(w, h); // depthTexture も追従
    this.mesh.material.uniforms.uResolution.value.set(size.width, size.height);
  }

  update(renderer, scene, camera) {
    if (this._rendering) return;                      // 再入ガード
    if (camera.userData.isWaterRT === true) return;   // ネストカメラ保険
    this.ensure(renderer);
    this._rendering = true;

    const prevRT = renderer.getRenderTarget();        // = composer の HDR RT。null にしない
    const prevCubeFace = renderer.getActiveCubeFace();
    const prevMip = renderer.getActiveMipmapLevel();
    const prevXr = renderer.xr.enabled;
    const prevShadow = renderer.shadowMap.autoUpdate;

    renderer.xr.enabled = false;
    renderer.shadowMap.autoUpdate = false;

    // 水面と泡を両パスから隠す（自己反射/自己屈折を防ぐ）
    this.mesh.visible = false;
    this.foam.visible = false;

    // ===== PASS 1: 反射 =====
    this._buildReflectionCamera(camera);
    this._reflCam.far = Math.min(camera.far, 1200); // 3km の山を全コストで映さない
    this._reflCam.updateProjectionMatrix();          // far 変更 → 斜めクリップ前に proj 再構築
    this._applyObliqueClip(this._reflCam, +1);       // +Y: 水面下を除外
    this._updateReflTexMatrix(this._reflCam);
    this._reflCam.layers.set(0);                     // layer0 のみ（草/花=1 と水を除外）
    this._reflCam.userData.isWaterRT = true;

    renderer.setRenderTarget(this.reflectionRT);
    renderer.state.buffers.depth.setMask(true);
    if (renderer.autoClear === false) renderer.clear();
    renderer.render(scene, this._reflCam);

    // ===== PASS 2: 屈折（depthTexture も自動で埋まる）=====
    this._buildRefractionCamera(camera);
    this._applyObliqueClip(this._refrCam, -1);       // -Y: 水面上を除外（水底のみ残す）
    this._refrCam.layers.set(0);
    this._refrCam.userData.isWaterRT = true;

    renderer.setRenderTarget(this.refractionRT);
    renderer.state.buffers.depth.setMask(true);
    if (renderer.autoClear === false) renderer.clear();
    renderer.render(scene, this._refrCam);

    // ===== 状態復元 =====
    renderer.setRenderTarget(prevRT, prevCubeFace, prevMip);
    renderer.xr.enabled = prevXr;
    renderer.shadowMap.autoUpdate = prevShadow;
    if (camera.viewport !== undefined) renderer.state.viewport(camera.viewport);

    // ===== uniform 反映 =====
    const u = this.mesh.material.uniforms;
    u.uReflectMatrix.value.copy(this._reflTexMatrix);
    u.uCameraPos.value.copy(camera.position);

    this.mesh.visible = true;
    this.foam.visible = true;
    this._rendering = false;
  }

  _buildReflectionCamera(camera) {
    const c = this._reflCam;
    const wp = this._waterWorldPos;
    const n = this._normal.set(0, 1, 0);

    const camPos = this._camPos.setFromMatrixPosition(camera.matrixWorld);
    const view = this._v1.subVectors(wp, camPos);
    view.reflect(n).negate().add(wp);
    c.position.copy(view);

    const rot = this._rot.extractRotation(camera.matrixWorld);
    const lookAt = this._v2.set(0, 0, -1).applyMatrix4(rot).add(camPos);
    const target = this._v3.subVectors(wp, lookAt);
    target.reflect(n).negate().add(wp);

    c.up.set(0, 1, 0).applyMatrix4(rot).reflect(n);
    c.lookAt(target);
    c.aspect = camera.aspect;
    c.fov = camera.fov;
    c.near = camera.near;
    // far は呼び出し側、updateProjectionMatrix も呼び出し側
    c.updateMatrixWorld();
  }

  _buildRefractionCamera(camera) {
    const c = this._refrCam;
    c.matrixWorld.copy(camera.matrixWorld);
    c.matrixWorldInverse.copy(c.matrixWorld).invert();
    c.projectionMatrix.copy(camera.projectionMatrix);
    c.far = camera.far;
  }

  // Lengyel の斜め近接クリップ。sign=+1 反射(水面下を除外) / -1 屈折(水面上を除外)
  _applyObliqueClip(rtCam, sign) {
    const wp = this._waterWorldPos;
    const n = this._normal.set(0, sign, 0);
    const plane = this._plane.setFromNormalAndCoplanarPoint(n, wp);
    // バイアスは「平面定数」に入れる（proj[10] を傾けるとクリップ面が傾き、遠方で隙間が育つ）
    plane.constant += CLIP_BIAS;
    plane.applyMatrix4(rtCam.matrixWorldInverse);

    const cp = this._clipPlane.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const P = rtCam.projectionMatrix;
    const q = this._q;
    q.x = (Math.sign(cp.x) + P.elements[8]) / P.elements[0];
    q.y = (Math.sign(cp.y) + P.elements[9]) / P.elements[5];
    q.z = -1.0;
    q.w = (1.0 + P.elements[10]) / P.elements[14];
    cp.multiplyScalar(2.0 / cp.dot(q));
    P.elements[2] = cp.x;
    P.elements[6] = cp.y;
    P.elements[10] = cp.z + 1.0;
    P.elements[14] = cp.w;
  }

  // 反射の投影 UV 行列（Reflector 流。x,y,w は斜めクリップの影響を受けない第0/1/3行）
  _updateReflTexMatrix(c) {
    this._reflTexMatrix.set(
      0.5, 0.0, 0.0, 0.5,
      0.0, 0.5, 0.0, 0.5,
      0.0, 0.0, 0.5, 0.5,
      0.0, 0.0, 0.0, 1.0
    );
    this._reflTexMatrix.multiply(c.projectionMatrix);
    this._reflTexMatrix.multiply(c.matrixWorldInverse);
    this._reflTexMatrix.multiply(this._meshWorld);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    if (this.reflectionRT) this.reflectionRT.dispose();
    if (this.refractionRT) {
      if (this.refractionRT.depthTexture) this.refractionRT.depthTexture.dispose();
      this.refractionRT.dispose();
    }
  }
}

// ============================================================================
// シェーダ
// ============================================================================
const VERT = /* glsl */ `
#define NWAVES 5
uniform vec4 uWaves[NWAVES];
uniform float uWaveQ[NWAVES];
uniform float uTime, uChoppyScale;
uniform sampler2D uShore;
uniform vec4 uShoreParams;
uniform mat4 uReflectMatrix;
const float G = 9.81;

#include <fog_pars_vertex>

varying vec3 vWorldPos;
varying vec3 vNormalGeom;
varying float vWaveHeight;
varying vec4 vReflectCoord;
varying float vBottomDepth;

// ショアマスクから振幅減衰 + 浅瀬の波頭立ち（shoaling）。bottomDepth(>0=水中) を返す
float shoreAmp(vec2 P, out float bottomDepth) {
  vec2 suv = (P - uShoreParams.xy) / uShoreParams.z;
  if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) { bottomDepth = 8.0; return 1.0; }
  float h = (texture2D(uShore, suv).r - 0.5) * uShoreParams.w; // 符号付き高さ(m)
  bottomDepth = max(0.0, -h);
  float damp = smoothstep(0.05, 1.5, bottomDepth);
  float shoal = 1.0 + 0.35 * (smoothstep(1.5, 3.0, bottomDepth) * (1.0 - smoothstep(3.0, 5.0, bottomDepth)));
  return damp * shoal;
}

void main() {
  vec3 world0 = (modelMatrix * vec4(position, 1.0)).xyz;
  vec2 P = world0.xz;
  float bottomDepth;
  float ampScale = shoreAmp(P, bottomDepth);
  vBottomDepth = bottomDepth;

  vec3 disp = vec3(0.0);
  vec3 T = vec3(0.0, 0.0, 1.0); // +Z 接線
  vec3 B = vec3(1.0, 0.0, 0.0); // +X 従法線
  for (int i = 0; i < NWAVES; i++) {
    vec2 D = normalize(uWaves[i].xy);
    float A = uWaves[i].z * ampScale;
    float L = uWaves[i].w;
    float k = 6.28318530718 / L;
    float w = sqrt(G * k);               // ω のみ。TIME_SCALE は uTime に畳み込み済み
    float Q = uWaveQ[i] * uChoppyScale;
    float ph = k * dot(D, P) + w * uTime;
    float S = sin(ph), C = cos(ph);
    disp.x += Q * A * D.x * C;
    disp.z += Q * A * D.y * C;
    disp.y += A * S;
    float kA = k * A;
    B.x -= Q * D.x * D.x * kA * S; B.z -= Q * D.x * D.y * kA * S; B.y += D.x * kA * C;
    T.x -= Q * D.x * D.y * kA * S; T.z -= Q * D.y * D.y * kA * S; T.y += D.y * kA * C;
  }

  vec3 worldPos = world0 + disp;
  vWorldPos = worldPos;
  vNormalGeom = normalize(cross(T, B) + vec3(0.0, 1e-4, 0.0)); // normalize(0) ガード
  vWaveHeight = disp.y;

  vec4 mvPosition = viewMatrix * vec4(worldPos, 1.0); // 名前は mvPosition 固定（パッチ fog_vertex 用）
  vReflectCoord = uReflectMatrix * vec4(position, 1.0); // 未変位のローカル位置で投影

  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>

uniform sampler2D tReflect, tRefract, uDetailNormals, uFoamNoise;
uniform float uTime;
uniform vec2 uResolution;
uniform vec3 uCameraPos, uSunDir, uSunColor;

uniform float uNormalStrength, uMicroStrength, uFlatNear, uFlatFar, uFlatMax;
uniform float uBaseRough, uRoughPerMeter;
uniform float uReflDistort; uniform vec3 uSkyTint, uHorizonSky;
uniform float uRefrDistort, uMaxPath, uLakeMaxPath; uniform vec3 uWaterBodyColor;
uniform vec3 uCausticTint;
uniform float uCausticScale, uCausticSpeed, uCausticStrength, uCausticChroma, uCausticDepthMax, uCausticRidge, uCausticGain;
uniform float uSheenPower, uSheenStrength, uGlintPower, uGlintGate, uGlintStrength;
uniform vec3 uScatterColor; uniform float uScatterStrength, uScatterPower, uScatterDistort;
uniform float uFoamStart; uniform vec3 uFoamColor;

varying vec3 vWorldPos;
varying vec3 vNormalGeom;
varying float vWaveHeight;
varying vec4 vReflectCoord;
varying float vBottomDepth;

// ---- 詳細法線オクターブ + RNM ブレンド ----
vec2 detailSlope(vec2 worldXZ, float scale, vec2 vel) {
  vec2 uv = worldXZ / scale + vel * uTime / scale;
  return texture2D(uDetailNormals, uv).xy * 2.0 - 1.0;
}
vec3 rnmBlend(vec3 b, vec3 d) {
  vec3 t = b + vec3(0.0, 1.0, 0.0);
  vec3 u = d * vec3(-1.0, 1.0, -1.0);
  return normalize(t * dot(t, u) / max(t.y, 1e-3) - u);
}

// ---- コースティクス（リッジ値ノイズ・クロマ分離）----
float cnHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float cNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0); // quintic（noise.js の smooth と一致）
  return mix(mix(cnHash(i), cnHash(i + vec2(1.0, 0.0)), f.x),
             mix(cnHash(i + vec2(0.0, 1.0)), cnHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float causticField(vec2 wxz, float t) {
  vec2 a = wxz * uCausticScale;
  vec2 flow = vec2(cNoise(a * 0.5 + t * 0.07), cNoise(a * 0.5 - t * 0.06)) - 0.5;
  vec2 p = a + flow * 1.6;
  float n1 = cNoise(p + vec2(t, t * 0.8) * uCausticSpeed);
  float n2 = cNoise(p * 1.93 + 5.2 + vec2(-t * 0.9, t) * uCausticSpeed);
  float r1 = 1.0 - abs(n1 * 2.0 - 1.0);
  float r2 = 1.0 - abs(n2 * 2.0 - 1.0);
  return pow(r1 * r2, uCausticRidge) * uCausticGain;
}
vec3 causticRGB(vec2 wxz, float t) {
  vec2 o = vec2(uCausticChroma, 0.0);
  return vec3(causticField(wxz + o.xy, t), causticField(wxz, t), causticField(wxz - o.xy, t));
}

void main() {
  vec3 V = normalize(uCameraPos - vWorldPos);
  float dist = length(uCameraPos - vWorldPos);
  vec2 P = vWorldPos.xz;
  vec2 screenUV = gl_FragCoord.xy / uResolution;

  float depthWater = max(vBottomDepth, 0.0);
  float shoreFade = smoothstep(0.0, 1.2, depthWater);

  // ---- (1) 法線合成（マクロ + 3 オクターブ詳細, RNM）----
  vec3 N = normalize(vNormalGeom);
  vec2 s  = detailSlope(P, 9.00, vec2( 0.80,  0.60) * 0.18) * 1.00;
  s      += detailSlope(P, 3.30, vec2(-0.50,  0.85) * 0.55) * 0.55;
  s      += detailSlope(P, 1.15, vec2( 0.30, -0.95) * 1.40) * 0.30;
  float detStr = uNormalStrength * smoothstep(0.05, 0.8, depthWater);
  vec3 nDetail = normalize(vec3(-s.x * detStr, 1.0, -s.y * detStr));
  N = rnmBlend(N, nDetail);

  // ---- (2) 距離フラット化（ちらつき防止）+ mip フェード ----
  float nFlat = smoothstep(uFlatNear, uFlatFar, dist);
  N = normalize(mix(N, vec3(0.0, 1.0, 0.0), nFlat * uFlatMax));
  vec2 rc = P * 0.85;
  float footprint = max(length(dFdx(rc)), length(dFdy(rc)));
  float mipFade = 1.0 - smoothstep(0.5, 2.0, footprint);
  float ld = (1.0 - nFlat) * mipFade;
  float NdotV = clamp(dot(N, V), 1e-3, 1.0);

  // ---- (3) Schlick フレネル（F0=0.02, グレージング anti-shimmer）----
  float F0 = 0.02;
  float rough = clamp(uBaseRough + dist * uRoughPerMeter, 0.0, 0.35);
  float F90 = clamp(1.0 - rough * 2.2, 0.0, 1.0);
  float F = clamp(F0 + (F90 - F0) * pow(1.0 - NdotV, 5.0), 0.0, 1.0);

  // ---- (4) 反射（投影 + 法線歪み, 負 w ガード）----
  float reflW = max(vReflectCoord.w, 1e-4);
  vec2 reflUV = vReflectCoord.xy / reflW;
  float distScale = 1.0 / (1.0 + dist * 0.02);
  reflUV += N.xz * uReflDistort * distScale * mix(0.25, 0.6, shoreFade);
  bool reflValid = (vReflectCoord.w > 1e-4) &&
                   reflUV.x > -0.05 && reflUV.x < 1.05 && reflUV.y > -0.05 && reflUV.y < 1.05;
  reflUV = clamp(reflUV, 0.002, 0.998);
  vec3 reflCol = texture2D(tReflect, reflUV).rgb;
  reflCol = mix(reflCol, reflCol * uSkyTint, 0.12);
  float horizonFade = smoothstep(0.97, 1.0, reflUV.y);
  reflCol = mix(reflCol, uHorizonSky, horizonFade);
  reflCol = mix(uHorizonSky, reflCol, reflValid ? 1.0 : 0.0);

  // ---- (5) 屈折サンプル + 水柱 ----
  // 水深はショアマスク（静的バシメトリ=正確）から取る。斜めクリップで歪む深度テクスチャの
  // 線形化には依存しない。屈折カラーは正しい screenUV で水底をサンプルする
  vec2 refrDistort = N.xz * uRefrDistort * smoothstep(0.0, 3.0, depthWater);
  vec2 refrUV = clamp(screenUV + refrDistort, 0.002, 0.998);
  vec3 bottomCol = texture2D(tRefract, refrUV).rgb;
  float colDepth = min(depthWater, uLakeMaxPath);             // 垂直水深
  float pathLen = min(colDepth / max(NdotV, 0.25), uMaxPath); // 視線方向の光路長

  // ---- (6) コースティクス（吸収前。水底≒水面直下に近似アンカー）----
  vec2 causP = P;
  float cDepth = (1.0 - smoothstep(0.0, uCausticDepthMax, colDepth)) * smoothstep(0.04, 0.5, colDepth);
  // 低い太陽でも水底の光網が見えるよう、仰角への依存を緩める（物理より演出寄り）
  float sunVis = smoothstep(0.0, 0.22, uSunDir.y);
  vec3 caust = causticRGB(causP, uTime) * uCausticTint * (uCausticStrength * cDepth * sunVis) * ld;
  bottomCol += bottomCol * caust * uSunColor;

  // ---- (7) Beer-Lambert 吸収 + 水体内散乱 + 砂棚 ----
  const vec3 SIGMA = vec3(0.45, 0.085, 0.045); // R は B の約10倍速く減衰
  vec3 absorb = exp(-SIGMA * pathLen);
  vec3 transmitted = bottomCol * absorb + uWaterBodyColor * (1.0 - absorb);
  const vec3 shallowSand = vec3(0.62, 0.55, 0.38);
  float sandMix = 1.0 - smoothstep(0.0, 1.0, colDepth);
  transmitted = mix(transmitted, bottomCol * shallowSand + uWaterBodyColor * 0.05, sandMix * 0.6);

  // ---- (8) 誘電体ベース ----
  vec3 col = mix(transmitted, reflCol, F);

  // ---- (9) 太陽スペキュラ + きらめき（HDR → Bloom）----
  vec3 L = normalize(uSunDir);
  vec3 H = normalize(L + V);
  float NdotL = max(dot(N, L), 0.0);
  float NdotH = max(dot(N, H), 0.0);
  vec3 sheen = uSunColor * pow(NdotH, uSheenPower) * uSheenStrength * NdotL;
  float sunElev = clamp(uSunDir.y, 0.0, 1.0);
  float lowSun = smoothstep(0.05, 0.45, sunElev); // 低い太陽では「光の道」になりがち→抑制
  vec2 mbump = (texture2D(uDetailNormals, P * 1.15 + uTime * vec2(0.30, -0.95) * 1.40).xy * 2.0 - 1.0);
  vec3 Nmicro = normalize(N + vec3(mbump.x, 0.0, mbump.y) * uMicroStrength);
  float glitSharp = mix(64.0, uGlintPower, ld);
  float glint = pow(max(dot(Nmicro, H), 0.0), glitSharp);
  float twinkle = texture2D(uDetailNormals, P * 2.3 + uTime * 0.6).a;
  float gateLo = mix(uGlintGate + 0.30, uGlintGate, lowSun);
  float gate = smoothstep(gateLo, 1.0, glint * (0.5 + 0.6 * twinkle));
  float glintMag = uGlintStrength * mix(0.45, 1.0, lowSun);
  vec3 glitter = uSunColor * gate * glintMag * step(0.0, NdotL) * shoreFade * ld;
  col += sheen + glitter;

  // ---- (10) サブサーフェス散乱（逆光の波頭グロー）----
  vec3 Hs = normalize(L + N * uScatterDistort);
  float back = pow(clamp(dot(V, -Hs), 0.0, 1.0), uScatterPower);
  float crest = smoothstep(0.25, 1.0, clamp(vWaveHeight / 0.09, 0.0, 1.0));
  col += uScatterColor * uSunColor * back * crest * uScatterStrength * mix(0.4, 1.0, shoreFade);

  // ---- (11) 波頭 + 水際の泡 ----
  // 凪の湖では波頭の泡はごく稀。合成振幅 ampMax≈0.22 で正規化し、最上位の波頭だけ・控えめに
  float foamN = texture2D(uFoamNoise, P * 0.3 + uTime * 0.05).r;
  float crestN = clamp(vWaveHeight / 0.22, 0.0, 1.0);
  float crestFoam = smoothstep(uFoamStart, 1.0, crestN) * foamN * 0.25;
  float rim = 1.0 - smoothstep(0.04, 0.35, colDepth);
  float foam = clamp(max(crestFoam, rim * 0.8 * foamN), 0.0, 1.0);
  col = mix(col, uFoamColor, foam);

  // ---- (12) 安全（有限・非負。上限はクランプしない=HDR を Bloom へ）----
  col = max(col, vec3(0.0));

  // ---- (13) アルファ（柔らかい水際）----
  float alpha = mix(0.6, 1.0, smoothstep(0.0, 0.6, colDepth));
  alpha = max(alpha, foam);

  gl_FragColor = vec4(col, alpha);

  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function makeWaterMaterial(sharedUniforms, shoreTex, detailTex, neutral) {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 }, // 専用クロック。NEVER sharedUniforms.uTime（*0.5 が草へ漏れる）
      uChoppyScale: { value: 1.0 },
      uWaves: { value: WAVES.map((w) => w.clone()) },
      uWaveQ: { value: WAVE_Q.slice() },
      uShore: { value: shoreTex },
      uShoreParams: {
        value: new THREE.Vector4(
          SHORE_CENTER.x - SHORE_AREA / 2,
          SHORE_CENTER.z - SHORE_AREA / 2,
          SHORE_AREA,
          SHORE_RANGE * 2
        ),
      },
      uReflectMatrix: { value: new THREE.Matrix4() },
      tReflect: { value: neutral },
      tRefract: { value: neutral },
      uDetailNormals: { value: detailTex },
      uFoamNoise: { value: detailTex },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uCameraPos: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3() },
      uSunColor: { value: new THREE.Color(0xffc587) },
      // 法線
      uNormalStrength: { value: 0.65 },
      uMicroStrength: { value: 1.6 },
      uFlatNear: { value: 25.0 },
      uFlatFar: { value: 220.0 },
      uFlatMax: { value: 0.8 },
      // フレネル
      uBaseRough: { value: 0.02 },
      uRoughPerMeter: { value: 0.0016 },
      // 反射
      uReflDistort: { value: 0.045 },
      uSkyTint: { value: new THREE.Vector3(0.78, 0.85, 1.0) },
      uHorizonSky: { value: new THREE.Vector3(0.62, 0.70, 0.86) },
      // 屈折/吸収
      uRefrDistort: { value: 0.06 },
      uMaxPath: { value: 14.0 },
      uLakeMaxPath: { value: LAKE_MAX_PATH },
      uWaterBodyColor: { value: new THREE.Vector3(0.012, 0.115, 0.105) },
      // コースティクス
      uCausticTint: { value: new THREE.Vector3(0.55, 0.85, 1.0) },
      uCausticScale: { value: 0.85 },
      uCausticSpeed: { value: 0.13 },
      uCausticStrength: { value: 1.35 },
      uCausticChroma: { value: 0.018 },
      uCausticDepthMax: { value: 4.5 },
      uCausticRidge: { value: 3.5 },
      uCausticGain: { value: 1.5 },
      // スペキュラ/きらめき
      uSheenPower: { value: 120.0 },
      uSheenStrength: { value: 1.2 },
      uGlintPower: { value: 900.0 },
      uGlintGate: { value: 0.55 },
      uGlintStrength: { value: 6.0 },
      // 散乱
      uScatterColor: { value: new THREE.Vector3(0.18, 0.55, 0.42) },
      uScatterStrength: { value: 1.3 },
      uScatterPower: { value: 3.0 },
      uScatterDistort: { value: 0.5 },
      // 泡
      uFoamStart: { value: 0.6 },
      uFoamColor: { value: new THREE.Vector3(0.92, 0.94, 0.95) },
    },
  ]);

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: true,
    side: THREE.FrontSide,
    fog: true,
  });
  material.extensions = { derivatives: true }; // dFdx/dFdy

  // 共有 uniform は参照でエイリアス（main.js の毎フレーム更新を伝播）。uTime は絶対に共有しない
  material.uniforms.uSunDir = sharedUniforms.uSunDir;
  material.uniforms.uSunColor = sharedUniforms.uSunColor;

  return material;
}

function makeWaterGeometry() {
  const geometry = new THREE.PlaneGeometry(WATER_SPAN, WATER_SPAN, WATER_SEG, WATER_SEG);
  geometry.rotateX(-Math.PI / 2);
  const r = Math.hypot(WATER_SPAN / 2, WATER_SPAN / 2) + 0.5;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), r);
  return geometry;
}

// ---- 岸の波頭と水際の泡（波高に連動・フォグ対応にアップグレード）----
function createShoreFoam(shoreTex) {
  const geometry = new THREE.PlaneGeometry(SHORE_AREA, SHORE_AREA);
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uShore: { value: shoreTex },
      uWaves: { value: WAVES.map((w) => w.clone()) },
      uWaveQ: { value: WAVE_Q.slice() },
    },
  ]);
  const material = new THREE.ShaderMaterial({
    uniforms,
    fog: true,
    vertexShader: /* glsl */ `
      #define NWAVES 5
      #include <fog_pars_vertex>
      varying vec2 vUv;
      varying vec2 vWorld;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #define NWAVES 5
      #include <common>
      #include <fog_pars_fragment>
      uniform float uTime;
      uniform sampler2D uShore;
      uniform vec4 uWaves[NWAVES];
      uniform float uWaveQ[NWAVES];
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
      // 高さのみの Gerstner 和（波頭で水際線が前後する）
      float waveHeight(vec2 P) {
        float h = 0.0;
        for (int i = 0; i < NWAVES; i++) {
          vec2 D = normalize(uWaves[i].xy);
          float k = 6.28318530718 / uWaves[i].w;
          float w = sqrt(9.81 * k);
          h += uWaves[i].z * sin(k * dot(D, P) + w * uTime);
        }
        return h;
      }
      void main() {
        float h = (texture2D(uShore, vUv).r - 0.5) * ${(SHORE_RANGE * 2).toFixed(1)};
        if (h > 0.05) discard;
        float depth = -h;
        float wob = fnoise(vWorld * 1.7 + uTime * 0.15) * 0.15;
        float effDepth = depth + waveHeight(vWorld) * 0.4; // 波で水際を上下させる
        float edge = 1.0 - smoothstep(0.02, 0.30 + wob, abs(effDepth));
        float shallow = 1.0 - smoothstep(0.3, 2.2, depth);
        float front = sin(depth * 5.0 - uTime * 0.7 + fnoise(vWorld * 0.35) * 2.2) * 0.5 + 0.5;
        float wave = smoothstep(0.88, 0.99, front) * shallow;
        float sparkle = 0.45 + 0.55 * fnoise(vWorld * 6.0 + uTime * 0.4);
        float a = clamp(edge * 0.7 + wave * 0.35, 0.0, 1.0) * sparkle;
        if (a < 0.01) discard;
        gl_FragColor = vec4(vec3(0.93, 0.96, 0.97), a * 0.6);
        #include <fog_fragment>
      }`,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(SHORE_CENTER.x, WATER_LEVEL + 0.03, SHORE_CENTER.z);
  mesh.renderOrder = 1;
  mesh.layers.set(1); // 反射には映さない
  return mesh;
}

export function createWater(sunDirection, sharedUniforms) {
  const group = new THREE.Group();
  const shoreTex = bakeShoreMask(512);
  const detailTex = generateWaterNormals();
  const neutral = neutralTexture();

  const material = makeWaterMaterial(sharedUniforms, shoreTex, detailTex, neutral);
  material.uniforms.uSunDir.value.copy(sunDirection);

  const geometry = makeWaterGeometry();
  const waterMesh = new THREE.Mesh(geometry, material);
  waterMesh.name = 'water';
  waterMesh.position.set(LAKE.x, WATER_LEVEL, LAKE.z);
  waterMesh.matrixAutoUpdate = false;
  waterMesh.updateMatrix();
  waterMesh.updateMatrixWorld(true);

  const foam = createShoreFoam(shoreTex);

  const rt = new WaterRT(waterMesh, foam);
  waterMesh.onBeforeRender = (renderer, scene, camera) => rt.update(renderer, scene, camera);

  group.add(waterMesh);
  group.add(foam);

  group.userData.update = (time) => {
    const t = time * TIME_SCALE; // 専用クロック（共有 uTime には触れない）
    waterMesh.material.uniforms.uTime.value = t;
    foam.material.uniforms.uTime.value = t;
  };
  group.userData.dispose = () => {
    rt.dispose();
    material.dispose();
    geometry.dispose();
    foam.material.dispose();
    foam.geometry.dispose();
    shoreTex.dispose();
    detailTex.dispose();
    neutral.dispose();
  };

  return group;
}
