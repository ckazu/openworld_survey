# 天候システム 実装ブループリント

Three.js r0.184 / WebGL2 / EffectComposer のオープンワールド湖畔シムに、雲量・雨・霧・雪の
4 天候をフル連動で追加するための単一設計書。`docs/celestial-blueprint.md` /
`docs/water-blueprint.md` のスタイルを踏襲する。

本書は `src/sky.js` / `src/main.js` / `src/water.js` / `src/grass.js` / `src/ambience.js` /
`src/vegetation.js` / `src/ui/settings.js` / `src/textures.js` を精読した上で、既存の実結線
（uniform 名・関数シグネチャ・更新順序・レイヤ規約）に正確に乗せる。推測は排し、確認済みの
事実のみを根拠にする。

---

## 0. 設計原則（3 案の統合判断）

3 つの設計案（pragmatic / fidelity / architecture）は核心で一致しており、本書はその一致点を
採用し、矛盾は最良に解決する。

1. **天候は「変調器」であり「置換器」ではない。** 既存の太陽高度ランプ（`EXPO` / `FOG_D` /
   `SUN_I` / `SKY_TURB` / `bloomPass.threshold` 等）のテーブルは一切書き換えず、その**出力に
   係数を乗算/加算**する。昼夜サイクルが壊れないことを最優先（3 案共通の鉄則）。

2. **単一の状態源 = 連続パラメータベクトル。** 種類（晴/曇/雨/霧/雪）は「プリセット → 目標
   ベクトル」に過ぎず、レンダラは連続値のみを見る。手動↔自動もブレンドも 1 本の補間機構に統一。

3. **`current` / `target` の 2 値 + 指数補間。** プリセット切替も自動遷移も「target を差し替える
   だけ」。補間は `1 - exp(-dt/tau)`（フレームレート非依存）。`wetness` だけは非対称時定数の
   一次遅れ積分（濡れ速い・乾き遅い）にし、リアリティの核とする（fidelity / architecture 案採用）。

4. **`Math.random()` / `Date` は main 側でのみ。** `weather.js` は乱数源と文脈を**注入**で受ける
   純粋モジュール（`createWeather({ rand })`）。シェーダ/RT 内で乱数遷移を起こさない。遷移ロジック
   は CPU の `update(dt)` に集約。自動遷移の滞在時間は**実時間 dt ベース**（simClock の倍率に
   引きずられない。144× で天候がパラパラ変わるのを防ぐ。3 案共通）。

5. **共有 uniform は参照配布。** 既存の `applyDynamicFog`（sky.js）/ `sharedUniforms` エイリアス
   （water.js）/ `onBeforeCompile` 参照注入（grass.js, vegetation.js）と全く同じ規約で
   `weatherUniforms` を 1 セット公開し、main が各所へ参照配布する。再コンパイル不要・`.value`
   更新のみ。

6. **新規 RT は追加しない。** 水の反射/屈折 RT が既に重い。粒子（雨/雪）は単一 `Points` +
   1 つの `ShaderMaterial`、カメラ追従ボックスで GPU wrap。粒子は **layer 1**（草・花・泡と同じ）
   に置き、水 RT カメラ（layer 0 限定）からも GTAO プリパス（excludeFromGTAO）からも除外する。

7. **積雪（snowCover）と接地霧は最終段階の任意拡張。** fidelity 案の積雪 PBR・接地霧レイヤは
   表現価値が高いが、MVP のスコープを膨らませる。段階分けで「最小で動く → フル連動 → 演出強化」
   に切り、各段階を独立コミット可能にする（architecture 案の後方互換 no-op を踏襲）。

---

## 1. 天候の状態モデル（連続パラメータ）

`weather.js` が保持する単一状態源。`current`（実値）と `target`（目標）を持ち、`update(dt)` で
`current` を `target` へ補間する。プリセットは `target` の部分集合を定義するデータ。

| パラメータ | 範囲 | 意味 | 主な連動先 |
|---|---|---|---|
| `cloudiness` | 0..1 | 雲量。0=快晴, 1=どんより曇天 | 空ターブ/Mie/Ray、雲スプライト密度・色、露出減、Bloom 抑制、直射光減衰、環境光フラット化 |
| `precip` | 0..1 | 降水強度（雨/雪共通の量。種別は `precipKind`） | 雨/雪粒子の本数・速度・不透明度、水面波紋、濡れ進行、視程低下 |
| `precipKind` | 0..1 | 0=雨, 1=雪（連続値だが実用は 0/1 へ寄せる。みぞれ中間も可） | 粒子シェーダの落下速度・横揺れ・スプライト分岐 |
| `wetness` | 0..1 | 地面・葉の濡れ。**非対称一次遅れ積分**（雨で速く濡れ、止むと遅く乾く） | 草/地面の暗化・微反射（艶）、水面波紋の残存 |
| `fogBoost` | 0..1 | 既存フォグ密度への上乗せ係数（朝靄・濃霧・雨霧・雪） | `scene.fog.density` 乗算、フォグ昼底色のホワイトアウト |
| `windGust` | 0..2 | 風の強弱。1=平常, >1=突風/嵐 | 草・木の揺れ振幅、雲速度、水面 choppy、雨/雪の斜め角度 |

### 派生量（`current` から計算、状態には持たせない）

`deriveWeather(cur)` 純関数で算出し、uniform とランプ補正にのみ使う。

```
lightAtten = clamp(0.55*cloudiness + 0.6*precip, 0, 1)   // 曇天/降水で日射を落とす量
skyDim     = mix(1.0, 0.6, cloudiness)                    // 曇天の全体減光係数
rainAmount = precip * (1 - precipKind)                    // 雨成分
snowAmount = precip * precipKind                          // 雪成分
```

### 補間と積分（フレームレート非依存）

```js
// 通常パラメータ: 指数補間。tau = 時定数(秒)
const k = 1 - Math.exp(-dt / tau);
cur[p] += (target[p] - cur[p]) * k;

// wetness のみ: 非対称一次遅れ積分（雨で速く濡れ、止むと遅く乾く）
const wetTarget = rainAmount; // 雪はあまり濡らさない（snowAmount は加えない）
const wetTau = wetTarget > cur.wetness ? 3.0 : 60.0;
cur.wetness += (wetTarget - cur.wetness) * (1 - Math.exp(-dt / wetTau));
```

`tau` の指針（パラメータごと）:
- `cloudiness` / `fogBoost`: 遅い（8〜20s）。空はゆっくり変わる。
- `precip`: やや速い（4〜8s）。降り出し/止みのテンポ。
- `windGust`: 速い（1.5〜3s）。突風感。
- `precipKind`: 雨↔雪を跨ぐとき `precip < 0.05` まで落ちてから切替を許可（瞬間混在を防ぐ）。

---

## 2. 手動選択と自動確率遷移

### プリセット定義（`weather.js` 内の定数）

`target` の部分集合。指定外は既定（clear）値に倒す。

```js
const DEFAULT = { cloudiness: 0.05, precip: 0, precipKind: 0, fogBoost: 0, windGust: 0.6 };

const WEATHER_PRESETS = {
  clear:    { cloudiness: 0.05, precip: 0.0,  fogBoost: 0.0,  windGust: 0.6 },
  fair:     { cloudiness: 0.35, precip: 0.0,  fogBoost: 0.05, windGust: 0.8 }, // 晴れ時々曇り
  cloudy:   { cloudiness: 0.75, precip: 0.0,  fogBoost: 0.1,  windGust: 0.9 },
  overcast: { cloudiness: 1.0,  precip: 0.0,  fogBoost: 0.25, windGust: 1.0 }, // どんより
  rain:     { cloudiness: 0.92, precip: 0.6,  fogBoost: 0.35, windGust: 1.3, precipKind: 0 },
  storm:    { cloudiness: 1.0,  precip: 0.95, fogBoost: 0.45, windGust: 2.0, precipKind: 0 },
  mist:     { cloudiness: 0.45, precip: 0.0,  fogBoost: 0.6,  windGust: 0.2 }, // 朝靄
  fog:      { cloudiness: 0.6,  precip: 0.0,  fogBoost: 0.95, windGust: 0.1 }, // 濃霧
  snow:     { cloudiness: 0.9,  precip: 0.55, fogBoost: 0.4,  windGust: 0.7, precipKind: 1 },
  blizzard: { cloudiness: 1.0,  precip: 0.95, fogBoost: 0.7,  windGust: 2.0, precipKind: 1 },
};
```

### 手動モード

- UI（settings.js）から `setPreset(key)` → `target = { ...DEFAULT, ...WEATHER_PRESETS[key] }`、
  `mode = 'manual'`。手動では自動遷移を停止。
- 個別スライダは `setParam('cloudiness'|'precip'|'fogBoost'|'windGust', v)` で target を上書き
  （これも `mode = 'manual'` へ）。
- `setIntensity(scale)`（0..1.5）: 選択プリセットの `precip` / `fogBoost` を一律スケールし、
  弱い雨〜土砂降りを連続調整。

### 自動モード（確率的マルコフ遷移）

`mode = 'auto'` のとき、`update(dt)` 内で**滞在タイマー** `dwell` を実時間 dt で減算。`dwell <= 0`
で遷移テーブルから次状態を抽選し、`target` を差し替え、`dwell` を再抽選（45〜120s）。`current` が
滑らかに補間されるので「急に雨」にはならない。

```js
const TRANSITIONS = {
  clear:    [['fair',0.5],['cloudy',0.3],['mist',0.2]],
  fair:     [['clear',0.4],['cloudy',0.4],['rain',0.2]],
  cloudy:   [['fair',0.35],['overcast',0.3],['rain',0.25],['clear',0.1]],
  overcast: [['cloudy',0.4],['rain',0.4],['fog',0.2]],
  rain:     [['cloudy',0.45],['storm',0.2],['overcast',0.25],['fog',0.1]],
  storm:    [['rain',0.7],['overcast',0.3]],
  mist:     [['clear',0.5],['fair',0.3],['fog',0.2]],
  fog:      [['mist',0.4],['overcast',0.3],['cloudy',0.3]],
  snow:     [['cloudy',0.5],['overcast',0.5]],
  blizzard: [['snow',0.6],['overcast',0.4]],
};
```

隣接する天候へ偏らせて急変を防ぐ。`rand` は注入（`createWeather({ rand })`）。

### 昼夜サイクル・季節との両立（雨↔雪、朝靄）

3 案が一致して提案する「文脈ゲート」を採用。`update(dt, ctx)` の `ctx = { sunAltDeg, latitude,
simDate }` を使う:

- **雨↔雪の自動決定:** `snow`/`rain` を直接遷移テーブルに混ぜず、降水系プリセット（rain/storm）を
  選んだ後 `isFreezing(latitude, simDate)`（緯度＋月から擬似気温を推定）が真なら `precipKind`
  目標を 1（雪化）に倒す。「寒冷地・冬は雪、温暖・夏は雨」が自動で出る。手動 snow/blizzard 選択時は
  ユーザ意図優先で強制許可。
- **朝靄の時刻バイアス:** 早朝（`sunAltDeg` が低い日の出前後）かつ低風のとき `mist` の抽選確率を
  引き上げる。朝に霧が自然発生し、昇陽とともに `fogBoost` が引き、晴れていく。

### 公開 API（`weather.js`）

```js
createWeather({ rand = Math.random, initial = 'fair', latitude } = {}) -> {
  state,                  // { current:{...}, target:{...}, mode, preset } + deriveWeather 派生 getter
  uniforms,              // weatherUniforms（§4 で全所へ参照配布）
  group,                 // 粒子 Points を含む Group（main が scene.add）
  update(dt, ctx),       // current 補間/積分 + 自動遷移抽選 + uniform 反映 + 粒子のカメラ追従
  setPreset(key),        // 手動
  setParam(key, value),  // 手動・個別
  setIntensity(scale),   // 全体強度
  setMode(flag),         // 'auto' | 'manual'
  getMode(), getCurrentLabel(), // UI 表示用
  applyWetness(material),// 全マテリアルへ濡れ uniform を冪等注入（applyDynamicFog 流）
  dispose(),
}
```

---

## 3. 各天候の描画手法（既存パイプラインへの追加箇所）

粒子はすべて**カメラ追従の領域生成**（プレイヤー周囲ボックス内に分布、ワールド原点固定にしない）。
grass.js のタイル追従と同じ哲学。RT は追加しない。

### ① 雲量（晴↔曇）— 既存システムの変調のみ、新規描画ゼロ

3 経路で表現（どれも既存資産の変調）:

1. **Sky ドーム（sky.js）:** `update()` が `rampScalar(SKY_TURB, a)` 等で確定した最終値に
   `cloudiness` を乗加算（§4b）。turbidity↑（白濁）、rayleigh↓（青みを抜く）、mieCoefficient↑
   （白いハロー拡大）。これが曇り空の核。
2. **流れる雲スプライト（ambience.js）:** `createCloudMaterial` に `uCloudiness` を参照注入し、
   フラグメントで `gl_FragColor.a *= mix(0.55, 1.0, uCloudiness)`、色を `mix(白, 灰, uCloudiness)`
   で鈍らせる。ジオメトリ/パフ数は変えず opacity/色だけで密度感を出す（GC フリー）。
3. **どんより感の決め手は光連動:** 環境光フラット化 + Bloom 抑制 + 露出微減 + 直射光減衰（§4）。
   粒子よりこちらが効く。

> 設計判断: fidelity 案の「オーバーキャスト半球膜」は曇天フラット化に効くが、Sky ターブ変調 +
> 環境光フラット化で十分な絵が出るため、ドローコール削減を優先して採用しない。必要なら段階4の
> 拡張点とする。

### ② 雨 — 単一 Points（カメラ追従ボックス、GPU 落下、layer 1）

- `weather.js` 内 `createPrecip(weatherUniforms, fogUniforms)`: 1 つの `THREE.Points`（雨上限
  ~10000、`BufferGeometry`、`frustumCulled = false`）。各頂点はシード属性のみ持つ。
- **GPU 落下 + wrap:** vertex shader で `pos.y = boxTop - mod(seed*boxH + uTime*fallSpeed, boxH)`
  により時間からの剰余で wrap（CPU 位置更新ゼロ）。XZ は `uWindGust` と風向で斜めにシア。
- **カメラ追従:** `group.position` を毎フレーム `camera.position` にスナップ（CPU 1 代入）。領域が
  カメラに追従し、遠方はフォグで隠れる。
- **見た目（雨筋）:** `gl_PointSize` を縦に伸ばせないため、各点に**縦長ストリークのアルファ
  テクスチャ**（`textures.js` に `rainStreakTexture()` 追加）をビルボード。最軽量。fidelity の
  縦 quad InstancedMesh は段階4の任意アップグレード。
- **密度・速度・不透明度** = `rainAmount`（= `precip * (1 - precipKind)`）で連続制御。
  `points.visible = (rainAmount + snowAmount) > 0.01` で 0 時はドローごとスキップ。
- **フォグ対応:** マテリアルに `#include <fog_*>` を入れ、`applyDynamicFog` 対象にして遠方の雨が
  大気に溶ける。`uFogNight` 参照で夜は減光。
- **レイヤ:** `points.layers.set(1)`（水 RT・GTAO から除外）。

### ③ 霧（朝靄・濃霧）— 既存カスタムフォグの変調（新規パスゼロ）

- **主:** sky.js が `scene.fog.density = rampScalar(FOG_D, a)` を設定した**直後**に main で
  `scene.fog.density *= (1 + fogBoost*2.5 + cloudiness*0.3 + precip*0.8)`。これだけで全フォグ対応
  マテリアル（草/水/雲/地形/葉）が一括で霧に沈む（既存共有フォグ設計の恩恵）。
- **昼底色のホワイトアウト:** 現状 `fog_fragment` は夜底色 `uFogNightColor`（暗い紺）しか持たない。
  昼の白い朝靄/濃霧を出すため、`fog_pars_fragment` に `uniform float uFogBoost; uniform vec3
  uFogDayColor;` を追加宣言し、`fog_fragment` の内散乱計算後に 1 行:
  `inscatter = mix(inscatter, uFogDayColor, uFogBoost * (1.0 - uFogNight));`
  （`(1.0 - uFogNight)` ゲートで昼のみ適用。夜は既存の紺底色のまま）。
- **接地霧（朝靄が湖面を這う）:** fidelity 案の水平ノイズプレーンは段階4の任意拡張。MVP は
  既存フォグの高さ項（`fog_fragment` 内 `fogHeight`）が既に低空ほど濃いので、朝靄の「地面に這う」
  感はある程度出る。

### ④ 雪 — 雨と同じ Points を `precipKind` で分岐

- `createPrecip()` を雨雪共用。vertex/fragment で `uPrecipKind` により挙動分岐:
  - 落下速度: 雪は遅い（雨の ~1/8）。
  - 横揺れ: 雪は `sin(uTime + seed)` でひらひら漂う（雨は直線）。
  - スプライト: 雪は丸いソフトドット（`textures.js` の `cloudPuffTexture()` を流用可、または
    専用 `snowFlakeTexture()`）、`gl_PointSize` 大きめ。雨は縦ストリーク。
  - 分岐は `mix()` でブレンドし、片成分が 0 のとき自然に消える。
- **密度** = `snowAmount`（= `precip * precipKind`）。
- **積雪（snowCover）は段階4の任意拡張**（PBR 上面白化）。MVP は降雪粒子 + 視程低下 + 寒色寄せ
  グレーディングのみ。

---

## 4. フル連動の結線（既存の変数/uniform/ランプへの乗せ方）

天候は既存ランプの**出力に乗る**。中核は `weatherUniforms`（`createWeather` が作り参照配布）:

```js
weatherUniforms = {
  uCloudiness: { value: 0 },
  uPrecip:     { value: 0 },
  uPrecipKind: { value: 0 },
  uRainRipple: { value: 0 },   // = rainAmount。water が参照
  uWetness:    { value: 0 },
  uWindGust:   { value: 0.6 },
  uWindDir:    { value: new THREE.Vector2(0.912, 0.41) }, // 既存草/木の固定風向と一致
  // フォグへ追記（fogUniforms に統合配布）
  uFogBoost:    { value: 0 },
  uFogDayColor: { value: new THREE.Color(0.62, 0.66, 0.72) },
};
```

### 4a. フォグ（sky.js / scene.fog / fogUniforms）

- **密度:** main で skyUpdate の**後**に `scene.fog.density *= (1 + fogBoost*2.5 + cloudiness*0.3
  + precip*0.8)`。skyUpdate が毎フレーム density を上書きするため、必ず後段で乗算（§6 順序厳守）。
- **昼底色:** `fogUniforms` に `uFogBoost` / `uFogDayColor` を**追記**し、`applyDynamicFog` の
  `refs(u)` に 2 行追加（後方互換）。weather から毎フレーム `fogUniforms.uFogBoost.value = fogBoost`
  を書く。`fog_fragment` のホワイトアウト 1 行は §3③。

### 4b. 空の色・ターブ（sky.js Sky uniforms）

`sky.update(sunDir, mDir, moonAltDeg, illum, weather)` に第 5 引数 `weather`（current 値, 省略可）
を追加。ランプ計算の**直後**に内部で変調:

```js
const c = weather ? weather.cloudiness : 0;
u.turbidity.value      = rampScalar(SKY_TURB, a) * (1 + c * 1.2);
u.rayleigh.value       = rampScalar(SKY_RAY, a)  * (1 - c * 0.4);
u.mieCoefficient.value = rampScalar(SKY_MIE, a)  * (1 + c * 2.0);
```

### 4c. 露出 / Bloom（main.js）

- 露出: skyUpdate が `renderer.toneMappingExposure = rampScalar(EXPO, a)` を設定する**後**に main で
  `renderer.toneMappingExposure *= (1 - 0.3*lightAtten) * mix(1.0, 0.92, fogBoost)`（曇天・霧で沈める）。
- Bloom: main は `bloomPass.strength` を太陽高度から設定（main.js:404）。その**直後**に
  `bloomPass.strength *= (1 - 0.5*cloudiness)`（曇天は滲み減）。`bloomPass.threshold` は触らない
  （雨/雪でハイライトが減るので暴発しない）。

### 4d. 直射光 / 環境光（sky.js 内部 = update に weather を渡して適用）

`sunLight` / `scene.environmentIntensity` / `hemiLight` は sky.js 内部で main から触れない。4b と
同じ第 5 引数 `weather` で sky.update 内に適用:

```js
sunLight.intensity = rampScalar(SUN_I, a) * kAbove * (1 - 0.6 * lightAtten); // 曇天で直射弱化→影が薄く
scene.environmentIntensity = rampScalar(ENV_I, a) * (1 + 0.15 * cloudiness);  // 拡散光は微増（柔らかい曇天光）
```

### 4e. 水面の波紋・choppy（water.js）

- `makeWaterMaterial(sharedUniforms, ..., weatherUniforms)` に追加引数。`uSunDir`/`uSunColor` と
  同じ**参照エイリアス**手法（water.js:675-676）で `uRainRipple`（= rainAmount）を注入。
  `uChoppyScale` は**既存 uniform**（VERT で `Q * uChoppyScale`, water.js:382）なので即連動可。
- **波紋:** FRAG の法線合成（§(1)）直後に、`uRainRipple` ゲートでプロシージャル同心円リップルを
  法線 `N` に加える。`causticField` 同型のハッシュ配置リング `sin(dist*freq - uTime*spd)`、深水域
  `shoreFade` のみ。スペキュラ（§(9)）が自動で雨粒のきらめきに反応する。
- **choppy:** main で `water.userData.update(time)` の前に
  `water.material.uniforms.uChoppyScale.value = 1 + windGust*0.5`（突風で波が立つ）。`uChoppyScale`
  も weatherUniforms 参照化すれば main の毎フレーム代入を省ける。
- `group.userData.update(time)` は不変（uChoppyScale/uRainRipple は参照で自動反映）。`uTime` は
  水専用クロックのまま（water.js:674 の戒め厳守。共有しない）。

### 4f. 濡れ表現（grass.js / 地形マテリアル）

- 濡れた地面・葉は (1) 暗くなる (2) 微反射（艶）が出る。
- grass.js `createGrassMaterial(uniforms, fogUniforms, weatherUniforms)` に第 3 引数追加。
  `onBeforeCompile` で `shader.uniforms.uWetness = weatherUniforms.uWetness` を参照注入し、
  フラグメントの `#include <opaque_fragment>` 置換ブロック内（既存の透過加算の隣）で
  `outgoingLight *= mix(1.0, 0.78, uWetness)`（暗化）+ 簡易スペキュラ
  `outgoingLight += uSunColor * pow(spec, 40.0) * uWetness * 0.3`（濡れ艶）。
- 地形マテリアル（StandardMaterial 系、`scene.traverse` で `applyDynamicFog` 済み）には
  `applyWetness(material)`（`applyDynamicFog` 同型の冪等参照注入、`userData.__wet` ガード）を
  main の同じ traverse ループで併記。roughness/明度を `uWetness` で下げる 1〜2 行注入。
- MVP は地面と草に適用。葉・岩は段階4の拡張点。

### 4g. 風（grass.js / vegetation.js / ambience.js / precip）

- 草（grass.js VS, grass.js:130-133）: `shader.uniforms.uWindGust = weatherUniforms.uWindGust` を
  注入し、`mvPosition.xz += vec2(0.912, 0.41) * (gust*0.16 + flutter) * bend` の振幅を
  `* (0.5 + uWindGust)` 倍に。風向も `uWindDir` で回せる（現状固定 `vec2(0.912, 0.41)`）。
- 木（vegetation.js VS, vegetation.js:92-93）: 同様に階層風 `gust`/`branch`/`flutter` 合成の振幅へ
  `uWindGust` を乗算（`createVegetation(uniforms, weatherUniforms)` に引数追加、onBeforeCompile 1 行）。
- 雲速度（ambience.js）: `createClouds().update(dt, windGust)` で
  `c.mesh.position.x += c.speed * dt * (0.5 + windGust)`。`createAmbience().update(dt, time,
  playerPos, weather)` に第 4 引数追加（後方互換）。蝶・鳥は荒天（`precip`）で opacity を落とす。
- 雨/雪粒子: precip シェーダで `pos.xz += uWindDir * uWindGust * fallProgress`（斜め降り）。

### 連動マトリクス（要約）

| 連動先 | 駆動パラメータ | 適用箇所 | 適用方法 |
|---|---|---|---|
| `scene.fog.density` | fogBoost, cloudiness, precip | main（skyUpdate 後） | `*= (1+fogBoost*2.5+cloudiness*0.3+precip*0.8)` |
| フォグ昼底色 | fogBoost | fogUniforms.uFogBoost / uFogDayColor | fog_fragment 1 行 + refs 配布 |
| Sky turb/ray/mie | cloudiness | sky.update(…, weather) 内 | 最終値へ乗加算 |
| 露出 | lightAtten, fogBoost | main（skyUpdate 後） | `toneMappingExposure *=` |
| Bloom strength | cloudiness | main（bloom 設定後） | `bloomPass.strength *= (1-0.5*cloudiness)` |
| sunLight / env 強度 | lightAtten, cloudiness | sky.update 内 | `sunLight.intensity *= (1-0.6*lightAtten)` 等 |
| 水面波紋 | rainAmount | water uniforms（参照配布） | uRainRipple, FRAG リップル |
| 水面 choppy | windGust | water uChoppyScale（既存） | `= 1 + windGust*0.5` |
| 草/地面 濡れ | wetness | grass onBeforeCompile + applyWetness | uWetness 注入 |
| 草・木の揺れ | windGust, windDir | grass/vegetation onBeforeCompile | uWindGust/uWindDir 注入 |
| 雲速度・濃度 | windGust, cloudiness | ambience（uniform + update 引数） | uCloudiness + 速度倍率 |
| 雨/雪粒子 | precip, precipKind, windGust | weather precip Points | uPrecip/uPrecipKind/uWindGust |

---

## 5. 追加ファイルと既存ファイルの改修点

### 新規 `src/weather.js`

- `createWeather({ rand, initial, latitude })` → §2 の API。
- 内部: `WEATHER_PRESETS`, `DEFAULT`, `TRANSITIONS`, `deriveWeather(cur)`, `isFreezing(lat, date)`,
  `createPrecip(weatherUniforms, fogUniforms)`（雨雪共用 Points + ShaderMaterial）, `weatherUniforms`
  構築。
- `applyWetness(material)`（`applyDynamicFog` 同型の冪等参照注入、`userData.__wet` ガード）を公開。
- `group`（precip Points を含む Group）を返し、main が scene.add。`update(dt, ctx)` で current
  補間/積分 → 自動遷移抽選 → `weatherUniforms` の `.value` 反映 → precip group をカメラへスナップ。

### 新規 `src/textures.js` への追加（既存ファイルに 1〜2 関数）

- `rainStreakTexture()`: 縦長グラデの細いアルファ（既存の `makeCanvas` ヘルパー流用）。
- `snowFlakeTexture()`: 丸いソフトドット（`cloudPuffTexture` の DataTexture 生成を流用可）。

### 既存改修（シグネチャ / 注入箇所レベル）

| ファイル | 改修 |
|---|---|
| `src/sky.js` | `update(sunDir, mDir, moonAltDeg, illum, weather=null)` に第 5 引数追加。内部で §4b/4d の係数を `rampScalar` 出力へ乗加算。`patchFogChunks` の `fog_pars_fragment` に `uFogBoost`/`uFogDayColor` 宣言追加、`fog_fragment` にホワイトアウト 1 行。`fogUniforms` に `uFogBoost`/`uFogDayColor` を追加。`applyDynamicFog` の `refs(u)` に 2 行追加。`createSky` 戻り値は変更不要。 |
| `src/water.js` | `makeWaterMaterial(sharedUniforms, ..., weatherUniforms)` / `createWater(sunDirection, sharedUniforms, weatherUniforms)` に引数追加。uniforms に `uRainRipple` を参照エイリアス、`uChoppyScale` を weatherUniforms 参照化。FRAG に波紋ブロック追加（§4e）。`group.userData.update(time)` は不変。 |
| `src/grass.js` | `createGrassField(uniforms, fogUniforms, weatherUniforms)` / `createGrassMaterial(uniforms, fogUniforms, weatherUniforms)` に第 3 引数追加。VS に `uWindGust`/`uWindDir`、FS に `uWetness` 注入。 |
| `src/vegetation.js` | `createVegetation(uniforms, weatherUniforms)` に第 2 引数追加。木の onBeforeCompile に `uWindGust` を 1 行乗算。 |
| `src/ambience.js` | `createCloudMaterial` に `uCloudiness` uniform 追加（参照）。`createClouds().update(dt, windGust)` 引数追加。`createAmbience().update(dt, time, playerPos, weather=null)` 第 4 引数追加。蝶/鳥の荒天減衰。 |
| `src/ui/settings.js` | `createSettingsPanel({ clock, controls, overlay, weather })` に `weather` 追加。§7 の UI。 |
| `src/main.js` | `createWeather` 生成・`scene.add(weather.group)`・uniform 参照配布・各 create 関数への weatherUniforms 受け渡し・更新ループ組み込み（§6）・`__demo.weather`。 |
| `src/textures.js` | `rainStreakTexture()` / `snowFlakeTexture()` 追加。 |

---

## 6. main.js 更新ループへの組み込み位置（順序）

現状ループ（main.js:379-433）への挿入。**順序が要**: weather 補正は「skyUpdate が露出/フォグ/ライト
を確定した後」に乗せ、「water.userData.update（= 水 RT が同期描画される）より前」に粒子/uniform を
最新化する。

```
1.  simClock.advance(dt)                                       [既存]
2.  天文計算（sun/moon/star dirs, sunAltDeg）                    [既存]
3.  ★ weather.update(dt, { sunAltDeg, latitude, simDate })      ← 追加（dt=実時間）
                                                                  current 補間/積分・自動遷移・
                                                                  weatherUniforms.value 反映・precip スナップ
4.  ★ skyUpdate(sunDir, moonDir, moonAltDeg, illum, weather.state.current)  ← 第 5 引数追加
5.  ★ weather 後段補正（skyUpdate の出力に乗算）                  ← 追加:
        scene.fog.density *= (1 + fogBoost*2.5 + cloudiness*0.3 + precip*0.8)
        fogUniforms.uFogBoost.value = fogBoost
        renderer.toneMappingExposure *= (1 - 0.3*lightAtten) * mix(1.0, 0.92, fogBoost)
6.  followPlayer(camera.position)                              [既存]
7.  bloomPass.threshold/strength 設定（既存）
       → ★ bloomPass.strength *= (1 - 0.5*cloudiness)          ← 追加
8.  moon/sun/stars.update（水 RT より前）                       [既存]
9.  sharedUniforms 最新化（uTime/uPlayerPos）                   [既存]
       → ★ water.material.uniforms.uChoppyScale.value = 1 + windGust*0.5  ← 追加（参照化なら省略）
10. water.userData.update(time)                                [既存]（uRainRipple/uChoppyScale は参照済み）
11. player.update / grass.update                              [既存]
       → ★ ambience.update(dt, time, camPos, weather.state.current)  ← 第 4 引数追加
12. refreshEnv / updateLightShafts / updateHud               [既存]
13. composer.render()                                         [既存]
```

- **ステップ 5 を skyUpdate の後に置く理由:** skyUpdate が `scene.fog.density` と
  `toneMappingExposure` を毎フレーム上書きする（sky.js:299/306）。weather は必ずその後に乗算。
- **ステップ 3 を water より前に置く理由:** water RT は `water.userData.update` 内 onBeforeRender で
  同期描画される（water.js:799）。precip の可視/uniform を先に確定しないと、当該フレームの反射に
  古い雨が残る（実害は小だが順序を正す。粒子は layer 1 で反射に映らないため二重描画も回避）。
- 初期化（main.js:60-89 付近）: `createWeather` を `createSky` の後・`createWater`/`createGrassField`/
  `createVegetation`/`createAmbience` の前に生成し、`weatherUniforms` を各 create に渡す。
  `scene.add(weather.group)`。`scene.traverse` の `applyDynamicFog` ループに `weather.applyWetness(m)`
  を併記。`__demo.weather` を追加。

---

## 7. settings.js への UI 追加

既存パネル末尾（`.hint` の前）に天候セクションを追加。`createSettingsPanel({ clock, controls,
overlay, weather })` に `weather` を注入（省略可）。既存のダーク基調・CSS トークンを再利用。

```html
<h2>🌦 天候</h2>
<div class="row">
  <label>モード</label>
  <select id="wx-mode"><option value="auto">自動</option><option value="manual">手動</option></select>
</div>
<div class="row">
  <label>天候プリセット</label>
  <select id="wx-preset">
    <option value="clear">快晴</option><option value="fair">晴れ時々曇り</option>
    <option value="cloudy">曇り</option><option value="overcast">どんより曇り</option>
    <option value="rain">雨</option><option value="storm">嵐</option>
    <option value="mist">朝靄</option><option value="fog">濃霧</option>
    <option value="snow">雪</option><option value="blizzard">吹雪</option>
  </select>
</div>
<div class="row"><label>強度 <span id="wx-int-v"></span></label><input id="wx-int" type="range" min="0" max="1.5" step="0.01"></div>
<div class="row"><label>雲量 <span id="wx-cloud-v"></span></label><input id="wx-cloud" type="range" min="0" max="1" step="0.01"></div>
<div class="row"><label>降水 <span id="wx-precip-v"></span></label><input id="wx-precip" type="range" min="0" max="1" step="0.01"></div>
<div class="row"><label>霧 <span id="wx-fog-v"></span></label><input id="wx-fog" type="range" min="0" max="1" step="0.01"></div>
<div class="row"><label>風 <span id="wx-wind-v"></span></label><input id="wx-wind" type="range" min="0" max="2" step="0.01"></div>
```

イベント:
- `wx-mode` change → `weather.setMode(value)`。`auto` 時はプリセット/スライダを disabled（グレー
  アウト）し、現在の自動天候名（`getCurrentLabel()`）を表示。
- `wx-preset` change → `weather.setPreset(value)`（自動的に手動モードへ）。
- `wx-int` input → `weather.setIntensity(v)`。
- 各スライダ input → `weather.setParam('cloudiness'|'precip'|'fogBoost'|'windGust', v)`（手動へ）。
- `refresh()`（既存、開いている間 0.25s 毎, main.js:429）で自動モード時のみ `weather.state.current`
  を読みスライダ/表示を追従更新（手動編集中は触らない＝既存 dateEl と同じ流儀）。
- `keydown` の INPUT/SELECT ガード（main.js:319-327）は select 追加でそのまま機能。
- HUD（updateHud, main.js:369）に現在天候の短縮表示を 1 行追加（任意）。

---

## 8. リスク / パフォーマンス上の注意と対策

| リスク | 内容 | 対策 |
|---|---|---|
| 粒子の二重/三重描画 | 雨/雪 Points が水反射/屈折 RT・GTAO プリパスにも描かれる | precip を **layer 1**（water RT は layer 0 限定 water.js:222）に置く。半透明なので AO 不要 → `userData.excludeFromGTAO = true`（main.js:131 の既存仕組み）併用。 |
| オーバードロー（fillrate） | 大量半透明 Points で塗りつぶし逼迫 | 点数上限（雨 ~10k / 雪 ~8k）+ カメラ近傍ボックスに絞る（遠方はフォグで隠す）。`precip.visible = amount>0.01` で 0 時はドローごとスキップ。`depthWrite=false`。 |
| onBeforeCompile 再コンパイル | weather uniform 注入で大量再コンパイル | uniform は**参照エイリアス**で 1 度注入、以後 `.value` のみ更新。`applyWetness` は `userData.__wet` で冪等化（`applyDynamicFog` 同型）。`material.needsUpdate` を毎フレーム立てない。 |
| skyUpdate との上書き競合 | sky が density/exposure を毎フレーム上書き（sky.js:299/306） | §6 の順序厳守（weather は必ず skyUpdate の後段）。コメントで明記。 |
| PMREM 過剰再ベイク | 曇りで環境を再ベイクすると重い | 曇天は `scene.environmentIntensity` 乗算のみで表現。Sky turb 変更は既存 `refreshEnv` の角度/時間間引き条件（sky.js:310-325）に自然に乗る。cloudiness 変化で追加トリガしない。 |
| wetness ヒステリシス破綻 | 乾燥が速/遅すぎ | 非対称 tau（濡れ 3s / 乾き 60s）。雨停止後ゆっくり乾く自然挙動。 |
| 自動遷移がシム速度に追従 | simClock 144× で天候がパラパラ | 遷移 dwell は**実時間 dt**（45〜120s/回）。simDate は雨↔雪・朝靄の文脈ゲートにのみ使用。 |
| 露出/フォグ二重適用 | 補正の適用順誤り | exposure/density は skyUpdate が**代入**、weather は**その後に乗算**（順序厳守）。 |
| フォグ昼底色が夜も白む | uFogDayColor の誤適用 | `(1.0 - uFogNight)` ゲートで昼のみ（§3③）。 |
| HalfFloat RT で加算飽和 | 粒子加算でハイライト飽和 | 雨/雪は控えめ加算。Bloom 閾値（日中 ~40, main.js:402）に達しないので暴発しない。 |
| 雪が炎天下の昼に降る不自然 | 自動遷移の precipKind | `isFreezing(lat, date)` で文脈決定。手動 snow/blizzard はユーザ意図優先で許可。 |
| 後方互換 | sky/water/grass/ambience/vegetation のシグネチャ変更 | weather 引数は**全て任意**（省略時 係数 1.0 / no-op）。既存呼び出しを壊さない。段階0 完了時点でマージ可能。 |

---

## 9. 実装の段階分け（最小で動く → フル連動）

各段階は単独で動作・コミット可能（1 コミット 1 目的）。

**段階0 — 状態モデルの骨格（描画なし）**
- `weather.js`: current/target/補間/wetness 積分/プリセット/手動セット/自動遷移/`weatherUniforms`。
- main で生成・`update(dt, ctx)` 呼び出し・`__demo.weather`。値は動くが見た目は不変。
- 検証: target を変えると current が滑らかに追従、自動で天候が変わる（数値ログ/HUD）。後方互換 no-op。

**段階1 — MVP（最小で「天候らしく見える」, 最もコスパ高）**
- sky 変調: cloudiness → 空 turb/Mie/Ray・直射減衰・環境光フラット化（§4b/4d）。
- フォグ連動（§4a 密度 + 昼底色シェーダ改修）+ 露出/Bloom 連動（§4c）。
- 風: `uWindGust` を grass・water `uChoppyScale` へ。
- settings.js に天候 UI（モード/プリセット/スライダ）。
- これで「快晴↔曇↔霧」が空・明るさ・フォグ・風で体感できる。粒子なし。

**段階2 — 降水粒子（雨/雪）**
- `createPrecip()`（Points + シェーダ + `rainStreakTexture`/`snowFlakeTexture`）。layer 1 +
  excludeFromGTAO、カメラ追従ボックス、precipKind 分岐、windGust 斜め、フォグ対応。
- 水面波紋（water.js FRAG, §4e）。
- 検証: rain/snow/storm/blizzard で粒子量・速度・向き・湖面の反応が変わる。

**段階3 — 環境連動（濡れ・木の風・雲）**
- `applyWetness` + grass/地面の濡れ暗化・艶（§4f, wetness 積分）。
- 木（vegetation.js）/ 雲速度（ambience.js）の windGust 連動、雲濃度 `uCloudiness`、蝶/鳥の荒天減衰。
- 検証: 雨後に地面が濡れて暗く艶、突風で草木が大きく揺れる。

**段階4 — 演出強化（拡張点・任意）**
- 積雪 PBR（snowCover, ワールド法線 N.y ゲートで上面に白）、草の白寄せ。
- 接地霧レイヤ（朝靄が湖面を這う水平ノイズプレーン）、オーバーキャスト半球膜。
- 雨筋の縦 quad InstancedMesh アップグレード。光芒を fogBoost で増幅（updateLightShafts）。
- 稲妻フラッシュ（storm 時の露出/空スパイク）、寒色グレーディング（snow 時）、env 再ベイクの天候トリガ。

---

## 主要な実装上の事実確認（Read 由来・推測でない）

- 共有 uniform は**参照エイリアス**で配る既存パターンが確立: sky.js `applyDynamicFog` の `refs()`
  （sky.js:87-92）、water.js が `sharedUniforms.uSunDir/uSunColor` を `material.uniforms` へ代入
  （water.js:675-676）、grass.js/vegetation.js が onBeforeCompile で `shader.uniforms.uXxx =
  uniforms.uXxx`（grass.js:102-112, vegetation.js:68-70）。weatherUniforms も同流儀で再コンパイル
  不要・安全。
- `scene.fog` は **FogExp2**（main.js:65 で assert 済み, sky.js:215）。density 乗算が効く。昼底色は
  sky.js のパッチ済み `fog_fragment`（sky.js:48-79）に `uFogDayColor`/`uFogBoost` を追記するのが
  唯一の整合点（宣言は `fog_pars_fragment` sky.js:32-47 に足す）。
- `renderer.toneMappingExposure`（sky.js:306）と `scene.fog.density`（sky.js:299）は skyUpdate が
  毎フレーム**代入**。weather 補正は必ず skyUpdate の後段（main.js:397 の後）。
- `bloomPass.threshold/strength` は main.js:402-404 で太陽高度から毎フレーム設定 → その直後に
  weather 乗算。
- `sunLight`/`environmentIntensity`/Sky uniforms は **sky.js 内部**で main から触れない
  （sky.js:281-291）→ cloudiness/lightAtten 連動は `skyUpdate` に weather を渡し内部適用が唯一クリーン。
- water RT は `waterMesh.onBeforeRender = rt.update`（water.js:799）で同期描画。反射カメラは
  `layers.set(0)`（water.js:222）→ precip を **layer 1** にすれば反射に映らず二重描画回避。
  `uChoppyScale` は VERT に既存（water.js:341,382, 既定 1.0）→ そのまま windGust 連動可。`uTime` は
  水専用（water.js:674,805 の戒め厳守、共有しない）。
- 草の風振幅は grass.js:130-133 の `gust*0.16 + flutter`、固定風向 `vec2(0.912, 0.41)`。木は
  vegetation.js:86-93 の階層風（同じ固定風向）。どちらも `uWindGust`/`uWindDir` 注入点が明確。
- 雲は ambience.js の `createCloudMaterial`（ambience.js:15）+ `createClouds().update(dt)`
  （ambience.js:106）。`uFogNight` で日没後減光する流儀（ambience.js:46-50）に合わせ、粒子も
  `uFogNight` 参照で夜は減光。
- `simClock.advance`（main.js:385）は simDate を倍率で進めるため、自動遷移を simDate 基準にすると
  体感が速すぎる → **実時間 dt 基準**（要件どおり `Math.random`/`Date` は main〜weather の CPU 側のみ）。
- GTAO プリパスは `userData.excludeFromGTAO`（main.js:131）で除外可能。粒子・接地霧・膜に付与する。
- 既存の reusable テクスチャ生成: `makeCanvas`（textures.js:112）、`cloudPuffTexture`（textures.js:206,
  DataTexture）→ 雪フレーク流用元。

---

## 実装順序（チェックリスト）

**段階0 — 状態モデル**
- [ ] `src/weather.js` 新規: `DEFAULT` / `WEATHER_PRESETS` / `TRANSITIONS` 定数。
- [ ] `createWeather({ rand, initial, latitude })`: current/target、`deriveWeather`、指数補間。
- [ ] wetness 非対称一次遅れ積分（濡れ 3s / 乾き 60s）。
- [ ] `setPreset` / `setParam` / `setIntensity` / `setMode` / `getCurrentLabel`。
- [ ] 自動遷移（dwell 実時間 dt + マルコフ抽選 + `isFreezing` 雨雪ゲート + 朝靄時刻バイアス）。
- [ ] `weatherUniforms` 構築・`uniforms` 公開・`update(dt, ctx)` で `.value` 反映。
- [ ] main: `createWeather` 生成・`update` 呼び出し・`__demo.weather`。値の遷移を HUD/ログで検証。

**段階1 — MVP（空・光・フォグ・風）**
- [ ] sky.js: `update(..., weather=null)` 第 5 引数、turb/ray/mie・sunLight・environmentIntensity 変調。
- [ ] sky.js: `fog_pars_fragment` に `uFogBoost`/`uFogDayColor` 宣言、`fog_fragment` ホワイトアウト 1 行。
- [ ] sky.js: `fogUniforms` に 2 uniform 追加、`applyDynamicFog` の `refs` に 2 行。
- [ ] main: skyUpdate 後に fog.density 乗算・exposure 乗算・bloom.strength 乗算（§6 ステップ5/7）。
- [ ] grass.js: `createGrassField/Material` に weatherUniforms 引数、VS に `uWindGust` 注入。
- [ ] water.js: `uChoppyScale` を weatherUniforms 参照化 or main で毎フレーム代入。
- [ ] settings.js: 天候 UI（モード/プリセット/強度/雲量/降水/霧/風）+ refresh 追従 + 配線。
- [ ] 検証: 快晴↔曇↔霧の切替で空・露出・フォグ・風が一目で変わる。

**段階2 — 降水粒子**
- [ ] textures.js: `rainStreakTexture()` / `snowFlakeTexture()`。
- [ ] weather.js: `createPrecip(weatherUniforms, fogUniforms)`（Points + シェーダ、GPU 落下/wrap）。
- [ ] precip: layer 1 + `excludeFromGTAO`、カメラ追従スナップ、precipKind 分岐、windGust 斜め、フォグ対応。
- [ ] main: `scene.add(weather.group)`、precip スナップを `update(dt, ctx)` 内で。
- [ ] water.js: `makeWaterMaterial`/`createWater` に weatherUniforms、FRAG 雨波紋ブロック、`uRainRipple` 参照。
- [ ] 検証: rain/snow/storm/blizzard で粒子量・速度・向き・湖面波紋が変わる。

**段階3 — 環境連動**
- [ ] weather.js: `applyWetness(material)`（冪等参照注入）公開。
- [ ] grass.js: FS に `uWetness` 注入（暗化 + 艶）。
- [ ] main: `scene.traverse` の `applyDynamicFog` ループに `weather.applyWetness(m)` 併記。
- [ ] vegetation.js: `createVegetation(uniforms, weatherUniforms)`、木 VS に `uWindGust` 乗算。
- [ ] ambience.js: `createCloudMaterial` に `uCloudiness`、`createClouds().update(dt, windGust)`、
      `createAmbience().update(dt, time, pos, weather)`、蝶/鳥の荒天減衰。
- [ ] main: `ambience.update` に weather 引数。
- [ ] 検証: 雨後に地面が濡れて暗く艶、突風で草木が揺れ、雲が速く流れる。

**段階4 — 演出強化（任意）**
- [ ] 積雪 PBR（snowCover, N.y ゲート）+ 草の白寄せ。
- [ ] 接地霧レイヤ / オーバーキャスト半球膜。
- [ ] 雨筋の縦 quad InstancedMesh、光芒の fogBoost 増幅。
- [ ] 稲妻フラッシュ・寒色グレーディング・env 再ベイクの天候トリガ。
