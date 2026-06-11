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

// --- Canvas 2D によるアルファカットアウトテクスチャ ---
// ベタ塗りカードを「葉の塊」「先の尖った草」に見せるための輪郭抜き。
// RGB はインスタンスカラー/頂点カラーで変調する前提の控えめな明度差のみ持つ。

function makeCanvas(size) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  return canvas;
}

// 先の尖った楕円（葉形）を 1 枚描く
function drawLeafShape(ctx, x, y, len, wid, angle, fill) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, -len / 2);
  ctx.quadraticCurveTo(wid / 2, 0, 0, len / 2);
  ctx.quadraticCurveTo(-wid / 2, 0, 0, -len / 2);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
}

let _leafCluster = null;

// 葉群: 透明背景に小さな葉形を多数重ねた「茂みの塊」。
// カード中心ほど密、外周ほど疎にして輪郭を不規則に切る。
export function leafClusterTexture() {
  if (_leafCluster) return _leafCluster;
  const size = 256;
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  let s = 12345;
  const rnd = () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = 0; i < 38; i++) {
    // 中心バイアスのある配置（外周は疎らに）。枚数を絞って透かしを作り、
    // 1 枚 1 枚を大きくして「葉」として読めるシルエットにする
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * size * 0.4;
    const x = size / 2 + Math.cos(a) * r;
    const y = size / 2 + Math.sin(a) * r;
    const len = size * (0.24 + rnd() * 0.18);
    const wid = len * (0.4 + rnd() * 0.22);
    // 明度差で葉の重なりを感じさせる（緑味はマテリアル側の色で決まる）
    const v = 180 + Math.floor(rnd() * 70);
    drawLeafShape(ctx, x, y, len, wid, rnd() * Math.PI * 2, `rgb(${v - 25},${v},${v - 45})`);
  }
  _leafCluster = new THREE.CanvasTexture(canvas);
  _leafCluster.colorSpace = THREE.SRGBColorSpace;
  return _leafCluster;
}

let _grassBlade = null;

// 草ブレード: 下辺から上端の一点へ収束する葉形。中央に薄い葉脈。
export function grassBladeTexture() {
  if (_grassBlade) return _grassBlade;
  const size = 128;
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  // 輪郭（下辺の幅 → 上端の一点）。左右をベジェで軽く膨らませる
  ctx.beginPath();
  ctx.moveTo(size * 0.18, size);
  ctx.quadraticCurveTo(size * 0.3, size * 0.35, size * 0.5, 0);
  ctx.quadraticCurveTo(size * 0.7, size * 0.35, size * 0.82, size);
  ctx.closePath();
  ctx.fillStyle = 'rgb(225,235,210)';
  ctx.fill();
  // 中央の葉脈をわずかに暗く
  ctx.strokeStyle = 'rgba(140,160,120,0.55)';
  ctx.lineWidth = size * 0.05;
  ctx.beginPath();
  ctx.moveTo(size * 0.5, size);
  ctx.lineTo(size * 0.5, size * 0.04);
  ctx.stroke();
  _grassBlade = new THREE.CanvasTexture(canvas);
  _grassBlade.colorSpace = THREE.SRGBColorSpace;
  return _grassBlade;
}
