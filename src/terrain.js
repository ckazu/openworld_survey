import * as THREE from 'three';
import { fbm } from './noise.js';

export const WORLD_SIZE = 800;
export const WATER_LEVEL = -0.6;

// メインの湖。地形をすり鉢状に窪ませて必ず水面下になるようにする
const LAKE = { x: -150, z: 120, radius: 130, depth: 9 };

const SEGMENTS = 512;
const SAND_BAND = 1.6; // 水際から砂浜になる高さの幅

function clamp01(t) {
  return Math.min(1, Math.max(0, t));
}

function smoothstep(t) {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
}

export function terrainHeight(x, z) {
  // なだらかな丘（低周波）＋中くらいのうねり＋細かい起伏（高周波）
  let h = 6;
  h += (fbm(x * 0.0013 + 31, z * 0.0013 + 73, 3) * 2 - 1) * 16;
  h += (fbm(x * 0.0032 + 17, z * 0.0032 + 43, 3) * 2 - 1) * 9;
  h += (fbm(x * 0.006 + 7, z * 0.006 + 11, 4) * 2 - 1) * 4;

  // 湖の窪み。距離をノイズで歪ませて自然な湖岸線にする
  const warp = (fbm(x * 0.008 + 200, z * 0.008 + 300, 3) - 0.5) * 90;
  const d = Math.hypot(x - LAKE.x, z - LAKE.z) + warp;
  const lakeT = smoothstep(1 - d / LAKE.radius);
  h = h * (1 - lakeT) + -LAKE.depth * lakeT;

  // 外周は山で囲い、世界の縁を自然に見せる（高さにムラをつけて壁っぽさを消す）
  const edge = Math.max(Math.abs(x), Math.abs(z)) / (WORLD_SIZE / 2);
  h += smoothstep((edge - 0.74) / 0.26) * (38 + fbm(x * 0.012, z * 0.012, 3) * 36);

  return h;
}

// 森の密度 0..1（植生配置と地面の色合いで共有）
export function forestDensity(x, z) {
  return fbm(x * 0.004 + 500, z * 0.004 + 900, 3);
}

export function terrainSlope(x, z) {
  const e = 1.5;
  const dx = terrainHeight(x + e, z) - terrainHeight(x - e, z);
  const dz = terrainHeight(x, z + e) - terrainHeight(x, z - e);
  return Math.hypot(dx, dz) / (2 * e);
}

export function createTerrain() {
  const geometry = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, SEGMENTS, SEGMENTS);
  geometry.rotateX(-Math.PI / 2);

  const pos = geometry.attributes.position;

  // パス 1: 高さを設定し、法線を計算（傾斜は法線から取ると 1 頂点 4 回の高さ評価を節約できる）
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, terrainHeight(pos.getX(i), pos.getZ(i)));
  }
  geometry.computeVertexNormals();

  // パス 2: 高さ・傾斜に応じた頂点カラー
  const normals = geometry.attributes.normal;
  const colors = new Float32Array(pos.count * 3);

  const grassA = new THREE.Color(0x6f9747); // 黄緑寄りの暖かい草原（彩度は控えめ）
  const grassB = new THREE.Color(0x4c7331);
  const grassDry = new THREE.Color(0x9aa64b); // 乾いた草の差し色
  const forestFloor = new THREE.Color(0x44682c);
  const sand = new THREE.Color(0xcfc08d);
  const foam = new THREE.Color(0xe8e2cd);
  const rock = new THREE.Color(0x877f6f);
  const snow = new THREE.Color(0xf2f4f0);
  const tmp = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = pos.getY(i);

    const ny = normals.getY(i);
    const slope = Math.sqrt(Math.max(0, 1 - ny * ny)) / Math.max(ny, 0.01); // ≒ tan(傾斜角)
    const variation = fbm(x * 0.02, z * 0.02, 3, 7);

    if (h < WATER_LEVEL + SAND_BAND) {
      // 砂浜〜湖底
      tmp.copy(sand).lerp(new THREE.Color(0x9b8d62), clamp01((WATER_LEVEL - h) / 6));
      // 水際の白い縁（泡の帯）
      const foamBand = 1 - clamp01(Math.abs(h - WATER_LEVEL) / 0.3);
      tmp.lerp(foam, foamBand * 0.6);
    } else if (slope > 1.1 || h > 32) {
      tmp.copy(rock);
      tmp.lerp(new THREE.Color(0x6e6657), variation * 0.5);
      if (h > 44) tmp.lerp(snow, clamp01((h - 44) / 8));
    } else {
      tmp.copy(grassA).lerp(grassB, variation);
      // 大きなパッチで乾草色を混ぜて単調さを消す
      const dry = fbm(x * 0.006 + 320, z * 0.006 + 740, 2);
      tmp.lerp(grassDry, clamp01((dry - 0.52) * 2.2) * 0.5);
      // 森の中は地面を少し暗く
      tmp.lerp(forestFloor, clamp01((forestDensity(x, z) - 0.55) * 2.5));
      // 傾斜地は岩を覗かせる
      tmp.lerp(rock, clamp01((slope - 0.65) / 0.45) * 0.8);
      // 砂浜との境目をなじませる
      const sandBlend = clamp01(1 - (h - (WATER_LEVEL + SAND_BAND)) / 1.2);
      tmp.lerp(sand, sandBlend * 0.7);
    }

    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1.0,
    metalness: 0,
  });

  // ワールド座標ベースのディテールノイズ。頂点カラーの解像度を超える近距離の質感を出す
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDetailPos;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvDetailPos = (modelMatrix * vec4(position, 1.0)).xyz;'
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vDetailPos;
        float thash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
        float tnoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(thash(i), thash(i + vec2(1.0, 0.0)), f.x),
            mix(thash(i + vec2(0.0, 1.0)), thash(i + vec2(1.0, 1.0)), f.x),
            f.y
          );
        }`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float dnMid = tnoise(vDetailPos.xz * 0.9);
        float dnLarge = tnoise(vDetailPos.xz * 0.16);
        float dnFine = tnoise(vDetailPos.xz * 4.5);
        diffuseColor.rgb *= 0.86 + dnLarge * 0.14 + dnMid * 0.10 + dnFine * 0.06;
        // 近距離フェード（遠景はディテールを消してちらつきを防ぐ）
        float detailFade = 1.0 - smoothstep(25.0, 80.0, length(vViewPosition));
        // 草地（G が支配的な色）にだけ、中周波パッチで土の色むらを混ぜる
        float grassy = step(diffuseColor.r, diffuseColor.g) * step(diffuseColor.b, diffuseColor.g);
        float soilPatch = smoothstep(0.52, 0.78, tnoise(vDetailPos.xz * 1.3 + 37.0))
                        * (0.6 + 0.4 * tnoise(vDetailPos.xz * 5.0));
        // 近距離は草の根元の土が覗くイメージで常時薄く、パッチ部はさらに濃く
        diffuseColor.rgb = mix(
          diffuseColor.rgb,
          diffuseColor.rgb * vec3(0.72, 0.6, 0.45),
          grassy * detailFade * (0.22 + soilPatch * 0.4)
        );`
      )
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        // tnoise の勾配から微細法線を作り、近距離だけバンプを効かせる
        {
          float bFade = 1.0 - smoothstep(25.0, 80.0, length(vViewPosition));
          if (bFade > 0.001) {
            const float be = 0.1;
            vec2 bp = vDetailPos.xz * 9.0;
            float bC = tnoise(bp) * 0.6 + tnoise(bp * 3.1) * 0.4;
            float bX = tnoise(bp + vec2(be, 0.0)) * 0.6 + tnoise((bp + vec2(be, 0.0)) * 3.1) * 0.4;
            float bZ = tnoise(bp + vec2(0.0, be)) * 0.6 + tnoise((bp + vec2(0.0, be)) * 3.1) * 0.4;
            vec3 bumpWorld = normalize(vec3(-(bX - bC) / be, 2.6, -(bZ - bC) / be));
            vec3 bumpView = normalize((viewMatrix * vec4(bumpWorld, 0.0)).xyz);
            normal = normalize(mix(normal, bumpView, 0.45 * bFade));
          }
        }`
      );
  };

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}
