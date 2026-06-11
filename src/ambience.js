import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { WORLD_SIZE, terrainHeight } from './terrain.js';
import { mulberry32 } from './noise.js';

// 世界に「生きている感」を足す要素: 流れる雲・旋回する鳥の群れ・プレイヤー周辺の蝶

const rand = mulberry32(0xc10d5);

// ---------------------------------------------------------------- 雲

function createClouds() {
  const group = new THREE.Group();
  const material = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    emissive: 0x848e98,
    transparent: true,
    opacity: 0.85,
  });
  material.reflectivity = 0;

  const clouds = [];
  for (let i = 0; i < 14; i++) {
    const blobs = [];
    const blobCount = 3 + Math.floor(rand() * 4);
    for (let b = 0; b < blobCount; b++) {
      // mergeVertices でスムースシェーディングにして、もくもくした雲にする
      const blob = BufferGeometryUtils.mergeVertices(new THREE.IcosahedronGeometry(4 + rand() * 5, 1));
      blob.scale(1.6, 0.55, 1.1);
      blob.translate((b - blobCount / 2) * 6 + rand() * 3, rand() * 2.5, (rand() - 0.5) * 6);
      blobs.push(blob);
    }
    const cloudGeometry = BufferGeometryUtils.mergeGeometries(blobs);
    cloudGeometry.computeVertexNormals(); // 非一様スケール後の法線を整える
    const mesh = new THREE.Mesh(cloudGeometry, material);
    const scale = 1.5 + rand() * 2.5;
    mesh.scale.setScalar(scale);
    mesh.position.set(
      (rand() - 0.5) * WORLD_SIZE * 1.4,
      135 + rand() * 55,
      (rand() - 0.5) * WORLD_SIZE * 1.4
    );
    // 雲は反射に映すと綺麗なのでレイヤー 0 のまま
    group.add(mesh);
    clouds.push({ mesh, speed: 1.2 + rand() * 1.6 });
  }

  function update(dt) {
    const limit = WORLD_SIZE * 0.75;
    for (const c of clouds) {
      c.mesh.position.x += c.speed * dt;
      if (c.mesh.position.x > limit) c.mesh.position.x = -limit;
    }
  }

  return { group, update };
}

// ---------------------------------------------------------------- 鳥

function createBirdMesh(material) {
  // 三角形 2 枚の翼。フレームごとに z 回転させて羽ばたかせる
  const wingGeometry = new THREE.BufferGeometry();
  wingGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, -0.25, 0, 0, 0.25, 1.6, 0.15, 0], 3)
  );
  wingGeometry.computeVertexNormals();

  const bird = new THREE.Group();
  const left = new THREE.Mesh(wingGeometry, material);
  const right = new THREE.Mesh(wingGeometry, material);
  right.scale.x = -1;
  bird.add(left, right);
  bird.userData.wings = { left, right };
  return bird;
}

function createBirds() {
  const group = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({ color: 0x2a2c30, side: THREE.DoubleSide });

  const flocks = [];
  for (let f = 0; f < 3; f++) {
    const center = new THREE.Vector3((rand() - 0.5) * 500, 55 + rand() * 35, (rand() - 0.5) * 500);
    const radius = 50 + rand() * 60;
    const speed = (0.08 + rand() * 0.06) * (rand() > 0.5 ? 1 : -1);
    const birds = [];
    const count = 5 + Math.floor(rand() * 5);
    for (let i = 0; i < count; i++) {
      const bird = createBirdMesh(material);
      bird.scale.setScalar(0.8 + rand() * 0.5);
      group.add(bird);
      birds.push({ bird, phase: rand() * Math.PI * 2, offset: new THREE.Vector3((rand() - 0.5) * 14, (rand() - 0.5) * 6, (rand() - 0.5) * 14) });
    }
    flocks.push({ center, radius, speed, birds, angle: rand() * Math.PI * 2 });
  }

  function update(dt, time) {
    for (const flock of flocks) {
      flock.angle += flock.speed * dt;
      for (const { bird, phase, offset } of flock.birds) {
        const a = flock.angle + phase * 0.3;
        bird.position.set(
          flock.center.x + Math.cos(a) * flock.radius + offset.x,
          flock.center.y + offset.y + Math.sin(time * 0.7 + phase) * 2,
          flock.center.z + Math.sin(a) * flock.radius + offset.z
        );
        // 進行方向を向く
        bird.rotation.y = -a - Math.PI / 2 * Math.sign(flock.speed);
        // 翼は +x 方向に伸びているので z 回転で上下に羽ばたく（右翼は scale.x=-1 なので符号反転）
        const flap = Math.sin(time * 9 + phase * 7) * 0.55;
        bird.userData.wings.left.rotation.z = flap;
        bird.userData.wings.right.rotation.z = -flap;
      }
    }
  }

  return { group, update };
}

// ---------------------------------------------------------------- 蝶

function createButterflies() {
  const group = new THREE.Group();
  const wingGeometry = new THREE.PlaneGeometry(0.22, 0.3);
  wingGeometry.translate(0.11, 0, 0);
  const palette = [0xffffff, 0xffd966, 0xe69ad8, 0x9ad8e6];
  const materials = palette.map(
    (c) => new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide })
  );

  const butterflies = [];
  for (let i = 0; i < 22; i++) {
    const material = materials[Math.floor(rand() * materials.length)];
    const body = new THREE.Group();
    const left = new THREE.Mesh(wingGeometry, material);
    const right = new THREE.Mesh(wingGeometry, material);
    right.rotation.y = Math.PI;
    body.add(left, right);
    body.scale.setScalar(0.55 + rand() * 0.3);
    group.add(body);
    butterflies.push({
      body,
      left,
      right,
      anchor: new THREE.Vector3(),
      placed: false,
      phase: rand() * Math.PI * 2,
      speed: 0.5 + rand() * 0.5,
    });
  }

  function update(dt, time, playerPos) {
    for (const b of butterflies) {
      // プレイヤーから離れすぎたら近くに置き直す
      if (!b.placed || b.anchor.distanceTo(playerPos) > 55) {
        const a = rand() * Math.PI * 2;
        const r = 8 + rand() * 35;
        b.anchor.set(playerPos.x + Math.cos(a) * r, 0, playerPos.z + Math.sin(a) * r);
        b.anchor.y = terrainHeight(b.anchor.x, b.anchor.z) + 0.8 + rand() * 0.8;
        b.placed = true;
      }
      const t = time * b.speed + b.phase;
      b.body.position.set(
        b.anchor.x + Math.sin(t * 0.7) * 3 + Math.sin(t * 1.7) * 1.2,
        b.anchor.y + Math.sin(t * 1.3) * 0.6,
        b.anchor.z + Math.cos(t * 0.9) * 3 + Math.cos(t * 2.1) * 1.2
      );
      b.body.rotation.y = t * 0.4;
      const flap = Math.sin(time * 16 + b.phase) * 1.0;
      b.left.rotation.y = flap;
      b.right.rotation.y = Math.PI - flap;
    }
  }

  return { group, update };
}

// ----------------------------------------------------------------

export function createAmbience() {
  const group = new THREE.Group();
  const clouds = createClouds();
  const birds = createBirds();
  const butterflies = createButterflies();
  group.add(clouds.group, birds.group, butterflies.group);

  function update(dt, time, playerPos) {
    clouds.update(dt);
    birds.update(dt, time);
    butterflies.update(dt, time, playerPos);
  }

  return { group, update };
}
