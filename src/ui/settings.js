import { SPEED_PRESETS, CITY_PRESETS } from '../clock.js';
import { WEATHER_LABELS } from '../weather.js';

// 画面上の設定パネル（依存追加なし・既存のダーク基調に合わせる）。
// 緯度・経度・日時・速度倍率・一時停止を操作。KeyO で開閉し、開くとポインタロックを解除。
// 日時は「現地の太陽時」（経度 lon/15 時間オフセット）で表示・編集する。

const tzOffsetMs = (lon) => (lon / 15) * 3600 * 1000;
const pad = (n, l = 2) => String(n).padStart(l, '0');

function dateToLocalInput(date, lon) {
  const d = new Date(date.getTime() + tzOffsetMs(lon));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function localInputToDate(str, lon) {
  const [dp, tp] = str.split('T');
  if (!dp || !tp) return null;
  const [Y, Mo, D] = dp.split('-').map(Number);
  const [H, Mi] = tp.split(':').map(Number);
  return new Date(Date.UTC(Y, Mo - 1, D, H, Mi) - tzOffsetMs(lon));
}

const CSS = `
#settings {
  position: fixed; top: 14px; right: 14px; z-index: 8;
  width: 290px; padding: 16px 18px; border-radius: 14px;
  background: rgba(8, 18, 26, 0.82); backdrop-filter: blur(8px);
  border: 1px solid rgba(255,255,255,0.12);
  color: #e8f1f5; font-family: "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif;
  font-size: 13px; display: none;
}
#settings.open { display: block; }
#settings h2 { margin: 0 0 12px; font-size: 15px; font-weight: 600; letter-spacing: 0.04em; }
#settings .row { margin: 10px 0; }
#settings label { display: flex; justify-content: space-between; align-items: baseline;
  margin-bottom: 4px; color: #9fd8ff; font-size: 12px; }
#settings label span { color: #e8f1f5; font-variant-numeric: tabular-nums; }
#settings input[type=range] { width: 100%; accent-color: #6fc3ff; }
#settings input[type=datetime-local], #settings select {
  width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 8px;
  background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.16);
  color: #e8f1f5; font-size: 13px; }
#settings .btns { display: flex; gap: 8px; margin-top: 12px; }
#settings button { flex: 1; padding: 7px 0; border-radius: 8px; cursor: pointer;
  background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.18);
  color: #e8f1f5; font-size: 12px; }
#settings button:hover { background: rgba(255,255,255,0.18); }
#settings .hint { margin-top: 10px; font-size: 11px; opacity: 0.6; }
#settings hr { border: none; border-top: 1px solid rgba(255,255,255,0.12); margin: 14px 0 10px; }
#settings .wx-manual[disabled-group] { opacity: 0.4; pointer-events: none; }
`;

export function createSettingsPanel({ clock, controls, overlay, weather }) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const el = document.createElement('div');
  el.id = 'settings';
  el.innerHTML = `
    <h2>🌍 時刻と場所</h2>
    <div class="row">
      <label>都市プリセット</label>
      <select id="st-city"><option value="">—</option>${CITY_PRESETS.map(
        (c, i) => `<option value="${i}">${c.label}</option>`
      ).join('')}</select>
    </div>
    <div class="row">
      <label>緯度 <span id="st-lat-v"></span></label>
      <input id="st-lat" type="range" min="-90" max="90" step="0.1">
    </div>
    <div class="row">
      <label>経度 <span id="st-lon-v"></span></label>
      <input id="st-lon" type="range" min="-180" max="180" step="0.1">
    </div>
    <div class="row">
      <label>日時（現地の太陽時）</label>
      <input id="st-date" type="datetime-local">
    </div>
    <div class="row">
      <label>経過速度</label>
      <select id="st-speed">${SPEED_PRESETS.map(
        (s) => `<option value="${s.mult}">${s.label}</option>`
      ).join('')}</select>
    </div>
    <div class="btns">
      <button id="st-now">現在時刻</button>
      <button id="st-pause">一時停止</button>
    </div>
    <hr>
    <h2>🌦 天候</h2>
    <div class="row">
      <label>モード</label>
      <select id="wx-mode"><option value="auto">自動</option><option value="manual">手動</option></select>
    </div>
    <div class="row">
      <label>天候 <span id="wx-now"></span></label>
      <select id="wx-preset" class="wx-manual">${Object.entries(WEATHER_LABELS).map(
        ([k, label]) => `<option value="${k}">${label}</option>`
      ).join('')}</select>
    </div>
    <div class="row"><label>強度 <span id="wx-int-v"></span></label><input id="wx-int" class="wx-manual" type="range" min="0" max="1.5" step="0.01"></div>
    <div class="row"><label>雲量 <span id="wx-cloud-v"></span></label><input id="wx-cloud" class="wx-manual" type="range" min="0" max="1" step="0.01"></div>
    <div class="row"><label>降水 <span id="wx-precip-v"></span></label><input id="wx-precip" class="wx-manual" type="range" min="0" max="1" step="0.01"></div>
    <div class="row"><label>霧 <span id="wx-fog-v"></span></label><input id="wx-fog" class="wx-manual" type="range" min="0" max="1" step="0.01"></div>
    <div class="row"><label>風 <span id="wx-wind-v"></span></label><input id="wx-wind" class="wx-manual" type="range" min="0" max="2" step="0.01"></div>
    <div class="hint">O キーで開閉</div>`;
  document.body.appendChild(el);

  const $ = (id) => el.querySelector(id);
  const latEl = $('#st-lat');
  const lonEl = $('#st-lon');
  const latV = $('#st-lat-v');
  const lonV = $('#st-lon-v');
  const dateEl = $('#st-date');
  const speedEl = $('#st-speed');
  const cityEl = $('#st-city');
  const pauseEl = $('#st-pause');

  // 天候 UI 要素
  const wxModeEl = $('#wx-mode');
  const wxPresetEl = $('#wx-preset');
  const wxNowEl = $('#wx-now');
  const wxIntEl = $('#wx-int');
  const wxCloudEl = $('#wx-cloud');
  const wxPrecipEl = $('#wx-precip');
  const wxFogEl = $('#wx-fog');
  const wxWindEl = $('#wx-wind');
  const wxManual = [...el.querySelectorAll('.wx-manual')];

  function syncWeather() {
    if (!weather) return;
    const auto = weather.getMode() === 'auto';
    wxModeEl.value = auto ? 'auto' : 'manual';
    wxNowEl.textContent = auto ? `（自動: ${weather.getCurrentLabel()}）` : '';
    // 手動操作群は自動時にグレーアウト
    for (const e of wxManual) e.disabled = auto;
    // スライダ/プリセットは編集中でなければ current に追従
    const c = weather.state.current;
    if (document.activeElement !== wxPresetEl) wxPresetEl.value = weather.state.preset;
    const setRange = (e, span, v, fmt) => {
      if (document.activeElement !== e) e.value = v;
      span.textContent = fmt(parseFloat(e.value));
    };
    setRange(wxCloudEl, $('#wx-cloud-v'), c.cloudiness, (x) => `${Math.round(x * 100)}%`);
    setRange(wxPrecipEl, $('#wx-precip-v'), c.precip, (x) => `${Math.round(x * 100)}%`);
    setRange(wxFogEl, $('#wx-fog-v'), c.fogBoost, (x) => `${Math.round(x * 100)}%`);
    setRange(wxWindEl, $('#wx-wind-v'), c.windGust, (x) => x.toFixed(2));
    if (document.activeElement !== wxIntEl && wxIntEl.value === '') wxIntEl.value = '1';
    $('#wx-int-v').textContent = `${parseFloat(wxIntEl.value || '1').toFixed(2)}×`;
  }

  function syncFromState() {
    const s = clock.state;
    latEl.value = s.latitude;
    lonEl.value = s.longitude;
    latV.textContent = `${s.latitude.toFixed(1)}°`;
    lonV.textContent = `${s.longitude.toFixed(1)}°`;
    speedEl.value = String(s.speedMultiplier);
    pauseEl.textContent = s.paused ? '再開' : '一時停止';
    if (document.activeElement !== dateEl) dateEl.value = dateToLocalInput(s.simDate, s.longitude);
    syncWeather();
  }

  if (weather) {
    wxModeEl.addEventListener('change', () => { weather.setMode(wxModeEl.value); syncWeather(); });
    wxPresetEl.addEventListener('change', () => { weather.setPreset(wxPresetEl.value); syncWeather(); });
    wxIntEl.addEventListener('input', () => { weather.setIntensity(parseFloat(wxIntEl.value)); syncWeather(); });
    wxCloudEl.addEventListener('input', () => weather.setParam('cloudiness', parseFloat(wxCloudEl.value)));
    wxPrecipEl.addEventListener('input', () => weather.setParam('precip', parseFloat(wxPrecipEl.value)));
    wxFogEl.addEventListener('input', () => weather.setParam('fogBoost', parseFloat(wxFogEl.value)));
    wxWindEl.addEventListener('input', () => weather.setParam('windGust', parseFloat(wxWindEl.value)));
  }

  latEl.addEventListener('input', () => {
    clock.set({ latitude: parseFloat(latEl.value) });
    latV.textContent = `${parseFloat(latEl.value).toFixed(1)}°`;
    cityEl.value = '';
  });
  lonEl.addEventListener('input', () => {
    clock.set({ longitude: parseFloat(lonEl.value) });
    lonV.textContent = `${parseFloat(lonEl.value).toFixed(1)}°`;
    cityEl.value = '';
  });
  dateEl.addEventListener('change', () => {
    const d = localInputToDate(dateEl.value, clock.state.longitude);
    if (d && !isNaN(d.getTime())) clock.set({ simDate: d });
  });
  speedEl.addEventListener('change', () => clock.set({ speedMultiplier: parseFloat(speedEl.value) }));
  cityEl.addEventListener('change', () => {
    const c = CITY_PRESETS[parseInt(cityEl.value, 10)];
    if (c) {
      clock.set({ latitude: c.lat, longitude: c.lon });
      syncFromState();
    }
  });
  $('#st-now').addEventListener('click', () => {
    clock.setNow();
    syncFromState();
  });
  pauseEl.addEventListener('click', () => {
    clock.togglePause();
    syncFromState();
  });

  let open = false;
  function openPanel() {
    open = true;
    if (controls.isLocked) controls.unlock(); // 入力操作のためポインタ解除
    overlay.classList.add('hidden');
    syncFromState();
    el.classList.add('open');
  }
  function close() {
    open = false;
    el.classList.remove('open');
    overlay.classList.remove('hidden'); // クリックで再開できるよう開始画面を出す
  }
  function toggle() {
    if (open) close();
    else openPanel();
  }

  // 開いている間、日時表示を追従更新（編集中は触らない）
  function refresh() {
    if (open) syncFromState();
  }

  return { toggle, openPanel, close, refresh, isOpen: () => open };
}
