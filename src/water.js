import * as THREE from 'three';
import { Water } from 'three/addons/objects/Water.js';
import { WORLD_SIZE, WATER_LEVEL } from './terrain.js';
import { tileableFbm } from './noise.js';

// three の Water（平面リフレクション）を使った反射する水面。
// 法線マップは外部画像に頼らず、タイル化可能ノイズから生成する。

function generateWaterNormals(size = 256) {
  const period = 10;
  const heights = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      heights[y * size + x] = tileableFbm((x / size) * period, (y / size) * period, period, 4, 42);
    }
  }

  const data = new Uint8Array(size * size * 4);
  const strength = 3.0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xp = (x + 1) % size;
      const xm = (x - 1 + size) % size;
      const yp = (y + 1) % size;
      const ym = (y - 1 + size) % size;
      const dx = (heights[y * size + xp] - heights[y * size + xm]) * strength;
      const dy = (heights[yp * size + x] - heights[ym * size + x]) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * size + x) * 4;
      data[i] = (-dx * inv * 0.5 + 0.5) * 255;
      data[i + 1] = (-dy * inv * 0.5 + 0.5) * 255;
      data[i + 2] = inv * 255;
      data[i + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

export function createWater(sunDirection) {
  const geometry = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE);

  const water = new Water(geometry, {
    textureWidth: 1024,
    textureHeight: 1024,
    waterNormals: generateWaterNormals(),
    sunDirection: sunDirection.clone(),
    sunColor: 0xfff0dd,
    waterColor: 0x126180,
    distortionScale: 1.6,
    alpha: 0.96,
    fog: true,
  });

  water.rotation.x = -Math.PI / 2;
  water.position.y = WATER_LEVEL;
  water.name = 'water';

  // 波紋のスケールをワールドサイズに合わせて細かくする
  water.material.uniforms.size.value = 4.0;
  water.material.transparent = true;

  water.userData.update = (time) => {
    water.material.uniforms.time.value = time * 0.5;
  };

  return water;
}
