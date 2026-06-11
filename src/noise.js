// 決定論的な 2D 値ノイズと fBm。
// 地形生成と植生配置の両方から同じ関数を参照するため、依存ライブラリなしで自前実装する。

function hash2(ix, iz, seed) {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function smooth(t) {
  // quintic smoothstep（C2 連続なので法線が滑らかになる）
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function valueNoise(x, z, seed = 0) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const v00 = hash2(ix, iz, seed);
  const v10 = hash2(ix + 1, iz, seed);
  const v01 = hash2(ix, iz + 1, seed);
  const v11 = hash2(ix + 1, iz + 1, seed);
  const sx = smooth(fx);
  const sz = smooth(fz);
  const a = v00 + (v10 - v00) * sx;
  const b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sz; // 0..1
}

export function fbm(x, z, octaves = 4, seed = 0) {
  let total = 0;
  let amplitude = 1;
  let frequency = 1;
  let max = 0;
  for (let i = 0; i < octaves; i++) {
    total += valueNoise(x * frequency, z * frequency, seed + i * 101) * amplitude;
    max += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return total / max; // 0..1
}

// 周期 period でループするタイル化可能ノイズ（リピートテクスチャ生成用）
export function tileableValueNoise(x, z, period, seed = 0) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const w = (v) => ((v % period) + period) % period;
  const v00 = hash2(w(ix), w(iz), seed);
  const v10 = hash2(w(ix + 1), w(iz), seed);
  const v01 = hash2(w(ix), w(iz + 1), seed);
  const v11 = hash2(w(ix + 1), w(iz + 1), seed);
  const sx = smooth(fx);
  const sz = smooth(fz);
  const a = v00 + (v10 - v00) * sx;
  const b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sz; // 0..1
}

export function tileableFbm(x, z, period, octaves = 4, seed = 0) {
  let total = 0;
  let amplitude = 1;
  let frequency = 1;
  let max = 0;
  for (let i = 0; i < octaves; i++) {
    total += tileableValueNoise(x * frequency, z * frequency, period * frequency, seed + i * 131) * amplitude;
    max += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return total / max; // 0..1
}

// 再現性のある疑似乱数（植生のばら撒きに使用）
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
