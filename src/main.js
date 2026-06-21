import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { createTerrain, terrainHeight, forestDensity } from './terrain.js';
import { createWater } from './water.js';
import { createSky, applyDynamicFog } from './sky.js';
import { createVegetation } from './vegetation.js';
import { createGrassField } from './grass.js';
import { createAmbience } from './ambience.js';
import { createPlayer } from './player.js';
import { createSimClock } from './clock.js';
import { createMoon } from './moon.js';
import { createSun } from './sun.js';
import { createStarField } from './stars.js';
import { createWeather } from './weather.js';
import { createSettingsPanel } from './ui/settings.js';
import {
  sunHorizontal,
  moonHorizontal,
  moonPhase,
  localSiderealTimeDeg,
  altAzToVector,
} from './celestial.js';

const app = document.getElementById('app');
const overlay = document.getElementById('overlay');
const hud = document.getElementById('hud');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// AgX（Sobotka 2022）: ACES よりハイライトの色相を保ったまま滑らかに
// ロールオフする。夕日の飽和が「黄→白」に転ばず自然になる
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 0.95; // AgX は暗めだが、上げすぎると太陽直視で飽和域が広がる
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 3000);
// レイヤー 1 = 水面反射に映さないオブジェクト（草・花）
camera.layers.enable(1);

// 共有ユニフォーム（草の揺れアニメーション・サブサーフェス透過）
const sharedUniforms = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3() },
  uSunColor: { value: new THREE.Color(0xffc587) }, // ゴールデンアワーの暖色（sky.js と同じ）
  uPlayerPos: { value: new THREE.Vector2() }, // 草の踏み分け用（ワールド xz）
};

// シミュレーション時計（緯度経度・日時・速度倍率の単一状態源）。東京・144倍を既定に。
const simClock = createSimClock({ latitude: 35.6812, longitude: 139.7671, speedMultiplier: 144 });

const { sunDirection, fogUniforms, followPlayer, update: skyUpdate, refreshEnv } = createSky(
  scene,
  renderer,
  sharedUniforms
);
console.assert(scene.fog instanceof THREE.FogExp2, 'celestial fog requires FogExp2');

// 天候（昼夜ランプを変調する連続パラメータ。共有 uniform を各所へ参照配布する）
const weather = createWeather({ initial: 'fair', latitude: simClock.state.latitude });
const wx = weather.uniforms;
// 霧の昼の白み uniform を weather 側に一本化して全フォグマテリアルへ配る（applyDynamicFog 経由）
fogUniforms.uFogBoost = wx.uFogBoost;
fogUniforms.uFogDayColor = wx.uFogDayColor;
weather.attachPrecip(fogUniforms);

scene.add(createTerrain());
const water = createWater(sunDirection, sharedUniforms, wx);
scene.add(water);
scene.add(createVegetation(sharedUniforms, wx));
const grass = createGrassField(sharedUniforms, fogUniforms, wx);
scene.add(grass.group);
const ambience = createAmbience(wx);
scene.add(ambience.group);
scene.add(weather.group);

// 天体（layer 0 で水面反射にも映る）
const moon = createMoon(scene);
const sun = createSun(scene);
const stars = createStarField({
  latitudeDeg: simClock.state.latitude,
  pixelRatio: renderer.getPixelRatio(),
});
scene.add(stars.group);

// 動的フォグの安全パス: シーン上の全フォグマテリアルへ共有 uniform を注入。
// あわせて天候の濡れ（地面・岩・幹の暗化＋艶）も冪等注入する
scene.traverse((o) => {
  const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
  for (const m of mats) {
    applyDynamicFog(m, fogUniforms);
    weather.applyWetness(m);
  }
});

const player = createPlayer(camera, renderer.domElement);
scene.add(player.controls.object);
// 湖が見える丘の上からスタート
player.spawn(-20, 120, { x: -150, z: 120 });

const settings = createSettingsPanel({ clock: simClock, controls: player.controls, overlay, weather });
const _moonDir = new THREE.Vector3();

// ポストプロセス: ブルームで太陽の照り返し・空気感を出す
// MSAA 付きレンダーターゲットでエッジのギザつきを防ぐ
const size = renderer.getDrawingBufferSize(new THREE.Vector2());
const renderTarget = new THREE.WebGLRenderTarget(size.width, size.height, {
  samples: 4,
  type: THREE.HalfFloatType,
});
const composer = new EffectComposer(renderer, renderTarget);
composer.addPass(new RenderPass(scene, camera));

// スクリーンスペース AO（GTAO）。接地・葉の重なり・岩の窪みを暗めて立体感を強める
const gtaoPass = new GTAOPass(scene, camera, size.width, size.height);
gtaoPass.output = GTAOPass.OUTPUT.Default;
gtaoPass.updateGtaoMaterial({
  radius: 0.7,            // ワールド単位（草 0.7m・木 5m に対する遮蔽半径）
  distanceExponent: 1.0,
  thickness: 1.0,
  scale: 1.3,            // AO の濃さ
  samples: 16,
  distanceFallOff: 1.0,
  screenSpaceRadius: false,
});
gtaoPass.updatePdMaterial({
  lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 16,
});
// GTAO の法線/深度プリパスは alphaTest を考慮できず、葉カードが矩形のまま
// AO に焼かれて黒い矩形が浮く。プリパスの間だけ葉メッシュを非表示にする
// （葉ピクセルの AO は背後のジオメトリ基準になるが、矩形アーティファクトより自然）
const gtaoHidden = [];
const gtaoRender = gtaoPass.render.bind(gtaoPass);
gtaoPass.render = function (...args) {
  scene.traverse((o) => {
    if (o.userData.excludeFromGTAO && o.visible) {
      o.visible = false;
      gtaoHidden.push(o);
    }
  });
  gtaoRender(...args);
  for (const o of gtaoHidden) o.visible = true;
  gtaoHidden.length = 0;
};
composer.addPass(gtaoPass);

// radius を小さくして細かいミップ主体の Bloom にする。太陽など小さく明るい光源で
// 粗いミップが「四角く」広がるアーティファクトを防ぎ、月・星の滲みも締まる
const bloomPass = new UnrealBloomPass(new THREE.Vector2(size.width, size.height), 0.25, 0.15, 0.85);
composer.addPass(bloomPass);

// スクリーンスペース光芒（サンシャフト）。太陽のスクリーン座標へ向かう
// 放射状ブラーで、木々や雲の隙間から差す光の筋を近似する（リニアHDRで動作）
const shaftPass = new ShaderPass({
  name: 'LightShaftShader',
  uniforms: {
    tDiffuse: { value: null },
    uSunScreen: { value: new THREE.Vector2(0.5, 0.5) },
    uStrength: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uSunScreen;
    uniform float uStrength;
    varying vec2 vUv;
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      if (uStrength <= 0.001) { gl_FragColor = base; return; }
      vec2 delta = (uSunScreen - vUv) / 56.0;
      vec2 uv = vUv;
      float illum = 1.0;
      vec3 acc = vec3(0.0);
      for (int i = 0; i < 56; i++) {
        uv += delta;
        vec3 s = texture2D(tDiffuse, uv).rgb;
        float lum = dot(s, vec3(0.2126, 0.7152, 0.0722));
        // 太陽近傍の高輝度だけを拾い、遮蔽（暗い木立）で筋が生まれる
        acc += s * smoothstep(2.4, 5.5, lum) * illum;
        illum *= 0.94;
      }
      gl_FragColor = vec4(base.rgb + acc / 56.0 * uStrength, base.a);
    }
  `,
});
composer.addPass(shaftPass);

// 控えめな被写界深度（写真のレンズ感）。遠景がわずかにぼけるだけに留め、
// ゲームとしての視認性は保つ
const bokehPass = new BokehPass(scene, camera, {
  focus: 30.0,
  aperture: 0.00004,
  maxblur: 0.0018, // 遠方（月・星・山）がぼけすぎないよう控えめに
});
composer.addPass(bokehPass);

// オールドレンズ風のレンズフレア。太陽と画面中心を結ぶ軸上のゴースト列 +
// 太陽周りのハロー。太陽が樹冠に隠れているときはシェーダ内の輝度タップで減衰。
// レンズ内現象なので DOF の後・トーンマップ前に挿入する
const flarePass = new ShaderPass({
  name: 'LensFlareShader',
  uniforms: {
    tDiffuse: { value: null },
    uSunScreen: { value: new THREE.Vector2(0.5, 0.5) },
    uStrength: { value: 0 },
    uAspect: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uSunScreen;
    uniform float uStrength;
    uniform float uAspect;
    varying vec2 vUv;
    // やわらかい円ゴースト（アスペクト補正済み距離）
    float ghost(vec2 uv, vec2 pos, float size) {
      vec2 d = uv - pos;
      d.x *= uAspect;
      return pow(max(0.0, 1.0 - length(d) / size), 2.4);
    }
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      if (uStrength <= 0.001) { gl_FragColor = base; return; }
      // 太陽位置周辺の HDR 輝度をタップし、遮蔽（木立の陰）でフレアを消す
      vec3 sunArea = texture2D(tDiffuse, uSunScreen).rgb
                   + texture2D(tDiffuse, uSunScreen + vec2(0.01, 0.0)).rgb
                   + texture2D(tDiffuse, uSunScreen - vec2(0.01, 0.0)).rgb
                   + texture2D(tDiffuse, uSunScreen + vec2(0.0, 0.013)).rgb
                   + texture2D(tDiffuse, uSunScreen - vec2(0.0, 0.013)).rgb;
      float sunLum = dot(sunArea / 5.0, vec3(0.2126, 0.7152, 0.0722));
      float occl = smoothstep(0.8, 2.6, sunLum);
      if (occl <= 0.001) { gl_FragColor = base; return; }

      vec2 axis = vec2(0.5) - uSunScreen; // 太陽 → 画面中心の軸
      vec3 acc = vec3(0.0);
      // ゴースト列（位置・サイズ・色は古いコーティングの薄い色味）
      acc += vec3(1.0, 0.55, 0.25) * ghost(vUv, uSunScreen + axis * 0.45, 0.045) * 0.55;
      acc += vec3(0.35, 0.75, 0.6) * ghost(vUv, uSunScreen + axis * 0.85, 0.075) * 0.4;
      acc += vec3(0.55, 0.45, 0.85) * ghost(vUv, uSunScreen + axis * 1.25, 0.05) * 0.45;
      acc += vec3(1.0, 0.8, 0.5) * ghost(vUv, uSunScreen + axis * 1.6, 0.11) * 0.3;
      acc += vec3(0.4, 0.85, 0.8) * ghost(vUv, uSunScreen + axis * 0.2, 0.03) * 0.5;
      // 太陽周りの薄い暖色ハロー（ガウス状のリング）
      vec2 dh = vUv - uSunScreen;
      dh.x *= uAspect;
      float ring = exp(-pow((length(dh) - 0.24) * 16.0, 2.0));
      acc += vec3(1.0, 0.72, 0.45) * ring * 0.3;

      gl_FragColor = vec4(base.rgb + acc * uStrength * occl, base.a);
    }
  `,
});
composer.addPass(flarePass);
composer.addPass(new OutputPass());

// 仕上げのカラーグレーディング + レンズ効果
// （彩度・シネマトーン・ビネット・色収差・フィルムグレイン）
const gradePass = new ShaderPass({
  name: 'ColorGradeShader',
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    varying vec2 vUv;
    float grain(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime * 61.0) * 43758.5453);
    }
    void main() {
      // バレル歪曲（微量）: 古い広角レンズの樽型。端のサンプルが内側に
      // 寄る向きなので範囲外参照は起きない
      vec2 tc = vUv - 0.5;
      float r2 = dot(tc, tc);
      vec2 buv = 0.5 + tc * (1.0 - 0.05 * r2);
      // 色収差: 画面端ほど RGB をラジアルにずらす（微量）
      vec2 toCenter = buv - 0.5;
      float d = length(toCenter);
      vec2 ca = toCenter * d * d * 0.018;
      vec4 c = vec4(
        texture2D(tDiffuse, buv - ca).r,
        texture2D(tDiffuse, buv).g,
        texture2D(tDiffuse, buv + ca).b,
        1.0
      );
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(l), c.rgb, 1.24);            // AgX は彩度低めなので強めに補正
      c.rgb = (c.rgb - 0.5) * 1.1 + 0.5 + 0.003;    // 微コントラスト
      // シネマトーン: シャドウをわずかに持ち上げ、ハイライトを暖色へ
      c.rgb = c.rgb * 0.96 + 0.025;
      c.rgb *= vec3(1.03, 1.0, 0.96);
      c.rgb *= 1.0 - smoothstep(0.5, 1.0, d) * 0.24; // ビネット
      // フィルムグレイン（暗部ほど目立つ・微量）
      c.rgb += (grain(vUv) - 0.5) * 0.028 * (1.0 - l * 0.6);
      gl_FragColor = c;
    }
  `,
});
composer.addPass(gradePass);

overlay.addEventListener('click', () => player.controls.lock());
player.controls.addEventListener('lock', () => overlay.classList.add('hidden'));
player.controls.addEventListener('unlock', () => {
  if (!settings.isOpen()) overlay.classList.remove('hidden');
});

// 設定パネルの開閉（O）。入力欄でのタイプ中は無視。Esc で閉じる
window.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) {
    if (e.code === 'Escape') settings.close();
    return;
  }
  if (e.code === 'KeyO') settings.toggle();
  else if (e.code === 'Escape' && settings.isOpen()) settings.close();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  gtaoPass.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
let hudTimer = 0;

// 光芒の太陽スクリーン座標・強度を更新（背後/画面外ではフェードアウト）
const sunWorld = new THREE.Vector3();
const camForward = new THREE.Vector3();
function updateLightShafts() {
  camera.getWorldDirection(camForward);
  const facing = camForward.dot(sunDirection);
  let strength = 0;
  if (facing > 0.1 && sunDirection.y > 0.0) {
    sunWorld.copy(camera.position).addScaledVector(sunDirection, 1000).project(camera);
    shaftPass.uniforms.uSunScreen.value.set(sunWorld.x * 0.5 + 0.5, sunWorld.y * 0.5 + 0.5);
    // 画面端から外れるほど弱める
    const offX = Math.max(0, Math.abs(sunWorld.x) - 1);
    const offY = Math.max(0, Math.abs(sunWorld.y) - 1);
    const off = Math.min(1, Math.hypot(offX, offY) / 0.6);
    strength = (1 - off) * 0.09; // 太陽直視で画面全体が白飛びしないよう控えめに
  }
  shaftPass.uniforms.uStrength.value = strength;
  // レンズフレアは光芒と同じ太陽座標・強度を共有（強度スケールのみ別）
  flarePass.uniforms.uSunScreen.value.copy(shaftPass.uniforms.uSunScreen.value);
  flarePass.uniforms.uStrength.value = strength * 1.6;
  flarePass.uniforms.uAspect.value = camera.aspect;
}

const DEG = 180 / Math.PI;
const fmtLocal = (date, lon) => {
  const d = new Date(date.getTime() + (lon / 15) * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};
function updateHud(sunAltDeg, moonAltDeg, illum) {
  const s = simClock.state;
  const p = camera.position;
  hud.innerHTML =
    `📅 ${fmtLocal(s.simDate, s.longitude)} (現地)　⏩ ${simClock.speedLabel()}${s.paused ? ' ⏸' : ''}<br>` +
    `📍 ${s.latitude.toFixed(2)}°, ${s.longitude.toFixed(2)}°<br>` +
    `☀ ${sunAltDeg.toFixed(0)}°　🌙 ${moonAltDeg.toFixed(0)}° (${Math.round(illum * 100)}%)<br>` +
    `x: ${p.x.toFixed(0)}  z: ${p.z.toFixed(0)}　[O] 設定`;
}

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;
  const frameMs = dt * 1000;

  // --- 天文（単一の時計・単一の恒星時で太陽/月/星を計算）---
  simClock.advance(dt);
  const { simDate, latitude, longitude } = simClock.state;
  const sh = sunHorizontal(simDate, latitude, longitude);
  const mh = moonHorizontal(simDate, latitude, longitude);
  const ph = moonPhase(simDate);
  const lstDeg = localSiderealTimeDeg(simDate, longitude, sh.meanLon);
  altAzToVector(sh.altitude, sh.azimuth, sunDirection);
  const moonDir = altAzToVector(mh.altitude, mh.azimuth, _moonDir);
  const moonAltDeg = mh.altitude * DEG;
  const sunAltDeg = sh.altitude * DEG;

  // --- 天候（実時間 dt で補間/自動遷移。skyUpdate より前に uniform を確定）---
  weather.update(dt, { sunAltDeg, latitude, simDate, cameraPos: camera.position });
  const wc = weather.state.current;

  // --- 空・ライト・フォグ・共有 uniform（水 RT より前に確定させる）---
  skyUpdate(sunDirection, moonDir, moonAltDeg, ph.illuminatedFraction, {
    cloudiness: wc.cloudiness,
    lightAtten: weather.derived.lightAtten,
  });
  followPlayer(camera.position);
  // 天候の後段補正（skyUpdate が露出/フォグ密度を毎フレーム代入するため必ずその後）。
  // 霧は加算の下駄（昼の基準密度が極小なので乗算では効かない。fogBoost=1 で濃霧）
  scene.fog.density = scene.fog.density * (1 + wc.cloudiness * 0.3 + wc.precip * 0.8) + wc.fogBoost * 0.006;
  renderer.toneMappingExposure *= (1 - 0.3 * weather.derived.lightAtten) * (1 - 0.08 * wc.fogBoost);
  // Bloom はトーンマップ前の生 HDR に作用する。日中は閾値を高くして空も太陽スプライトも
  // ブルームさせない（太陽の白いドーム／四角アーティファクトを根本回避。太陽の輝きは
  // スプライトの高輝度＋AgX で表現）。夜は閾値を下げて月・星を淡く光らせる
  bloomPass.threshold = 0.85 + THREE.MathUtils.smoothstep(sunDirection.y, -0.02, 0.06) * 40.0;
  // 夜は Bloom を弱めて月・星をシャープに保つ。太陽が地平線を越えたら通常のグロウに戻す
  bloomPass.strength = (0.1 + THREE.MathUtils.smoothstep(sunDirection.y, -0.03, 0.06) * 0.18) * (1 - 0.5 * wc.cloudiness);

  // --- 天体は水 RT より前に更新（反射が当該フレームの位置を捉える）---
  moon.update(camera, sunDirection, moonDir, ph.illuminatedFraction);
  sun.update(camera, sunDirection, sunAltDeg);
  stars.group.position.copy(camera.position);
  stars.update(latitude, lstDeg, sunDirection.y, time);

  // --- 共有 uniform を最新化 → 水 RT パスが正しい太陽/月/星を描く ---
  sharedUniforms.uTime.value = time;
  sharedUniforms.uPlayerPos.value.set(camera.position.x, camera.position.z);
  gradePass.uniforms.uTime.value = time;
  water.userData.update(time);

  if (!window.__demo?.freeze) player.update(dt);
  grass.update(camera.position);
  ambience.update(dt, time, camera.position, wc);

  refreshEnv(time, frameMs); // 間引き PMREM（composer.render より前）
  updateLightShafts();

  hudTimer += dt;
  if (hudTimer > 0.25) {
    hudTimer = 0;
    updateHud(sh.altitude * DEG, moonAltDeg, ph.illuminatedFraction);
    settings.refresh();
  }

  composer.render();
});

// 動作検証用の内部フック
window.__demo = { camera, scene, renderer, player, terrainHeight, forestDensity, simClock, weather, bokehPass, bloomPass, composer, shaftPass, flarePass };
