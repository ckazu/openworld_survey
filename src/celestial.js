import * as THREE from 'three';

// ============================================================================
// 天文計算（Schlyter "How to compute planetary positions" ベース、外部ライブラリ不使用）
//
// 緯度経度・日時(UTC)から太陽・月の地平座標（高度・方位）と月相を計算する純関数群。
// 太陽・月・星は同一の恒星時 gmst() を共有するため、互いにずれない。
//
// 座標規約（sun/moon/stars で共通）:
//   ワールド: 北 = -Z, 東 = +X, 上 = +Y, 南 = +Z
//   方位: 北から時計回り（東向き）にラジアン
//   altAzToVector が唯一の変換。
// ============================================================================

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const rev = (x) => x - Math.floor(x / 360) * 360; // 0..360 に正規化
const sind = (x) => Math.sin(x * RAD);
const cosd = (x) => Math.cos(x * RAD);
const atan2d = (y, x) => Math.atan2(y, x) * DEG;
const asind = (x) => Math.asin(THREE.MathUtils.clamp(x, -1, 1)) * DEG;
const acosd = (x) => Math.acos(THREE.MathUtils.clamp(x, -1, 1)) * DEG;

// ---- エポック（Schlyter day number, JD 2451543.5 = 1999-12-31 0:00 UT）----
function julianDate(date) {
  return date.getTime() / 86400000 + 2440587.5;
}
function dayNumber(date) {
  return julianDate(date) - 2451543.5; // 時刻の小数を含む
}

// ---- 太陽（赤道座標）----
export function sunEquatorial(date) {
  const d = dayNumber(date);
  const w = 282.9404 + 4.70935e-5 * d; // 近日点黄経
  const e = 0.016709 - 1.151e-9 * d; // 離心率
  const M = rev(356.047 + 0.9856002585 * d); // 平均近点角
  const oblecl = 23.4393 - 3.563e-7 * d; // 黄道傾斜角
  const L = rev(w + M); // 平均黄経

  const E = M + DEG * e * sind(M) * (1 + e * cosd(M)); // 離心近点角
  const x = cosd(E) - e;
  const y = sind(E) * Math.sqrt(1 - e * e);
  const r = Math.hypot(x, y);
  const v = atan2d(y, x); // 真近点角
  const lon = rev(v + w); // 真黄経

  const xs = r * cosd(lon);
  const ys = r * sind(lon);
  // 黄道 → 赤道
  const xe = xs;
  const ye = ys * cosd(oblecl);
  const ze = ys * sind(oblecl);
  const RA = rev(atan2d(ye, xe));
  const Dec = asind(ze / Math.max(r, 1e-9));
  return { RA, Dec, lon, r, meanLon: L, M };
}

// ---- 月（赤道座標。主要摂動項込みで ~数分角の精度、地心）----
export function moonEquatorial(date) {
  const d = dayNumber(date);
  const N = rev(125.1228 - 0.0529538083 * d); // 昇交点黄経
  const i = 5.1454; // 軌道傾斜
  const w = rev(318.0634 + 0.1643573223 * d); // 近地点引数
  const a = 60.2666; // 平均距離（地球半径）
  const e = 0.0549; // 離心率
  const M = rev(115.3654 + 13.0649929509 * d); // 平均近点角

  // 離心近点角（月は e が大きいので反復）
  let E = M + DEG * e * sind(M) * (1 + e * cosd(M));
  for (let k = 0; k < 3; k++) {
    E = E - (E - DEG * e * sind(E) - M) / (1 - e * cosd(E));
  }
  const x = a * (cosd(E) - e);
  const y = a * Math.sqrt(1 - e * e) * sind(E);
  const r0 = Math.hypot(x, y);
  const v = atan2d(y, x);

  // 軌道面 → 黄道直交座標（地心）
  const xeclip = r0 * (cosd(N) * cosd(v + w) - sind(N) * sind(v + w) * cosd(i));
  const yeclip = r0 * (sind(N) * cosd(v + w) + cosd(N) * sind(v + w) * cosd(i));
  const zeclip = r0 * (sind(v + w) * sind(i));
  let lon = atan2d(yeclip, xeclip);
  let lat = atan2d(zeclip, Math.hypot(xeclip, yeclip));
  let rr = Math.sqrt(xeclip * xeclip + yeclip * yeclip + zeclip * zeclip);

  // 摂動（太陽の位置が必要）
  const s = sunEquatorial(date);
  const Ls = s.meanLon; // 太陽平均黄経
  const Ms = s.M; // 太陽平均近点角
  const Lm = rev(N + w + M); // 月平均黄経
  const Mm = M; // 月平均近点角
  const D = rev(Lm - Ls); // 平均離角
  const F = rev(Lm - N); // 緯度引数

  lon +=
    -1.274 * sind(Mm - 2 * D) + // Evection
    0.658 * sind(2 * D) - // Variation
    0.186 * sind(Ms) - // 年差
    0.059 * sind(2 * Mm - 2 * D) -
    0.057 * sind(Mm - 2 * D + Ms) +
    0.053 * sind(Mm + 2 * D) +
    0.046 * sind(2 * D - Ms) +
    0.041 * sind(Mm - Ms) -
    0.035 * sind(D) - // 視差不等
    0.031 * sind(Mm + Ms) -
    0.015 * sind(2 * F - 2 * D) +
    0.011 * sind(Mm - 4 * D);
  lat +=
    -0.173 * sind(F - 2 * D) -
    0.055 * sind(Mm - F - 2 * D) -
    0.046 * sind(Mm + F - 2 * D) +
    0.033 * sind(F + 2 * D) +
    0.017 * sind(2 * Mm + F);
  rr += -0.58 * cosd(Mm - 2 * D) - 0.46 * cosd(2 * D);

  // 黄道 → 赤道
  const oblecl = 23.4393 - 3.563e-7 * d;
  const xh = rr * cosd(lon) * cosd(lat);
  const yh = rr * sind(lon) * cosd(lat);
  const zh = rr * sind(lat);
  const xe = xh;
  const ye = yh * cosd(oblecl) - zh * sind(oblecl);
  const ze = yh * sind(oblecl) + zh * cosd(oblecl);
  const RA = rev(atan2d(ye, xe));
  const Dec = atan2d(ze, Math.hypot(xe, ye));
  return { RA, Dec, lon, lat, distanceEarthRadii: rr, meanLon: s.meanLon, sunLon: s.lon };
}

// ---- 恒星時（sun/moon/stars が共有する唯一の GMST。度を返す）----
function gmst(date, sunMeanLon) {
  const UT =
    date.getUTCHours() +
    date.getUTCMinutes() / 60 +
    date.getUTCSeconds() / 3600 +
    date.getUTCMilliseconds() / 3.6e6;
  const GMST0 = rev(sunMeanLon + 180); // 度（Schlyter: L + 180）
  return rev(GMST0 + UT * 15.0); // 15°/h
}
export function localSiderealTimeDeg(date, lonEastDeg, sunMeanLon) {
  return rev(gmst(date, sunMeanLon) + lonEastDeg);
}

// ---- 赤道座標 → 地平座標（高度・方位）。horizontal と LST は同じ gmst を使う ----
function horizontal(date, RA, Dec, latDeg, lonEastDeg, sunMeanLon) {
  const lstDeg = localSiderealTimeDeg(date, lonEastDeg, sunMeanLon);
  const HA = rev(lstDeg - RA); // 時角（度）
  const sinAlt = sind(Dec) * sind(latDeg) + cosd(Dec) * cosd(latDeg) * cosd(HA);
  const altitude = Math.asin(THREE.MathUtils.clamp(sinAlt, -1, 1));
  const cosAlt = Math.cos(altitude);
  // 北から時計回り（東向き）の方位
  const cosAz = (sind(Dec) - sind(latDeg) * sinAlt) / (cosd(latDeg) * cosAlt + 1e-9);
  let azimuth = Math.acos(THREE.MathUtils.clamp(cosAz, -1, 1)); // 0..π（北基準）
  if (sind(HA) > 0) azimuth = 2 * Math.PI - azimuth; // HA>0（午後・西）は西半分へ
  return { altitude, azimuth };
}

export function sunHorizontal(date, latDeg, lonEastDeg) {
  const s = sunEquatorial(date);
  return { ...horizontal(date, s.RA, s.Dec, latDeg, lonEastDeg, s.meanLon), meanLon: s.meanLon };
}
export function moonHorizontal(date, latDeg, lonEastDeg) {
  const m = moonEquatorial(date);
  return {
    ...horizontal(date, m.RA, m.Dec, latDeg, lonEastDeg, m.meanLon),
    distanceEarthRadii: m.distanceEarthRadii,
    meanLon: m.meanLon,
  };
}

// ---- 月相（輝面比・位相角・満ち欠けの向き）----
const _phase = { illuminatedFraction: 0, phaseAngle: 0, waxing: false };
export function moonPhase(date, out = _phase) {
  const m = moonEquatorial(date);
  // 太陽・月の黄経差（離角）
  const elong = acosd(cosd(m.sunLon - m.lon) * cosd(m.lat)); // 0..180
  const phaseAngle = 180 - elong;
  out.illuminatedFraction = (1 + cosd(phaseAngle)) / 2;
  out.phaseAngle = phaseAngle;
  out.waxing = rev(m.lon - m.sunLon) < 180; // 月が太陽の東 → 上弦へ向かう
  return out;
}

// ---- 高度/方位（ラジアン）→ three.js Y-up ベクトル（北=-Z, 東=+X, 上=+Y）----
export function altAzToVector(altitude, azimuth, out = new THREE.Vector3()) {
  const ca = Math.cos(altitude);
  return out.set(ca * Math.sin(azimuth), Math.sin(altitude), -ca * Math.cos(azimuth));
}

// ============================================================================
// 昼夜のランプ（線形RGB / smoothstep 反転バグ回避）
// ============================================================================
const ss = THREE.MathUtils.smoothstep; // 上昇のみ。min<max を厳守

// 下降ランプ専用。THREE.MathUtils.smoothstep に min>max を渡さない（仕様で反転＝不具合）
export const fall = (x, hi, lo) => 1 - ss(x, lo, hi); // lo 以下で1, hi 以上で0（lo<hi）

// 太陽高度(度)→ 太陽光色（線形）。降順テーブル
const SUN_C = [
  { a: 60, rgb: [1.0, 0.98, 0.95] },
  { a: 30, rgb: [1.0, 0.95, 0.86] },
  { a: 12, rgb: [1.0, 0.83, 0.62] },
  { a: 6, rgb: [1.0, 0.66, 0.4] },
  { a: 2, rgb: [1.0, 0.5, 0.26] },
  { a: 0, rgb: [0.98, 0.38, 0.18] },
];
function rampRGB(table, a, out) {
  const n = table.length;
  if (a >= table[0].a) {
    const c = table[0].rgb;
    return out.setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
  }
  if (a <= table[n - 1].a) {
    const c = table[n - 1].rgb;
    return out.setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
  }
  for (let i = 0; i < n - 1; i++) {
    const hi = table[i];
    const lo = table[i + 1];
    if (a <= hi.a && a >= lo.a) {
      const t = (a - lo.a) / (hi.a - lo.a);
      return out.setRGB(
        lo.rgb[0] + (hi.rgb[0] - lo.rgb[0]) * t,
        lo.rgb[1] + (hi.rgb[1] - lo.rgb[1]) * t,
        lo.rgb[2] + (hi.rgb[2] - lo.rgb[2]) * t,
        THREE.LinearSRGBColorSpace
      );
    }
  }
  return out;
}
export function sunLightColor(a, out = new THREE.Color()) {
  return rampRGB(SUN_C, a, out);
}

// 直射日光の有無。日の出前(地平線下)は 0、日の出(0°)以降に立ち上げる。
// これにより、日の出前は空・稜線が先に明るくなり、地面（フィールド）が先に
// 明るくなる違和感を防ぐ（物理的にも日の出前に直射光はない）
export const kAboveHor = (a) => ss(a, 0, 4);

// フォグ用の太陽放射色 E（= 太陽色 × kAboveHor）
export function sunColorE(a, out = new THREE.Color()) {
  return sunLightColor(Math.max(a, 0), out).multiplyScalar(kAboveHor(a));
}

// 0（昼, +2°以上）→ 1（夜, -8°以下）。下降ランプ
export const nightFactor = (a) => fall(a, 2, -8);

// 汎用スカラーランプ（降順 stops [{a, v}]）
export function rampScalar(stops, a) {
  const n = stops.length;
  if (a >= stops[0].a) return stops[0].v;
  if (a <= stops[n - 1].a) return stops[n - 1].v;
  for (let i = 0; i < n - 1; i++) {
    const hi = stops[i];
    const lo = stops[i + 1];
    if (a <= hi.a && a >= lo.a) {
      const t = (a - lo.a) / (hi.a - lo.a);
      return lo.v + (hi.v - lo.v) * t;
    }
  }
  return stops[n - 1].v;
}
