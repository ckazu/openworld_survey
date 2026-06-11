import * as THREE from 'three';
import { tileableFbm } from './noise.js';

// ノイズから実行時に PBR マップ（DataTexture）を生成するユーティリティ。
// 外部画像に一切依存しない、というワールド全体の方針をここで担保する。
// 生成は初期化時に一度だけ。テクスチャは material 間で共有してメモリを節約する。

// 高さ場 heightFn(u, v)（u, v は 0..1）をスケールしたグリッドでサンプリングし、
// Sobel 演算子で接空間法線（tangent-space normal, +Z が法線方向）を求める。
// strength で凹凸の強さを調整する。RepeatWrapping で継ぎ目なくタイリング可能。
export function generateNormalMap(size, heightFn, strength = 1.0) {
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => heightFn(((x % size) + size) % size / size, ((y % size) + size) % size / size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 3x3 Sobel で勾配を求める（テクセル間隔を 1 とする）
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);

      // 勾配から法線を構成して正規化（[-1,1] → [0,1] にエンコード）
      const nx = -dx * strength;
      const ny = -dy * strength;
      const nz = 1.0;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 4;
      data[i] = (nx * inv * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      data[i + 2] = (nz * inv * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// グレースケールのスカラーマップ（ラフネス等）を生成する。
// valueFn(u, v) は 0..1 を返す。
function generateScalarMap(size, valueFn) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = Math.max(0, Math.min(1, valueFn(x / size, y / size))) * 255;
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// --- プリセット（モジュール間で共有する単一インスタンス） ---

let _barkNormal = null;
let _rockNormal = null;
let _rockRoughness = null;

// 樹皮: 縦に走る溝を主成分にしたタイル化ノイズ。
// v 方向（縦）に高周波、u 方向（横）にうねりを持たせて樹皮の筋を表現する。
export function barkNormalMap() {
  if (_barkNormal) return _barkNormal;
  const period = 8;
  _barkNormal = generateNormalMap(256, (u, v) => {
    const grooves = tileableFbm(u * period + tileableFbm(u * period, v * period, period, 2, 7) * 0.6,
                                v * period * 4, period, 4, 3);
    return grooves;
  }, 2.2);
  return _barkNormal;
}

// 岩肌: 多重スケールの起伏で割れ目・ザラつきを表現する。
export function rockNormalMap() {
  if (_rockNormal) return _rockNormal;
  const period = 6;
  _rockNormal = generateNormalMap(256, (u, v) => {
    const base = tileableFbm(u * period, v * period, period, 5, 17);
    const cracks = Math.abs(tileableFbm(u * period * 2, v * period * 2, period * 2, 3, 23) - 0.5);
    return base * 0.7 + (0.5 - cracks) * 0.3;
  }, 2.6);
  return _rockNormal;
}

export function rockRoughnessMap() {
  if (_rockRoughness) return _rockRoughness;
  const period = 6;
  _rockRoughness = generateScalarMap(256, (u, v) => {
    return 0.78 + tileableFbm(u * period * 3, v * period * 3, period * 3, 3, 31) * 0.22;
  });
  return _rockRoughness;
}
