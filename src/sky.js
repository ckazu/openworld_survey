import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { WATER_LEVEL } from './terrain.js';

// 物理ベースの空気遠近法（Hoffman & Preetham, SIGGRAPH 2002 の単一散乱）:
// fog チャンクをグローバルにパッチし、消散 + Rayleigh/Mie の内散乱で霞ませる。
// 視線と太陽のなす角 θ により、太陽方向は明るく暖かく・反対側は青灰色になる。
// 既存の高さ変調（湖面・谷に溜まる朝もや）も密度に乗せる。
// 太陽方向・色は静的なので GLSL 定数として焼き込む（uniform 伝搬が不要）。
// fog: true の全マテリアルに一括で効く。各マテリアルのコンパイル前に呼ぶこと。
function patchFogChunks(sunDir, sunColor) {
  THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorldPos;
#endif`;
  THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  // transformed はカスタム ShaderMaterial（水・雲）に存在しないため
  // 属性 position を使う（風の曲げ分の誤差はフォグには無視できる）
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
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;
  const sd = `vec3(${sunDir.x.toFixed(4)}, ${sunDir.y.toFixed(4)}, ${sunDir.z.toFixed(4)})`;
  const sc = `vec3(${sunColor.r.toFixed(3)}, ${sunColor.g.toFixed(3)}, ${sunColor.b.toFixed(3)})`;
  THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
  {
    // --- Hoffman & Preetham 2002: L = L0·ext + L_in·(1−ext) ---
    const vec3 FOG_SUN_DIR = ${sd};
    const vec3 FOG_SUN_E = ${sc} * 1.15;        // 太陽放射照度（トーン調整込み）
    const vec3 FOG_RAYLEIGH_TINT = vec3(0.42, 0.60, 1.0); // 青空の散乱色
    const vec3 FOG_MIE_TINT = vec3(1.0, 0.86, 0.66);      // 暖色のエアロゾル
    vec3 fogView = vFogWorldPos - cameraPosition;
    float fogDist = length(fogView);
    float cosT = dot(fogView / max(fogDist, 1e-4), FOG_SUN_DIR);
    // 水面の高さを基準に、低いところほど密度を上げる（朝もや）
    float fogHeight = exp( -max( 0.0, vFogWorldPos.y - ${WATER_LEVEL.toFixed(2)} ) * 0.16 );
    float dens = fogDensity * ( 1.0 + fogHeight * 1.8 );
    float bR = dens * 0.62;                      // Rayleigh への配分
    float bM = dens * 0.38;                      // Mie への配分
    float ext = exp( -(bR + bM) * fogDist );
    // 位相関数: Rayleigh + Henyey-Greenstein (g=0.5)
    float phR = 0.0597 * ( 1.0 + cosT * cosT );
    const float g = 0.5;
    float phM = 0.0796 * ( 1.0 - g ) * ( 1.0 - g )
              / pow( 1.0 + g * g - 2.0 * g * cosT, 1.5 );
    vec3 inscatter = FOG_SUN_E
      * ( bR * phR * FOG_RAYLEIGH_TINT + bM * phM * FOG_MIE_TINT ) / ( bR + bM )
      * 6.5;
    gl_FragColor.rgb = gl_FragColor.rgb * ext + inscatter * ( 1.0 - ext );
  }
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
  #endif
#endif`;
}

// 空・太陽光・フォグ・環境マップ（IBL）をまとめてセットアップする
export function createSky(scene, renderer) {
  const sky = new Sky();
  sky.scale.setScalar(4000);

  const sun = new THREE.Vector3();
  const elevation = 8; // 度（ゴールデンアワーの低い斜光）
  const azimuth = 145;
  const phi = THREE.MathUtils.degToRad(90 - elevation);
  const theta = THREE.MathUtils.degToRad(azimuth);
  sun.setFromSphericalCoords(1, phi, theta);

  // 空気遠近法のチャンクパッチ（地形・植生・水のマテリアル生成前に行う）
  patchFogChunks(sun, new THREE.Color(0xffc587));

  const u = sky.material.uniforms;
  u.sunPosition.value.copy(sun);
  // 低い太陽 + 高めの濁度で、地平線が橙〜琥珀に染まる夕方の空にする
  u.turbidity.value = 9;
  u.rayleigh.value = 2.6;
  u.mieCoefficient.value = 0.0045; // 低い太陽では暈が巨大化するため控えめに
  u.mieDirectionalG.value = 0.82;

  // 空を PMREM 化して PBR 材質の環境光（IBL）として使う。
  // Sky は頂点シェーダで far 平面に張り付くので CubeCamera でもクリップされない
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(sky);
  const envRT = pmrem.fromScene(envScene);
  pmrem.dispose();
  scene.add(sky); // envScene.add で外れるので戻す
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.38; // 夕方の空は暗めなので少し持ち上げる

  // 太陽光（シャドウはプレイヤー周辺だけに絞って解像度を確保する）
  // ゴールデンアワーの暖色。環境光に対して強めにし、影のコントラストを立たせる
  const sunLight = new THREE.DirectionalLight(0xffc587, 3.4);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(4096, 4096);
  const SHADOW_RANGE = 110;
  sunLight.shadow.camera.left = -SHADOW_RANGE;
  sunLight.shadow.camera.right = SHADOW_RANGE;
  sunLight.shadow.camera.top = SHADOW_RANGE;
  sunLight.shadow.camera.bottom = -SHADOW_RANGE;
  sunLight.shadow.camera.near = 1;
  sunLight.shadow.camera.far = 400;
  sunLight.shadow.bias = -0.0006;
  sunLight.shadow.normalBias = 0.5;
  scene.add(sunLight);
  scene.add(sunLight.target);

  // IBL が主のアンビエントになるのでヘミライトは控えめに
  // （強すぎると影が淡くなり立体感が失われる）。夕方の空に合わせて暖色〜薄紫
  const hemiLight = new THREE.HemisphereLight(0xc9b8d8, 0x6e5e3a, 0.4);
  scene.add(hemiLight);

  // 空気遠近感の基準密度（色は空気遠近法シェーダが決めるため fogColor は未使用）
  scene.fog = new THREE.FogExp2(0xe2c8a8, 0.0014);

  // プレイヤー追従でシャドウカメラを動かす
  function followPlayer(playerPos) {
    sunLight.position.copy(playerPos).addScaledVector(sun, 180);
    sunLight.target.position.copy(playerPos);
  }

  return { sunDirection: sun, followPlayer };
}
