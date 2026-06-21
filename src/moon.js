import * as THREE from 'three';

// ============================================================================
// 位相再現の月。球体を「実際の太陽方向」で陰影付けすることで満ち欠けが自動的に正しくなる。
// 地球照（暗部の淡い青）・procedural なクレーター/海・Bloom 連動の発光・地平線ヘイズ。
// カメラ追従（遠方）・地平線下で非表示・layer 0 なので水面反射にも映る。
// ============================================================================

const MOON_DISTANCE = 1000; // 水反射カメラ far(1200) 未満
const MOON_RADIUS = 14.0; // 視半径 ≈ atan(14/1000) ≈ 0.8°（視認性のため実物の約1.5倍）

const VERT = /* glsl */ `
varying vec3 vNormalW;
varying vec3 vWorldPos;
varying vec3 vObj;
void main() {
  vObj = position;
  vNormalW = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform vec3 uSunDir;       // 太陽のワールド方向（位相を決める）
uniform vec3 uCameraPos;
uniform vec3 uMoonAlbedo;
uniform float uEarthshine;  // 新月に近いほど強い
uniform float uBrightness;
uniform float uHorizonY;    // 月の高度 sin（地平線ヘイズ用）
uniform vec3 uHazeColor;
uniform float uOpacity;
varying vec3 vNormalW;
varying vec3 vWorldPos;
varying vec3 vObj;

// --- 3D 値ノイズ（クレーター/海の模様用）---
float hash13(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i + vec3(0,0,0)), hash13(i + vec3(1,0,0)), f.x),
        mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
        mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}
float fbm(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}

void main() {
  vec3 N = normalize(vNormalW);
  vec3 L = normalize(uSunDir);
  vec3 V = normalize(uCameraPos - vWorldPos);
  float ndl = dot(N, L);

  // 表面アルベド: 大きな「海」(暗) と高地(明) + 微小クレーター
  vec3 sp = normalize(vObj);
  float mare = smoothstep(0.45, 0.62, fbm(sp * 2.3 + 11.0));     // 暗い海
  float craters = fbm(sp * 9.0) * 0.5 + fbm(sp * 22.0) * 0.5;     // 細かい起伏
  vec3 albedo = mix(uMoonAlbedo, uMoonAlbedo * 0.55, mare);
  albedo *= 0.82 + 0.36 * craters;

  // クレーターの微小法線（勾配近似）でターミネータに陰影
  float e = 0.04;
  float c0 = fbm(sp * 9.0);
  float cx = fbm((sp + vec3(e, 0.0, 0.0)) * 9.0);
  float cy = fbm((sp + vec3(0.0, e, 0.0)) * 9.0);
  // クレーターは控えめのバンプ（明暗境界＝ターミネータをギザつかせない）
  vec3 bump = normalize(N + vec3(c0 - cx, c0 - cy, 0.0) * 0.45);
  // ターミネータは幾何法線で滑らかに決め、バンプは陰影の微変化のみ
  float term = smoothstep(-0.02, 0.10, ndl);        // 0=夜側 1=昼側
  float lit = max(dot(bump, L), 0.0) * term;

  vec3 col = albedo * lit * uBrightness;

  // 地球照（暗部のごく淡い光。暗部が「灰色の球」に見えないよう大幅に弱く）
  float darkSide = smoothstep(0.05, -0.6, ndl);
  col += vec3(0.08, 0.12, 0.24) * uEarthshine * darkSide * albedo;

  // 縁のごく淡い発光（強すぎると Bloom でぼやけるので控えめ）
  float rim = pow(1.0 - max(dot(N, V), 0.0), 4.0);
  col += albedo * rim * 0.05 * max(ndl, 0.0);

  // 地平線ヘイズ（低空でくすませる）
  float hf = smoothstep(0.0, 0.22, uHorizonY);
  col = mix(uHazeColor * (0.3 + 0.7 * max(ndl, 0.0)), col, hf);

  gl_FragColor = vec4(max(col, 0.0), uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createMoon(scene) {
  const geometry = new THREE.SphereGeometry(MOON_RADIUS, 48, 32);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uCameraPos: { value: new THREE.Vector3() },
      uMoonAlbedo: { value: new THREE.Color(0.86, 0.85, 0.80) },
      uEarthshine: { value: 0.2 },
      uBrightness: { value: 1.7 },
      uHorizonY: { value: 1.0 },
      uHazeColor: { value: new THREE.Color(0.5, 0.42, 0.38) },
      uOpacity: { value: 1.0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true, // 地形に隠れる
    fog: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'moon';
  mesh.layers.set(0); // 水面反射に映す
  mesh.renderOrder = 1;
  mesh.frustumCulled = false;
  scene.add(mesh);

  const _pos = new THREE.Vector3();

  function update(camera, sunDir, moonDir, illum) {
    const altSin = moonDir.y;
    // 地平線下では非表示
    mesh.visible = altSin > Math.sin((-3 * Math.PI) / 180);
    if (!mesh.visible) return;

    _pos.copy(camera.position).addScaledVector(moonDir, MOON_DISTANCE);
    mesh.position.copy(_pos);
    mesh.lookAt(camera.position); // 常に同じ面（潮汐固定の見え方）

    const u = material.uniforms;
    u.uSunDir.value.copy(sunDir);
    u.uCameraPos.value.copy(camera.position);
    u.uHorizonY.value = altSin;
    u.uEarthshine.value = (1.0 - illum) * 0.04; // 暗部は夜空に溶け込む程度（新月側でのみ淡く現れる）
    u.uOpacity.value = THREE.MathUtils.smoothstep(altSin, Math.sin((-2 * Math.PI) / 180), Math.sin((4 * Math.PI) / 180));
  }

  function dispose() {
    geometry.dispose();
    material.dispose();
  }

  return { mesh, material, update, dispose };
}
