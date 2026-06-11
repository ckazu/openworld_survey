import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { WORLD_SIZE, WATER_LEVEL, terrainHeight } from './terrain.js';

const EYE_HEIGHT = 1.7;
const WALK_SPEED = 14;
const RUN_SPEED = 28;
const GRAVITY = 30;
const JUMP_SPEED = 10;
const BOUNDS = WORLD_SIZE / 2 - 12;

export function createPlayer(camera, domElement) {
  const controls = new PointerLockControls(camera, domElement);
  const keys = new Set();
  const velocity = new THREE.Vector3();
  let verticalSpeed = 0;
  let onGround = true;

  window.addEventListener('keydown', (e) => {
    keys.add(e.code);
    if (e.code === 'Space' && onGround && controls.isLocked) {
      verticalSpeed = JUMP_SPEED;
      onGround = false;
    }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));

  function update(dt) {
    const obj = controls.object;

    // 入力方向（カメラ基準）
    const forward = Number(keys.has('KeyW') || keys.has('ArrowUp')) - Number(keys.has('KeyS') || keys.has('ArrowDown'));
    const strafe = Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft'));

    const groundHeight = terrainHeight(obj.position.x, obj.position.z);
    const inWater = groundHeight < WATER_LEVEL - 0.3;
    let speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? RUN_SPEED : WALK_SPEED;
    if (inWater) speed *= 0.45; // 水の中はゆっくり

    const target = new THREE.Vector3();
    if (controls.isLocked && (forward !== 0 || strafe !== 0)) {
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      dir.y = 0;
      dir.normalize();
      const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
      target.addScaledVector(dir, forward).addScaledVector(right, strafe).normalize().multiplyScalar(speed);
    }
    // 加減速をなめらかに
    velocity.lerp(target, 1 - Math.exp(-10 * dt));
    obj.position.addScaledVector(velocity, dt);

    // 世界の外には出さない
    obj.position.x = THREE.MathUtils.clamp(obj.position.x, -BOUNDS, BOUNDS);
    obj.position.z = THREE.MathUtils.clamp(obj.position.z, -BOUNDS, BOUNDS);

    // 接地・ジャンプ。水面下では水面近くに浮かせる
    const floor = Math.max(terrainHeight(obj.position.x, obj.position.z), inWater ? WATER_LEVEL - 0.9 : -Infinity);
    verticalSpeed -= GRAVITY * dt;
    obj.position.y += verticalSpeed * dt;
    if (obj.position.y <= floor + EYE_HEIGHT) {
      obj.position.y = floor + EYE_HEIGHT;
      verticalSpeed = 0;
      onGround = true;
    }
  }

  function spawn(x, z, lookAt) {
    const obj = controls.object;
    obj.position.set(x, terrainHeight(x, z) + EYE_HEIGHT, z);
    if (lookAt) {
      camera.lookAt(lookAt.x, obj.position.y, lookAt.z);
    }
  }

  return { controls, update, spawn };
}
