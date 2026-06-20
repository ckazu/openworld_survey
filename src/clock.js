// シミュレーション時計：実時間 dt に倍率を掛けて simDate を進める。
// 緯度経度・日時・速度倍率・一時停止を保持する単一の状態源。

export const SPEED_PRESETS = [
  { label: '1倍 (実時間)', mult: 1 },
  { label: '60倍 (1分=1時間)', mult: 60 },
  { label: '144倍 (10分=24時間)', mult: 144 },
  { label: '600倍', mult: 600 },
  { label: '3600倍 (1秒=1時間)', mult: 3600 },
];

export const CITY_PRESETS = [
  { label: '東京', lat: 35.6812, lon: 139.7671 },
  { label: 'ロンドン', lat: 51.5074, lon: -0.1278 },
  { label: 'ニューヨーク', lat: 40.7128, lon: -74.006 },
  { label: 'シドニー', lat: -33.8688, lon: 151.2093 },
  { label: 'レイキャビク', lat: 64.1466, lon: -21.9426 },
  { label: '赤道 (キト)', lat: -0.1807, lon: -78.4678 },
];

export function createSimClock(opts = {}) {
  const state = {
    latitude: opts.latitude ?? 35.6812,
    longitude: opts.longitude ?? 139.7671,
    simDate: opts.simDate ? new Date(opts.simDate) : new Date(),
    speedMultiplier: opts.speedMultiplier ?? 144,
    paused: false,
  };

  function advance(dt) {
    if (state.paused) return;
    state.simDate = new Date(state.simDate.getTime() + dt * 1000 * state.speedMultiplier);
  }

  function set(patch) {
    if (patch.latitude !== undefined) state.latitude = patch.latitude;
    if (patch.longitude !== undefined) state.longitude = patch.longitude;
    if (patch.speedMultiplier !== undefined) state.speedMultiplier = patch.speedMultiplier;
    if (patch.simDate !== undefined) state.simDate = new Date(patch.simDate);
    if (patch.paused !== undefined) state.paused = patch.paused;
  }

  function setNow() {
    state.simDate = new Date();
  }

  function togglePause() {
    state.paused = !state.paused;
    return state.paused;
  }

  function speedLabel() {
    const p = SPEED_PRESETS.find((s) => s.mult === state.speedMultiplier);
    return p ? p.label : `${state.speedMultiplier}倍`;
  }

  return { state, advance, set, setNow, togglePause, speedLabel };
}
