import * as THREE from 'three';
import { mulberry32 } from './noise.js';
import { fall } from './celestial.js';

// ============================================================================
// 星空＋天の川。天球（半径 1100/1120）に手続き的な星と天の川を配置し、
// 天の極を緯度の高さに傾け（tiltGroup）、恒星時で回転（spinGroup）させる。
// これにより星は東から昇り西に沈み、緯度で見え方が変わる（周極星も自然に出る）。
// ※星の配置は手続き的生成（回転・極の挙動は天文的に正確、実在星座の再現ではない）。
// 夜にフェードイン。layer 0 なので水面反射にも映る。
// ============================================================================

const STAR_RADIUS = 1100; // 水反射カメラ far(1200) 未満
const MW_RADIUS = 1120;
const STAR_COUNT = 3000;
const DEG = Math.PI / 180;

const STAR_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;
attribute vec3 aColor;
uniform float uPixelRatio;
uniform float uTime;
varying vec3 vColor;
varying float vTwinkle;
void main() {
  vColor = aColor;
  // 控えめで星ごとにばらけた瞬き。明るい星ほど瞬きを抑えてチラつきを防ぐ
  float twSpd = 0.7 + 1.3 * fract(aPhase * 0.318);
  float twAmp = mix(0.15, 0.05, clamp(aSize / 3.0, 0.0, 1.0));
  vTwinkle = (1.0 - twAmp) + twAmp * sin(uTime * twSpd + aPhase);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uPixelRatio;
}
`;

const STAR_FRAG = /* glsl */ `
precision highp float;
uniform float uNightFade;
varying vec3 vColor;
varying float vTwinkle;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  if (r > 0.5) discard;
  float core = smoothstep(0.5, 0.06, r);    // 芯を締めて点を細かく（ボケ・ハロー抑制）
  float glow = pow(core, 7.0);
  vec3 col = vColor * (glow * 2.8 + core * 0.03) * vTwinkle * uNightFade;
  gl_FragColor = vec4(col, 1.0);            // 加算合成なので alpha は使わない
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const MW_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const MW_FRAG = /* glsl */ `
precision highp float;
uniform float uNightFade;
uniform float uTime;
varying vec3 vDir;
float hash13(vec3 p){ p=fract(p*0.3183099+0.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float vnoise(vec3 x){
  vec3 i=floor(x), f=fract(x); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(hash13(i+vec3(0,0,0)),hash13(i+vec3(1,0,0)),f.x),
                 mix(hash13(i+vec3(0,1,0)),hash13(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash13(i+vec3(0,0,1)),hash13(i+vec3(1,0,1)),f.x),
                 mix(hash13(i+vec3(0,1,1)),hash13(i+vec3(1,1,1)),f.x),f.y), f.z);
}
float fbm(vec3 p){ float s=0.0,a=0.5; for(int i=0;i<5;i++){s+=a*vnoise(p);p*=2.07;a*=0.5;} return s; }
void main() {
  vec3 d = normalize(vDir);
  // 天の川の帯（銀河面の極を固定の単位ベクトルに）
  vec3 gPole = normalize(vec3(0.36, 0.62, -0.70));
  float band = abs(dot(d, gPole));
  float belt = exp(-band * band * 40.0);           // 大円沿いに細く集中
  // 雲状のムラ（ダスト）
  float dust = fbm(d * 6.0 + 3.0) * 0.6 + fbm(d * 16.0) * 0.4;
  float bright = belt * belt * (0.3 + 0.95 * dust); // 縁を強く絞る
  // 暗黒帯（コントラストを強めてムラのある見た目に）
  bright *= 0.3 + 0.7 * smoothstep(0.32, 0.78, fbm(d * 10.0 + 9.0));
  vec3 col = mix(vec3(0.55, 0.62, 0.85), vec3(0.95, 0.92, 0.85), dust) * bright;
  gl_FragColor = vec4(col * uNightFade * 0.05, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function buildStars() {
  const rng = mulberry32(0x5eed51);
  const positions = new Float32Array(STAR_COUNT * 3);
  const colors = new Float32Array(STAR_COUNT * 3);
  const sizes = new Float32Array(STAR_COUNT);
  const phases = new Float32Array(STAR_COUNT);
  const tmp = new THREE.Color();
  for (let i = 0; i < STAR_COUNT; i++) {
    // 天球上の一様分布（赤経 RA・赤緯 Dec）。+Y = 天の北極
    const ra = rng() * Math.PI * 2;
    const sinDec = rng() * 2 - 1;
    const cosDec = Math.sqrt(Math.max(0, 1 - sinDec * sinDec));
    positions[i * 3] = STAR_RADIUS * cosDec * Math.sin(ra);
    positions[i * 3 + 1] = STAR_RADIUS * sinDec;
    positions[i * 3 + 2] = STAR_RADIUS * cosDec * Math.cos(ra);
    // 等級分布（暗い星が多い、稀に明るい星）
    const b = 0.25 + 1.5 * Math.pow(rng(), 5.0);
    sizes[i] = 0.55 + b * 0.85; // 肉眼に近い細かい点に（小さめ）
    // 色温度（橙〜白〜青白）
    const t = rng();
    if (t < 0.5) tmp.setRGB(1.0, 0.86, 0.72, THREE.LinearSRGBColorSpace); // 暖
    else if (t < 0.85) tmp.setRGB(1.0, 0.98, 0.95, THREE.LinearSRGBColorSpace); // 白
    else tmp.setRGB(0.74, 0.82, 1.0, THREE.LinearSRGBColorSpace); // 青白
    colors[i * 3] = tmp.r * b;
    colors[i * 3 + 1] = tmp.g * b;
    colors[i * 3 + 2] = tmp.b * b;
    phases[i] = rng() * Math.PI * 2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  g.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  return g;
}

export function createStarField({ latitudeDeg = 35.68, pixelRatio = 1 } = {}) {
  const group = new THREE.Group(); // = tiltGroup（位置=カメラ、傾き=緯度）
  group.name = 'stars';
  const spinGroup = new THREE.Group(); // 恒星時で回転
  group.add(spinGroup);

  const starMat = new THREE.ShaderMaterial({
    uniforms: {
      uPixelRatio: { value: pixelRatio },
      uTime: { value: 0 },
      uNightFade: { value: 0 },
    },
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
  const stars = new THREE.Points(buildStars(), starMat);
  stars.renderOrder = 3;
  stars.frustumCulled = false;
  spinGroup.add(stars);

  const mwMat = new THREE.ShaderMaterial({
    uniforms: { uNightFade: { value: 0 }, uTime: { value: 0 } },
    vertexShader: MW_VERT,
    fragmentShader: MW_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: THREE.BackSide,
    fog: false,
  });
  const milkyWay = new THREE.Mesh(new THREE.SphereGeometry(MW_RADIUS, 48, 32), mwMat);
  milkyWay.renderOrder = 2;
  milkyWay.frustumCulled = false;
  spinGroup.add(milkyWay);

  function update(latDeg, lstDeg, sunDirY, time) {
    group.rotation.x = -(Math.PI / 2 - latDeg * DEG); // 天の極を緯度の高さへ
    spinGroup.rotation.y = -lstDeg * DEG; // 恒星時で回転
    const fade = fall(sunDirY, Math.sin(-2 * DEG), Math.sin(-12 * DEG)); // 薄明で消える
    starMat.uniforms.uNightFade.value = fade;
    mwMat.uniforms.uNightFade.value = fade;
    starMat.uniforms.uTime.value = time;
  }

  return { group, update };
}
