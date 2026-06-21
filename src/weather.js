import * as THREE from 'three';
import { rainStreakTexture, snowFlakeTexture } from './textures.js';

// ============================================================================
// 天候システム。雲量・雨・霧・雪を「連続パラメータ」で表現し、既存の昼夜ランプ
// （露出/フォグ/空/光）を置換せず変調する。種類（プリセット）は target ベクトルに
// 過ぎず、current を指数補間で滑らかに追従させる（手動↔自動↔ブレンドを 1 本に統一）。
// Math.random / Date は注入で受け、シェーダ内で乱数遷移は起こさない。
// 詳細設計: docs/weather-blueprint.md
// ============================================================================

// --- プリセット（target の部分集合。指定外は DEFAULT へ倒す）---
const DEFAULT = { cloudiness: 0.05, precip: 0, precipKind: 0, fogBoost: 0, windGust: 0.6 };

const WEATHER_PRESETS = {
  clear:    { cloudiness: 0.05, precip: 0.0,  fogBoost: 0.0,  windGust: 0.6 },
  fair:     { cloudiness: 0.35, precip: 0.0,  fogBoost: 0.05, windGust: 0.8 },
  cloudy:   { cloudiness: 0.75, precip: 0.0,  fogBoost: 0.1,  windGust: 0.9 },
  overcast: { cloudiness: 1.0,  precip: 0.0,  fogBoost: 0.25, windGust: 1.0 },
  rain:     { cloudiness: 0.92, precip: 0.6,  fogBoost: 0.35, windGust: 1.3, precipKind: 0 },
  storm:    { cloudiness: 1.0,  precip: 0.95, fogBoost: 0.45, windGust: 2.0, precipKind: 0 },
  mist:     { cloudiness: 0.45, precip: 0.0,  fogBoost: 0.6,  windGust: 0.2 },
  fog:      { cloudiness: 0.6,  precip: 0.0,  fogBoost: 0.95, windGust: 0.1 },
  snow:     { cloudiness: 0.9,  precip: 0.55, fogBoost: 0.4,  windGust: 0.7, precipKind: 1 },
  blizzard: { cloudiness: 1.0,  precip: 0.95, fogBoost: 0.7,  windGust: 2.0, precipKind: 1 },
};

export const WEATHER_LABELS = {
  clear: '快晴', fair: '晴れ時々曇り', cloudy: '曇り', overcast: 'どんより曇り',
  rain: '雨', storm: '嵐', mist: '朝靄', fog: '濃霧', snow: '雪', blizzard: '吹雪',
};

// 自動遷移（隣接天候へ偏らせて急変を防ぐ。雨↔雪は文脈ゲートで決める）
const TRANSITIONS = {
  clear:    [['fair', 0.5], ['cloudy', 0.3], ['mist', 0.2]],
  fair:     [['clear', 0.4], ['cloudy', 0.4], ['rain', 0.2]],
  cloudy:   [['fair', 0.35], ['overcast', 0.3], ['rain', 0.25], ['clear', 0.1]],
  overcast: [['cloudy', 0.4], ['rain', 0.4], ['fog', 0.2]],
  rain:     [['cloudy', 0.45], ['storm', 0.2], ['overcast', 0.25], ['fog', 0.1]],
  storm:    [['rain', 0.7], ['overcast', 0.3]],
  mist:     [['clear', 0.5], ['fair', 0.3], ['fog', 0.2]],
  fog:      [['mist', 0.4], ['overcast', 0.3], ['cloudy', 0.3]],
  snow:     [['cloudy', 0.5], ['overcast', 0.5]],
  blizzard: [['snow', 0.6], ['overcast', 0.4]],
};

// 派生量（current から算出。状態には持たせない）
function deriveWeather(cur, out) {
  out.lightAtten = THREE.MathUtils.clamp(0.55 * cur.cloudiness + 0.6 * cur.precip, 0, 1);
  out.skyDim = 1.0 - cur.cloudiness * 0.4;
  out.rainAmount = cur.precip * (1 - cur.precipKind);
  out.snowAmount = cur.precip * cur.precipKind;
  return out;
}

// 緯度＋月から擬似気温を推定し、降水を雨にするか雪にするかを決める
function isFreezing(lat, date) {
  const m = date.getUTCMonth(); // 0..11
  const north = lat >= 0;
  // 冬らしさ 0..1（北半球は 1 月が冬、南半球は 7 月）
  const winterness = north
    ? Math.cos((m / 12) * 2 * Math.PI) * 0.5 + 0.5
    : Math.cos(((m - 6) / 12) * 2 * Math.PI) * 0.5 + 0.5;
  const temp = 30 - Math.abs(lat) * 0.55 - winterness * 22;
  return temp < 1.0;
}

// --- 降水粒子（雨/雪共用の単一 Points。GPU 落下 + wrap, カメラ追従ボックス）---
const BOX_SIZE = 80;   // カメラ周囲ボックスの一辺(m)
const BOX_HEIGHT = 50; // 落下の高さ(m)
const PRECIP_COUNT = 9000;

const PRECIP_VERT = /* glsl */ `
#include <fog_pars_vertex>
attribute vec4 aSeed; // x,z 正規化位置 / 落下位相 / 量しきい値(rank)
uniform float uTime, uPrecip, uPrecipKind, uWindGust, uBoxSize, uBoxHeight;
uniform vec2 uWindDir;
varying float vAlpha;
varying float vKind;
void main() {
  // 量に応じて点を間引く（rank が量を超える点は描画スキップ）
  if (aSeed.w > uPrecip + 0.001) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  float kind = uPrecipKind;
  vKind = kind;
  float sizeVar = 0.5 + 1.0 * fract(aSeed.z * 13.7 + aSeed.w * 5.3); // 粒ごとの大きさのばらつき
  float fall = mix(24.0, 2.2, kind); // 雨=速い, 雪=遅い
  vec3 lp;
  lp.x = (aSeed.x - 0.5) * uBoxSize;
  lp.z = (aSeed.y - 0.5) * uBoxSize;
  lp.y = uBoxHeight * 0.5 - mod(aSeed.z * uBoxHeight + uTime * fall * (0.8 + 0.4 * sizeVar), uBoxHeight);
  float prog = (uBoxHeight * 0.5 - lp.y) / uBoxHeight; // 上=0 下=1
  vec2 drift = uWindDir * uWindGust * mix(7.0, 3.0, kind) * prog;       // 風シア（斜め降り）
  drift += vec2(sin(uTime * 1.3 + aSeed.z * 6.28), cos(uTime * 1.1 + aSeed.z * 5.0)) * (1.8 * kind); // 雪の横揺れ
  lp.xz += drift;
  lp.x = mod(lp.x + uBoxSize * 0.5, uBoxSize) - uBoxSize * 0.5;
  lp.z = mod(lp.z + uBoxSize * 0.5, uBoxSize) - uBoxSize * 0.5;

  vec4 worldPos = modelMatrix * vec4(lp, 1.0);
  vec4 mvPosition = viewMatrix * worldPos;
  gl_Position = projectionMatrix * mvPosition;
  // 雨は縦長の細い筋、雪は小さい丸粒。近距離で発散しないようクランプ
  float persp = 200.0 / max(-mvPosition.z, 1.0);
  float rainSize = clamp(8.5 * persp, 3.0, 42.0);
  float snowSize = clamp((3.0 + 6.0 * sizeVar) * persp, 1.5, 20.0);
  gl_PointSize = mix(rainSize, snowSize, kind);
  // 雨は薄く（半透明の筋）、雪はやや濃く。粒ごとの濃淡も付ける
  vAlpha = clamp((uPrecip - aSeed.w) * 6.0, 0.0, 1.0) * mix(0.3, 0.8, kind) * (0.6 + 0.4 * sizeVar);
  #ifdef USE_FOG
    vFogDepth = -mvPosition.z;
    vFogWorldPos = worldPos.xyz;
  #endif
}
`;

const PRECIP_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D uRainTex, uSnowTex;
uniform float uDaylight; // 0=夜 1=昼。雨雪は周囲光で見えるので夜はほぼ不可視
varying float vAlpha;
varying float vKind;
void main() {
  vec4 tex = mix(texture2D(uRainTex, gl_PointCoord), texture2D(uSnowTex, gl_PointCoord), vKind);
  vec3 col = mix(vec3(0.70, 0.76, 0.84), vec3(0.92, 0.94, 1.0), vKind); // 雨=青灰, 雪=白
  float a = tex.a * vAlpha;
  // 明るさを昼夜に連動。夜は光源がないのでほぼ見えない（くっきり残るのを防ぐ）
  float lightLevel = 0.05 + 0.95 * uDaylight;
  a *= lightLevel;
  if (a < 0.008) discard;
  gl_FragColor = vec4(col, a);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function createPrecip(weatherUniforms, fogUniforms, rand) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(PRECIP_COUNT * 3); // 0（実位置はシェーダで計算）
  const seeds = new Float32Array(PRECIP_COUNT * 4);
  for (let i = 0; i < PRECIP_COUNT; i++) {
    seeds[i * 4] = rand();
    seeds[i * 4 + 1] = rand();
    seeds[i * 4 + 2] = rand();
    seeds[i * 4 + 3] = rand(); // rank
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));

  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uRainTex: { value: rainStreakTexture() },
      uSnowTex: { value: snowFlakeTexture() },
      uBoxSize: { value: BOX_SIZE },
      uBoxHeight: { value: BOX_HEIGHT },
    },
  ]);
  // 共有 uniform を参照でエイリアス（再コンパイル不要・.value 更新のみで伝播）
  uniforms.uTime = weatherUniforms.uTime;
  uniforms.uPrecip = weatherUniforms.uPrecip;
  uniforms.uPrecipKind = weatherUniforms.uPrecipKind;
  uniforms.uWindGust = weatherUniforms.uWindGust;
  uniforms.uWindDir = weatherUniforms.uWindDir;
  uniforms.uDaylight = weatherUniforms.uDaylight;
  if (fogUniforms) {
    uniforms.uFogSunDir = fogUniforms.uFogSunDir;
    uniforms.uFogSunColor = fogUniforms.uFogSunColor;
    uniforms.uFogNight = fogUniforms.uFogNight;
    uniforms.uFogNightColor = fogUniforms.uFogNightColor;
  }

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: PRECIP_VERT,
    fragmentShader: PRECIP_FRAG,
    transparent: true,
    depthWrite: false,
    fog: true,
  });

  const points = new THREE.Points(geometry, material);
  points.name = 'precip';
  points.frustumCulled = false; // カメラ追従ボックスなので自前カリングしない
  points.layers.set(1); // 水面反射(layer0)・GTAO から除外
  points.userData.excludeFromGTAO = true;
  points.visible = false;
  return points;
}

// --- 曇天ドーム（雲量で空を覆う灰色の半球）。Preetham 空はターブだけでは灰色に
// ならないため、空の上に薄い灰色を被せて「どんより」を作る。カメラ追従・地形に隠れる。---
const DOME_RADIUS = 2400; // カメラ far(3000) 未満。地形(layer0)に depthTest で隠れる
const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const DOME_FRAG = /* glsl */ `
precision highp float;
uniform float uCloudiness;
uniform float uDaylight;
uniform vec3 uHorizonGrey;
uniform vec3 uZenithGrey;
varying vec3 vDir;
void main() {
  float h = clamp(vDir.y, 0.0, 1.0);
  vec3 grey = mix(uHorizonGrey, uZenithGrey, h) * uDaylight; // 夜は暗く
  // 地平線のわずか下〜上で立ち上げ、地平線で硬く切らない
  float cover = smoothstep(-0.04, 0.22, vDir.y) * uCloudiness;
  gl_FragColor = vec4(grey, cover);
}
`;

function createOvercastDome(weatherUniforms) {
  const geometry = new THREE.SphereGeometry(DOME_RADIUS, 24, 16);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uCloudiness: weatherUniforms.uCloudiness,
      uDaylight: weatherUniforms.uDaylight,
      uHorizonGrey: { value: new THREE.Color(1.05, 1.08, 1.12) },
      uZenithGrey: { value: new THREE.Color(0.62, 0.66, 0.74) },
    },
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    depthTest: true, // 地形・木に隠れる（空の領域だけ灰色を被せる）
    fog: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'overcastDome';
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  return mesh;
}

// --- 濡れ表現を任意のマテリアルへ冪等注入（applyDynamicFog と同型）---
// MeshStandard 系を暗化 + roughness 低下（濡れ艶）。
function makeApplyWetness(weatherUniforms) {
  return function applyWetness(material) {
    if (!material || material.userData.__wet) return material;
    // 濡れ/積雪は法線・roughness を使うため MeshStandard 系のみ対象
    // （MeshBasic=鳥/蝶 や MeshLambert=花、独自 ShaderMaterial は除外）
    if (!material.isMeshStandardMaterial) return material;
    material.userData.__wet = true;
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = function (shader, renderer) {
      if (prev) prev.call(this, shader, renderer);
      shader.uniforms.uWetness = weatherUniforms.uWetness;
      shader.uniforms.uSnowCover = weatherUniforms.uSnowCover;
      shader.fragmentShader =
        'uniform float uWetness;\nuniform float uSnowCover;\n' +
        shader.fragmentShader
          .replace(
            '#include <roughnessmap_fragment>',
            '#include <roughnessmap_fragment>\n  roughnessFactor *= (1.0 - 0.45 * uWetness);'
          )
          .replace(
            '#include <color_fragment>',
            '#include <color_fragment>\n  diffuseColor.rgb *= mix(1.0, 0.72, uWetness);'
          )
          .replace(
            '#include <opaque_fragment>',
            // 上向き面に雪を積もらせる（ワールド法線の上成分でマスク）
            `float snowUp = (vec4(normalize(normal), 0.0) * viewMatrix).y;
            float snowMask = uSnowCover * smoothstep(0.35, 0.72, snowUp);
            outgoingLight = mix(outgoingLight, vec3(0.90, 0.93, 1.0) * (0.55 + 0.45 * clamp(snowUp,0.0,1.0)), snowMask);
            #include <opaque_fragment>`
          );
    };
    material.needsUpdate = true;
    return material;
  };
}

export function createWeather({ rand = Math.random, initial = 'fair', latitude = 35.68 } = {}) {
  const current = { ...DEFAULT, ...WEATHER_PRESETS[initial] };
  const target = { ...DEFAULT, ...WEATHER_PRESETS[initial] };
  const derived = { lightAtten: 0, skyDim: 1, rainAmount: 0, snowAmount: 0 };
  let mode = 'auto';
  let preset = initial;
  let dwell = 60; // 次の自動遷移までの実時間(秒)
  let intensity = 1.0; // プリセットの precip/fogBoost 全体スケール

  const weatherUniforms = {
    uCloudiness: { value: current.cloudiness },
    uPrecip: { value: current.precip },
    uPrecipKind: { value: current.precipKind },
    uRainRipple: { value: 0 },
    uWetness: { value: 0 },
    uSnowCover: { value: 0 }, // 段階4: 積雪
    uWindGust: { value: current.windGust },
    uChoppyScale: { value: 1 }, // 水面の波の尖り（風で増す）。water が参照
    uWindDir: { value: new THREE.Vector2(0.912, 0.41) }, // 既存の草/木の固定風向と一致
    uFogBoost: { value: 0 },
    uFogDayColor: { value: new THREE.Color(0.62, 0.66, 0.72) },
    uDaylight: { value: 1 }, // 0=夜 1=昼（曇天ドームの明るさ）
    uTime: { value: 0 }, // 降水の実時間クロック
  };

  const group = new THREE.Group();
  group.name = 'weather';

  const applyWetness = makeApplyWetness(weatherUniforms);

  // 曇天ドームは常設（cloudiness=0 で透明）
  const dome = createOvercastDome(weatherUniforms);
  group.add(dome);

  let precip = null;
  function attachPrecip(fogUniforms) {
    precip = createPrecip(weatherUniforms, fogUniforms, rand);
    group.add(precip);
  }

  function setTargetFromPreset(key) {
    const p = WEATHER_PRESETS[key] || WEATHER_PRESETS.clear;
    Object.assign(target, DEFAULT, p);
    target.precip *= intensity;
    target.fogBoost = Math.min(1, target.fogBoost * (0.5 + 0.5 * intensity));
    preset = key;
  }

  function pickNext(ctx) {
    const table = TRANSITIONS[preset] || TRANSITIONS.clear;
    let roll = rand();
    let key = table[table.length - 1][0];
    for (const [k, w] of table) {
      if (roll < w) { key = k; break; }
      roll -= w;
    }
    setTargetFromPreset(key);
    // 雨↔雪の文脈ゲート: 降水系を選んだら気温で precipKind を決める
    if (target.precip > 0.01) {
      target.precipKind = isFreezing(ctx.latitude, ctx.simDate) ? 1 : 0;
    }
    dwell = 45 + rand() * 75;
  }

  function update(dt, ctx) {
    // --- 自動遷移（実時間 dt ベース。simClock 倍率に引きずられない）---
    if (mode === 'auto') {
      dwell -= dt;
      // 早朝・低風は朝靄バイアス（晴天系から mist へ寄せる）
      if (dwell <= 0) {
        if (ctx && ctx.sunAltDeg < 4 && ctx.sunAltDeg > -8 && current.windGust < 0.7 && rand() < 0.5) {
          setTargetFromPreset('mist');
          dwell = 45 + rand() * 50;
        } else {
          pickNext(ctx || { latitude, simDate: new Date(0) });
        }
      }
    }

    // --- current を target へ補間（フレームレート非依存の指数補間）---
    const lerp = (key, tau) => {
      const k = 1 - Math.exp(-dt / tau);
      current[key] += (target[key] - current[key]) * k;
    };
    lerp('cloudiness', 12);
    lerp('fogBoost', 14);
    lerp('precip', 6);
    lerp('windGust', 2.2);
    // precipKind は降水がほぼ止んでから切替を許可（雨雪の瞬間混在を防ぐ）
    if (current.precip < 0.05) current.precipKind += (target.precipKind - current.precipKind) * (1 - Math.exp(-dt / 1.5));

    // wetness: 非対称一次遅れ積分（雨で速く濡れ、止むと遅く乾く）
    const rainAmount = current.precip * (1 - current.precipKind);
    const wetTau = rainAmount > current.wetness ? 3.0 : 60.0;
    current.wetness = (current.wetness ?? 0) + (rainAmount - (current.wetness ?? 0)) * (1 - Math.exp(-dt / wetTau));

    // snowCover: 雪が降ると上面に積もり、止むとゆっくり融ける（非対称積分）
    const snowing = current.precip * current.precipKind > 0.05 ? 1 : 0;
    const snowTau = snowing ? 18.0 : 120.0;
    current.snowCover = (current.snowCover ?? 0) + (snowing - (current.snowCover ?? 0)) * (1 - Math.exp(-dt / snowTau));

    deriveWeather(current, derived);

    // --- uniform 反映 ---
    weatherUniforms.uCloudiness.value = current.cloudiness;
    weatherUniforms.uPrecip.value = current.precip;
    weatherUniforms.uPrecipKind.value = current.precipKind;
    weatherUniforms.uRainRipple.value = derived.rainAmount;
    weatherUniforms.uWetness.value = current.wetness;
    weatherUniforms.uWindGust.value = current.windGust;
    weatherUniforms.uChoppyScale.value = 1 + current.windGust * 0.5;
    weatherUniforms.uSnowCover.value = current.snowCover ?? 0;
    weatherUniforms.uFogBoost.value = current.fogBoost;
    weatherUniforms.uDaylight.value = ctx ? THREE.MathUtils.smoothstep(ctx.sunAltDeg, -8, 6) : 1;
    weatherUniforms.uTime.value += dt; // 降水は実時間

    // --- グループごとカメラへスナップ（降水ボックス・曇天ドームが追従）---
    if (ctx && ctx.cameraPos) group.position.copy(ctx.cameraPos);
    if (precip) precip.visible = current.precip > 0.01;
  }

  // --- 手動操作 ---
  function setPreset(key) {
    mode = 'manual';
    setTargetFromPreset(key);
  }
  function setParam(key, value) {
    mode = 'manual';
    if (key in target) target[key] = value;
  }
  function setIntensity(scale) {
    intensity = scale;
    setTargetFromPreset(preset); // 現プリセットへ再適用
  }
  function setMode(flag) {
    mode = flag === 'manual' ? 'manual' : 'auto';
    if (mode === 'auto') dwell = Math.min(dwell, 8); // 自動へ戻したら早めに次を抽選
  }

  function dispose() {
    if (precip) {
      precip.geometry.dispose();
      precip.material.dispose();
    }
  }

  return {
    group,
    uniforms: weatherUniforms,
    state: {
      current,
      target,
      get mode() { return mode; },
      get preset() { return preset; },
    },
    derived,
    attachPrecip,
    applyWetness,
    update,
    setPreset,
    setParam,
    setIntensity,
    setMode,
    getMode: () => mode,
    getCurrentLabel: () => WEATHER_LABELS[preset] || preset,
    dispose,
  };
}
