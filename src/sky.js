import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { WATER_LEVEL } from './terrain.js';

// 高さフォグ: fog チャンクをグローバルにパッチし、フォグ密度を
// 「ワールド高さで指数減衰」させる。湖面・谷に溜まる朝もやが出る。
// fog: true の全マテリアル（地形・木・草・水・雲）に一括で効く。
// マテリアルのコンパイル前（モジュール読み込み時）に差し替えること。
THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying float vFogWorldY;
#endif`;
THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  // transformed はカスタム ShaderMaterial（水・雲）に存在しないため
  // 属性 position を使う（風の曲げ分の高さ誤差はもやには無視できる）
  vec4 fogWorldPos = vec4( position, 1.0 );
  #ifdef USE_INSTANCING
    fogWorldPos = instanceMatrix * fogWorldPos;
  #endif
  vFogWorldY = ( modelMatrix * fogWorldPos ).y;
#endif`;
THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying float vFogWorldY;
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
    // 水面の高さを基準に、低いところほどフォグを濃くする（朝もや）
    float fogHeight = exp( -max( 0.0, vFogWorldY - ${WATER_LEVEL.toFixed(2)} ) * 0.16 );
    float fogDensityH = fogDensity * ( 1.0 + fogHeight * 2.6 );
    float fogFactor = 1.0 - exp( - fogDensityH * fogDensityH * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`;

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

  // 夕方の暖色がかった空気遠近感
  scene.fog = new THREE.FogExp2(0xe2c8a8, 0.0019);

  // プレイヤー追従でシャドウカメラを動かす
  function followPlayer(playerPos) {
    sunLight.position.copy(playerPos).addScaledVector(sun, 180);
    sunLight.target.position.copy(playerPos);
  }

  return { sunDirection: sun, followPlayer };
}
