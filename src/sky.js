import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { WATER_LEVEL } from './terrain.js';
import {
  sunLightColor,
  sunColorE,
  kAboveHor,
  nightFactor,
  fall,
  rampScalar,
} from './celestial.js';

// 物理ベースの空気遠近法（Hoffman & Preetham, SIGGRAPH 2002 の単一散乱）を
// グローバルな fog チャンクとして実装。太陽が動くため、太陽方向・放射色は
// 定数ではなく uniform にし、夜は内散乱を消して深い紺のフォグへ移行する。
function patchFogChunks() {
  THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorldPos;
#endif`;
  THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  // transformed はカスタム ShaderMaterial（水・雲）に存在しないため属性 position を使う
  vec4 fogWorldPos4 = vec4( position, 1.0 );
  #ifdef USE_INSTANCING
    fogWorldPos4 = instanceMatrix * fogWorldPos4;
  #endif
  vFogWorldPos = ( modelMatrix * fogWorldPos4 ).xyz;
#endif`;
  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogWorldPos;
  uniform vec3 uFogSunDir;
  uniform vec3 uFogSunColor;
  uniform float uFogNight;
  uniform vec3 uFogNightColor;
  uniform float uFogBoost;     // 天候: 朝靄・濃霧の昼の白み（0..1）
  uniform vec3 uFogDayColor;   // 天候: 昼の霧の底色（白〜灰）
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;
  THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
  {
    vec3 FOG_SUN_DIR = uFogSunDir;
    vec3 FOG_SUN_E = uFogSunColor * 1.15;        // 太陽放射照度（昼=暖色, 夜=0）
    const vec3 FOG_RAYLEIGH_TINT = vec3(0.42, 0.60, 1.0);
    const vec3 FOG_MIE_TINT = vec3(1.0, 0.86, 0.66);
    vec3 fogView = vFogWorldPos - cameraPosition;
    float fogDist = length(fogView);
    float cosT = dot(fogView / max(fogDist, 1e-4), FOG_SUN_DIR);
    // 通常は低空ほど濃い（地を這う霧）。濃霧(uFogBoost)時は高さ減衰を緩めて上空まで満たす
    float fogHeight = exp( -max( 0.0, vFogWorldPos.y - ${WATER_LEVEL.toFixed(2)} ) * 0.16 * ( 1.0 - uFogBoost * 0.78 ) );
    float dens = fogDensity * ( 1.0 + fogHeight * 1.8 );
    float bR = dens * 0.62;
    float bM = dens * 0.38;
    float ext = exp( -(bR + bM) * fogDist );
    float phR = 0.0597 * ( 1.0 + cosT * cosT );
    const float g = 0.5;
    float phM = 0.0796 * ( 1.0 - g ) * ( 1.0 - g )
              / pow( 1.0 + g * g - 2.0 * g * cosT, 1.5 );
    vec3 inscatter = FOG_SUN_E
      * ( bR * phR * FOG_RAYLEIGH_TINT + bM * phM * FOG_MIE_TINT ) / ( bR + bM )
      * 6.5;
    inscatter *= ( 1.0 - uFogNight );          // 夜は橙の内散乱を消す
    inscatter += uFogNightColor * uFogNight;    // 夜の底色（真っ黒にしない）
    // 天候の霧: 昼は白い朝靄/濃霧へ寄せる（夜は既存の紺底色のまま）
    inscatter = mix( inscatter, uFogDayColor, uFogBoost * ( 1.0 - uFogNight ) );
    gl_FragColor.rgb = gl_FragColor.rgb * ext + inscatter * ( 1.0 - ext );
  }
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
  #endif
#endif`;
}

// fog 対応マテリアルへ共有の太陽 uniform を参照で注入する（1 つ更新すれば全体に伝播）。
export function applyDynamicFog(material, fog) {
  if (!material || material.fog === false) return material;
  if (material.userData.__dynFog) return material; // 冪等
  material.userData.__dynFog = true;
  const refs = (u) => {
    u.uFogSunDir = fog.uFogSunDir;
    u.uFogSunColor = fog.uFogSunColor;
    u.uFogNight = fog.uFogNight;
    u.uFogNightColor = fog.uFogNightColor;
    u.uFogBoost = fog.uFogBoost;
    u.uFogDayColor = fog.uFogDayColor;
  };
  if (material.isShaderMaterial) {
    refs(material.uniforms); // すでに deep-clone 済みの uniforms へ参照を足す
    return material;
  }
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    refs(shader.uniforms);
  };
  material.needsUpdate = true;
  return material;
}

// 降順 stops [{a, rgb}] の色ランプ（線形）
function rampColor(stops, a, out) {
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

// 大気係数のランプ（太陽高度 度）
const SKY_TURB = [
  { a: 60, v: 1.8 }, { a: 30, v: 2.4 }, { a: 12, v: 5.0 }, { a: 4, v: 9.0 },
  { a: 0, v: 10.0 }, { a: -6, v: 7.0 }, { a: -12, v: 2.0 }, { a: -18, v: 0.3 },
];
const SKY_RAY = [
  { a: 60, v: 1.0 }, { a: 30, v: 1.4 }, { a: 12, v: 2.2 }, { a: 4, v: 3.0 },
  { a: 0, v: 3.4 }, { a: -6, v: 2.0 }, { a: -12, v: 0.6 }, { a: -18, v: 0.2 },
];
// 高い太陽では Mie の暈を小さく（画面全面の白飛びを防ぐ）。ゴールデンアワー(4-12°)はグロウを残す
const SKY_MIE = [
  { a: 60, v: 0.0013 }, { a: 30, v: 0.0018 }, { a: 12, v: 0.003 }, { a: 4, v: 0.0035 },
  { a: 0, v: 0.0025 }, { a: -6, v: 0.0015 }, { a: -12, v: 0.001 }, { a: -18, v: 0.0008 },
];
// 太陽光強度。昼に高くしすぎると砂などが Bloom 閾値を越えて霞むので控えめに
const SUN_I = [{ a: 12, v: 2.3 }, { a: 0, v: 1.5 }];
// 環境光（IBL）。薄明中（日の出前）は低く保ち、日の出後に地面が明るくなるようにする
// （これがないと日の出前に空より先にフィールドが平坦に明るくなる）。夜は床を下げて暗く
const ENV_I = [{ a: 30, v: 0.35 }, { a: 10, v: 0.3 }, { a: 2, v: 0.14 }, { a: -4, v: 0.05 }, { a: -14, v: 0.03 }];
const HEMI_I = [{ a: 30, v: 0.35 }, { a: 2, v: 0.12 }, { a: -4, v: 0.05 }, { a: -14, v: 0.03 }];
// 昼は澄んだ空気（遠景くっきり）、夜は濃くして遠くの山・湖を夜霧の闇に溶け込ませる
const FOG_D = [{ a: 30, v: 0.0004 }, { a: 8, v: 0.0009 }, { a: 0, v: 0.0016 }, { a: -6, v: 0.0028 }, { a: -14, v: 0.0036 }];
// 露出（目の順応）。昼は強く絞り、夜は開けて月・星が見えるように
const EXPO = [
  { a: 40, v: 0.34 }, { a: 20, v: 0.45 }, { a: 8, v: 0.62 }, { a: 2, v: 0.82 },
  { a: -3, v: 0.98 }, { a: -8, v: 1.05 }, { a: -14, v: 1.12 },
];
const HEMI_SKY = [
  { a: 30, rgb: [0.45, 0.62, 1.0] }, { a: 6, rgb: [0.79, 0.72, 0.85] },
  { a: -6, rgb: [0.08, 0.11, 0.22] }, { a: -12, rgb: [0.05, 0.06, 0.14] },
];
const HEMI_GND = [
  { a: 30, rgb: [0.3, 0.27, 0.2] }, { a: 6, rgb: [0.43, 0.37, 0.23] },
  { a: -6, rgb: [0.04, 0.05, 0.09] },
];

// Sky アドオン（雲入りカスタム版）の太陽周りの過剰輝度を抑える。node_modules は編集せず
// 実行時にフラグメント出力行を差し替える。硬い min クランプだと平らな「白いドーム＋
// 緑の縁」が出るため、色相を保つ滑らかなロールオフ（ソフトショルダー）にする。
const SKY_CLAMP = 2.6; // ロールオフの漸近上限
const SKY_KNEE = 1.2; // これ以下は素通し、これ以上を滑らかに圧縮
function clampSkyMaterial(m) {
  if (m.userData.__clamped) return;
  m.userData.__clamped = true;
  m.fragmentShader = m.fragmentShader.replace(
    'gl_FragColor = vec4( texColor, 1.0 );',
    `{
      float skyM = max(texColor.r, max(texColor.g, texColor.b));
      if (skyM > ${SKY_KNEE.toFixed(2)}) {
        float skyMc = ${SKY_KNEE.toFixed(2)} + (${SKY_CLAMP.toFixed(2)} - ${SKY_KNEE.toFixed(2)})
          * (1.0 - exp(-(skyM - ${SKY_KNEE.toFixed(2)}) / (${SKY_CLAMP.toFixed(2)} - ${SKY_KNEE.toFixed(2)})));
        texColor *= skyMc / skyM; // 色相を保ったまま最大チャンネルを圧縮
      }
    }
    gl_FragColor = vec4( texColor, 1.0 );`
  );
  m.needsUpdate = true;
}

export function createSky(scene, renderer, sharedUniforms) {
  patchFogChunks(); // fog マテリアルのコンパイル前に呼ぶ

  const sky = new Sky();
  sky.scale.setScalar(4000);
  scene.add(sky);

  // 太陽周りの極端な輝度を上限でクランプ。これがないと光芒/フレア/Bloom が
  // 超高輝度の太陽を拾って画面全体を白飛びさせる（太陽直視時）
  clampSkyMaterial(sky.material);

  const sun = new THREE.Vector3(0, 0.2, -1).normalize();
  const moonDir = new THREE.Vector3(0, -1, 0);
  sky.material.uniforms.sunPosition.value.copy(sun);
  sky.material.uniforms.mieDirectionalG.value = 0.82;

  // 動的フォグの共有 uniform（参照で全フォグマテリアルに配る）
  const fogUniforms = {
    uFogSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uFogSunColor: { value: new THREE.Color(0, 0, 0) },
    uFogNight: { value: 0 },
    uFogNightColor: { value: new THREE.Color(0.008, 0.016, 0.035) }, // 闇に近い暗い紺（遠景を溶かす）
    uFogBoost: { value: 0 }, // 天候で上書き（main で weatherUniforms を参照配布）
    uFogDayColor: { value: new THREE.Color(0.62, 0.66, 0.72) },
  };
  scene.fog = new THREE.FogExp2(0xe2c8a8, 0.0014);

  // 太陽光
  const sunLight = new THREE.DirectionalLight(0xffffff, 3.4);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(4096, 4096);
  const SR = 110;
  sunLight.shadow.camera.left = -SR;
  sunLight.shadow.camera.right = SR;
  sunLight.shadow.camera.top = SR;
  sunLight.shadow.camera.bottom = -SR;
  sunLight.shadow.camera.near = 1;
  sunLight.shadow.camera.far = 400;
  sunLight.shadow.bias = -0.0006;
  sunLight.shadow.normalBias = 0.5;
  scene.add(sunLight);
  scene.add(sunLight.target);

  // 月光（弱い青白。影は落とさない）
  const moonLight = new THREE.DirectionalLight(0x000000, 0);
  moonLight.color.setRGB(0.55, 0.66, 1.0, THREE.LinearSRGBColorSpace);
  moonLight.castShadow = false;
  scene.add(moonLight);
  scene.add(moonLight.target);

  // 環境光
  const hemiLight = new THREE.HemisphereLight(0xc9b8d8, 0x6e5e3a, 0.4);
  scene.add(hemiLight);
  scene.environmentIntensity = 0.38;

  // IBL（PMREM）。太陽が動くので間引いて再生成する。
  // 専用 envScene が Sky のクローンを持ち、live な sky は本シーンから外さない（フリッカ防止）。
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new Sky();
  envSky.scale.setScalar(4000);
  clampSkyMaterial(envSky.material);
  envScene.add(envSky);
  const syncEnvSky = () => {
    envSky.material.uniforms = sky.material.uniforms; // live uniforms を参照共有
  };
  syncEnvSky();
  let envRT = pmrem.fromScene(envScene);
  scene.environment = envRT.texture;
  let aLastBake = 90;
  let tLastBake = -1e9;

  const _c = new THREE.Color();

  // 太陽高度から各種をランプ更新する本体。wx={cloudiness,lightAtten} で天候変調（省略可）
  function update(sunDir, mDir, moonAltDeg, illum, wx) {
    sun.copy(sunDir);
    moonDir.copy(mDir);
    const a = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(sunDir.y, -1, 1)));
    const kAbove = kAboveHor(a);
    const kNight = fall(a, 2, -6);
    const cloud = wx ? wx.cloudiness : 0;       // 雲量 0..1
    const atten = wx ? wx.lightAtten : 0;       // 日射の減衰 0..1

    // Sky ドーム（曇天で白濁・青み抜き・暈拡大）
    const u = sky.material.uniforms;
    u.sunPosition.value.copy(sunDir);
    u.turbidity.value = rampScalar(SKY_TURB, a) * (1 + cloud * 1.2);
    u.rayleigh.value = rampScalar(SKY_RAY, a) * (1 - cloud * 0.4);
    u.mieCoefficient.value = rampScalar(SKY_MIE, a) * (1 + cloud * 2.0);

    // 太陽光（色・強度）。曇天/降水で直射を弱める（影が薄くなる）
    sunLightColor(a, sunLight.color);
    sunLight.intensity = rampScalar(SUN_I, a) * kAbove * (1 - 0.6 * atten);
    sunLight.visible = sunLight.intensity > 0.001;

    // 月光
    const iMoon = 0.3 * THREE.MathUtils.smoothstep(moonAltDeg, -4, 12) * (0.15 + 0.85 * illum) * kNight;
    moonLight.intensity = iMoon;
    moonLight.visible = iMoon > 0.002;

    // 環境光（曇天は拡散光が微増＝柔らかい曇天光）
    scene.environmentIntensity = rampScalar(ENV_I, a) * (1 + 0.15 * cloud);
    hemiLight.intensity = rampScalar(HEMI_I, a) * (1 + 0.1 * cloud);
    rampColor(HEMI_SKY, a, hemiLight.color);
    rampColor(HEMI_GND, a, hemiLight.groundColor);

    // フォグ
    fogUniforms.uFogSunDir.value.copy(sunDir);
    sunColorE(a, fogUniforms.uFogSunColor.value);
    fogUniforms.uFogNight.value = nightFactor(a);
    scene.fog.density = rampScalar(FOG_D, a);

    // 共有 uniform（水・草・葉が参照する太陽）
    sharedUniforms.uSunDir.value.copy(sunDir);
    sunColorE(a, sharedUniforms.uSunColor.value);

    // 露出の自動調整（昼は絞り、夜は開ける）
    renderer.toneMappingExposure = rampScalar(EXPO, a);
  }

  // PMREM 間引き再生成（太陽が一定角度動いた / 一定時間経過 / フレームが重くない とき）
  function refreshEnv(now, frameMs) {
    if (now - tLastBake < 0.5) return;
    // 重いフレームでは避ける（ヒッチ防止）が、長く未更新なら強行（低速環境でも追従）
    if (frameMs > 40 && now - tLastBake < 3.0) return;
    const a = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(sun.y, -1, 1)));
    // 小さい角度ステップで再生成し、IBL の跳び（昼のちらつき）を抑える
    if (Math.abs(a - aLastBake) < 0.5 && now - tLastBake < 2.0) return;
    syncEnvSky();
    const next = pmrem.fromScene(envScene);
    const prev = envRT;
    envRT = next;
    scene.environment = envRT.texture;
    if (prev) prev.dispose();
    aLastBake = a;
    tLastBake = now;
  }

  // プレイヤー追従で太陽光・月光のシャドウ/向きを動かす
  function followPlayer(playerPos) {
    sunLight.position.copy(playerPos).addScaledVector(sun, 180);
    sunLight.target.position.copy(playerPos);
    moonLight.position.copy(playerPos).addScaledVector(moonDir, 180);
    moonLight.target.position.copy(playerPos);
  }

  function disposeSky() {
    pmrem.dispose();
    if (envRT) envRT.dispose();
  }

  return { sky, sunDirection: sun, fogUniforms, followPlayer, update, refreshEnv, disposeSky };
}
