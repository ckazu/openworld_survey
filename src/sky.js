import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

// 空・太陽光・フォグ・環境マップ（IBL）をまとめてセットアップする
export function createSky(scene, renderer) {
  const sky = new Sky();
  sky.scale.setScalar(4000);

  const sun = new THREE.Vector3();
  const elevation = 26; // 度
  const azimuth = 145;
  const phi = THREE.MathUtils.degToRad(90 - elevation);
  const theta = THREE.MathUtils.degToRad(azimuth);
  sun.setFromSphericalCoords(1, phi, theta);

  const u = sky.material.uniforms;
  u.sunPosition.value.copy(sun);
  u.turbidity.value = 7;
  u.rayleigh.value = 2.0;
  u.mieCoefficient.value = 0.005;
  u.mieDirectionalG.value = 0.85;

  // 空を PMREM 化して PBR 材質の環境光（IBL）として使う。
  // Sky は頂点シェーダで far 平面に張り付くので CubeCamera でもクリップされない
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(sky);
  const envRT = pmrem.fromScene(envScene);
  pmrem.dispose();
  scene.add(sky); // envScene.add で外れるので戻す
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.42;

  // 太陽光（シャドウはプレイヤー周辺だけに絞って解像度を確保する）
  const sunLight = new THREE.DirectionalLight(0xffe9c4, 2.4);
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
  const hemiLight = new THREE.HemisphereLight(0xbfd8ec, 0x5a6e4a, 0.55);
  scene.add(hemiLight);

  // 青みがかった空気遠近感
  scene.fog = new THREE.FogExp2(0xb4d0e4, 0.0017);

  // プレイヤー追従でシャドウカメラを動かす
  function followPlayer(playerPos) {
    sunLight.position.copy(playerPos).addScaledVector(sun, 180);
    sunLight.target.position.copy(playerPos);
  }

  return { sunDirection: sun, followPlayer };
}
