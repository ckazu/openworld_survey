import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { createTerrain, terrainHeight, forestDensity } from './terrain.js';
import { createWater } from './water.js';
import { createSky } from './sky.js';
import { createVegetation } from './vegetation.js';
import { createGrassField } from './grass.js';
import { createAmbience } from './ambience.js';
import { createPlayer } from './player.js';

const app = document.getElementById('app');
const overlay = document.getElementById('overlay');
const hud = document.getElementById('hud');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.5;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 3000);
// レイヤー 1 = 水面反射に映さないオブジェクト（草・花）
camera.layers.enable(1);

// 共有ユニフォーム（草の揺れアニメーション・サブサーフェス透過）
const sharedUniforms = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3() },
  uSunColor: { value: new THREE.Color(0xffe9c4) },
};

const { sunDirection, followPlayer } = createSky(scene, renderer);
sharedUniforms.uSunDir.value.copy(sunDirection);
scene.add(createTerrain());
const water = createWater(sunDirection, sharedUniforms);
scene.add(water);
scene.add(createVegetation(sharedUniforms));
const grass = createGrassField(sharedUniforms);
scene.add(grass.group);
const ambience = createAmbience();
scene.add(ambience.group);

const player = createPlayer(camera, renderer.domElement);
scene.add(player.controls.object);
// 湖が見える丘の上からスタート
player.spawn(-20, 120, { x: -150, z: 120 });

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
composer.addPass(gtaoPass);

const bloomPass = new UnrealBloomPass(new THREE.Vector2(size.width, size.height), 0.25, 0.7, 0.85);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// 仕上げのカラーグレーディング（彩度・コントラスト・ビネット）
const gradePass = new ShaderPass({
  name: 'ColorGradeShader',
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(l), c.rgb, 1.16);            // 彩度を少し上げる
      c.rgb = (c.rgb - 0.5) * 1.05 + 0.5 + 0.005;   // 微コントラスト
      float d = distance(vUv, vec2(0.5));
      c.rgb *= 1.0 - smoothstep(0.5, 1.0, d) * 0.22; // ビネット
      gl_FragColor = c;
    }
  `,
});
composer.addPass(gradePass);

overlay.addEventListener('click', () => player.controls.lock());
player.controls.addEventListener('lock', () => overlay.classList.add('hidden'));
player.controls.addEventListener('unlock', () => overlay.classList.remove('hidden'));

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  gtaoPass.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
let hudTimer = 0;

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;

  sharedUniforms.uTime.value = time;
  water.userData.update(time);
  if (!window.__demo?.freeze) player.update(dt);
  grass.update(camera.position);
  ambience.update(dt, time, camera.position);
  followPlayer(camera.position);

  hudTimer += dt;
  if (hudTimer > 0.25) {
    hudTimer = 0;
    const p = camera.position;
    hud.textContent = `x: ${p.x.toFixed(0)}  z: ${p.z.toFixed(0)}`;
  }

  composer.render();
});

// 動作検証用の内部フック
window.__demo = { camera, scene, renderer, player, terrainHeight, forestDensity };
