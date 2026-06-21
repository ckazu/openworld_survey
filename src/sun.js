import * as THREE from 'three';

// ============================================================================
// 太陽スプライト（カメラ追従のビルボード）。
// 明るい円盤＋締まったグロウを描く。Sky アドオン側はクランプして白飛び・ドームを
// 防ぎ、太陽の「見た目」はこのスプライトで制御する（芯だけが Bloom で締まって光る）。
// depthTest=true で地形（山・木）に隠れる＝稜線からの日の出も自然。地平線下では非表示。
// ============================================================================

const SUN_DIST = 1150; // 水反射カメラ far(1200) 未満 → 湖にも映る
const SUN_SIZE = 140; // ハローの広がり（半径）。視半径 ≈ atan(140/1150) ≈ 7°

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform vec3 uCore;
uniform vec3 uGlow;
uniform float uIntensity;
varying vec2 vUv;
void main() {
  float r = length(vUv - 0.5) * 2.0; // 0=中心 .. 1=端
  if (r > 0.97) discard; // 板の縁の手前で必ず切る（クワッドの矩形が見えるのを防ぐ）
  // 太陽の見た目は「塗り」で多層に描く。Bloom には一切頼らない（小さく明るい光源で
  // UnrealBloom の最粗ミップが四角く広がるアーティファクトを根本的に避ける）。芯は AgX で
  // 白飛びするほど高輝度にして輝きを出す。日中は Bloom 閾値をこの輝度より上に設定する。
  float disk  = smoothstep(0.05, 0.008, r);           // くっきりした芯
  float inner = exp(-r * r * 26.0);                   // 内側の強いグロウ
  float outer = pow(max(0.0, 1.0 - r / 0.97), 2.6);   // 外側の広いハロー（端で確実に0）
  vec3 col = uCore * (disk * 28.0 + inner * 7.0) + uGlow * outer * 1.3;
  col *= uIntensity;
  // 線形 HDR をそのまま加算（トーンマップ/色空間は OutputPass で一括処理）
  gl_FragColor = vec4(col, 1.0);
}
`;

// 太陽高度(度)→ 芯・グロウの色（線形）。高い=白っぽい暖色、低い=橙
const CORE = [
  { a: 25, rgb: [1.0, 0.97, 0.92] }, { a: 10, rgb: [1.0, 0.9, 0.74] },
  { a: 3, rgb: [1.0, 0.74, 0.46] }, { a: 0, rgb: [1.0, 0.6, 0.34] },
];
const GLOW = [
  { a: 25, rgb: [1.0, 0.86, 0.66] }, { a: 10, rgb: [1.0, 0.74, 0.48] },
  { a: 3, rgb: [1.0, 0.56, 0.3] }, { a: 0, rgb: [1.0, 0.42, 0.2] },
];
function rampRGB(stops, a, out) {
  const n = stops.length;
  if (a >= stops[0].a) {
    const c = stops[0].rgb;
    return out.setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
  }
  if (a <= stops[n - 1].a) {
    const c = stops[n - 1].rgb;
    return out.setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
  }
  for (let i = 0; i < n - 1; i++) {
    const hi = stops[i];
    const lo = stops[i + 1];
    if (a <= hi.a && a >= lo.a) {
      const t = (a - lo.a) / (hi.a - lo.a);
      return out.setRGB(
        lo.rgb[0] + (hi.rgb[0] - lo.rgb[0]) * t,
        lo.rgb[1] + (hi.rgb[1] - lo.rgb[1]) * t,
        lo.rgb[2] + (hi.rgb[2] - lo.rgb[2]) * t,
        THREE.LinearSRGBColorSpace
      );
    }
  }
  return out;
}

export function createSun(scene) {
  const geometry = new THREE.PlaneGeometry(SUN_SIZE * 2, SUN_SIZE * 2);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uCore: { value: new THREE.Color(1, 0.97, 0.92) },
      uGlow: { value: new THREE.Color(1, 0.86, 0.66) },
      uIntensity: { value: 1 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true, // 地形（山・木）に隠れる
    fog: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'sun';
  mesh.layers.set(0);
  mesh.renderOrder = 1;
  mesh.frustumCulled = false;
  scene.add(mesh);

  const _pos = new THREE.Vector3();

  function update(camera, sunDir, sunAltDeg, cloudiness = 0) {
    // 曇天では雲に隠れて太陽円盤は見えなくなる
    const cloudFade = 1 - THREE.MathUtils.smoothstep(cloudiness, 0.35, 0.9);
    // 地平線のわずか下から消える（薄明の名残は Sky 側）。曇天で完全に隠れたら描画しない
    mesh.visible = sunDir.y > Math.sin((-1.5 * Math.PI) / 180) && cloudFade > 0.01;
    if (!mesh.visible) return;
    _pos.copy(camera.position).addScaledVector(sunDir, SUN_DIST);
    mesh.position.copy(_pos);
    mesh.lookAt(camera.position);
    rampRGB(CORE, sunAltDeg, material.uniforms.uCore.value);
    rampRGB(GLOW, sunAltDeg, material.uniforms.uGlow.value);
    // 低空ほどやや弱める（地平線の大気減衰）。曇天でフェード
    material.uniforms.uIntensity.value = (0.6 + 0.4 * THREE.MathUtils.smoothstep(sunAltDeg, 0, 12)) * cloudFade;
  }

  function dispose() {
    geometry.dispose();
    material.dispose();
  }

  return { mesh, update, dispose };
}
