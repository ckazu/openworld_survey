# 木と草のリアル化（アルファカットアウト）設計

- **日付**: 2026-06-11
- **前提**: ハイポリ・プロシージャル化（同日マージ済み）の続き
- **目的**: 木と草の「ベタ塗りカード感」を解消し、リアルさを大幅に引き上げる
- **方針**: Canvas 2D で実行時生成したアルファ付きテクスチャを葉・草に適用する
  （アプローチ A）。外部アセット非依存の哲学は維持する

## 問題の分解

- 木: 葉カードが単色ベタ塗りの矩形で、紙吹雪のように見える。葉らしい
  輪郭の透かしがない。幹がまっすぐな円柱で根元の張り出しもない
- 草: ブレードが単色の平面リボンで先端が四角い。根元の接地暗部がなく、
  彩度が高すぎてカートゥーン調

## スコープ

1. `textures.js` に Canvas 2D ベースのアルファテクスチャ生成を追加
2. 木: 葉群テクスチャ適用・樹冠 AO 焼き込み・透過光・幹の形状改善
3. 草: 尖頭・フォールド断面・根元 AO・艶・自然な色調

### 非スコープ

- 地形質感・水面・空と雲・ポストプロセス（別サイクル）
- 外部画像・GLTF の導入（哲学に反する）
- インポスター/LOD の新設

## コンポーネント設計

### 1. `textures.js` 拡張

Canvas 2D（OffscreenCanvas 不要、`document.createElement('canvas')`）で
シルエットを描き、`THREE.CanvasTexture` として返す。

- `leafClusterTexture()` — 透明背景に、葉形（先の尖った楕円）を数十枚
  ランダムな角度・サイズ・明度で重ね描きした「葉の塊」。RGB は緑のベース
  （頂点カラー/インスタンスカラーで変調するため白〜薄緑）、A は葉形で抜く
- `grassBladeTexture()` — 下辺から上端の一点に収束する細長い葉形。
  中央に薄い葉脈ライン。A で輪郭を抜く
- どちらもシングルトン（既存の bark/rock マップと同じパターン）

### 2. 木（`vegetation.js`）

- 葉マテリアルに `map: leafClusterTexture(), alphaTest: 0.5` を設定。
  影は `customDepthMaterial`（`MeshDepthMaterial` + RGBADepthPacking +
  同テクスチャ + alphaTest）でアルファ抜きの影にする
- 葉カードの UV はそのまま（PlaneGeometry の 0..1）
- 樹冠 AO 焼き込み: `createLeafCluster` 内でクラスタ中心からの相対位置を
  使い、内側・下側のカードほど頂点カラーを暗くする（paintGradient の後段
  ではなくクラスタ生成時に乗算）
- 葉の透過光: 草と同じ逆光透過項を leafMaterial の onBeforeCompile に追加
  （uSunDir / uSunColor を共有 uniform から受ける）
- 幹: 高さ方向に数セグメント化し、ノイズで軸をわずかに曲げる。
  根元 1.4 倍程度のフレア（下端頂点を外へ押す）。テーパー強化

### 3. 草（`grass.js`）

- ブレードジオメトリ: 最上段の頂点を中央 1 点に収束させて尖頭化。
  X 方向に浅い V 字フォールド（中央列を手前に出す）で厚みの錯覚を作る
- テクスチャ: `grassBladeTexture()` を `map + alphaTest: 0.4` で適用し、
  輪郭をさらに有機的に
- 根元 AO: 頂点カラーの根元を 0.55 → 0.3 程度へ強める
- 艶: MeshLambertMaterial → MeshPhongMaterial（shininess 低・specular 弱）
  に変更し、風で揺れたときに穂が鈍く光る。既存 onBeforeCompile の
  風・透過シェーダは Phong のシェーダチャンクに合わせて移植
- 色調: 彩度を下げ黄味を足した自然パレットへ
  （HSL の S を 0.48→0.35 前後、L レンジを圧縮）

## データフロー

```
textures.js
  leafClusterTexture() ──> vegetation.js（葉 material + depth material）
  grassBladeTexture() ───> grass.js（ブレード material + depth material）
main.js の sharedUniforms（uSunDir/uSunColor）──> 葉・草の透過光
```

## エラー処理・性能

- alphaTest はアルファブレンド不要で深度ソート問題が起きない
- 影のアルファ抜きは customDepthMaterial が必須（無いと矩形の影が出る）
- テクスチャ生成は初期化時に一度、256〜512px。CanvasTexture は
  ミップマップ自動生成に任せる

## 検証

- Playwright で 木の近接・草原近接・逆光 のスクショを撮り Before/After 比較
- 確認観点: 葉カードの矩形感が消えたか／草の先端が尖ったか／接地の暗部／
  影がアルファ抜きされているか／コンソールエラーなし

## 実装順序

1. textures.js（葉群・草葉テクスチャ）
2. 木（テクスチャ適用 → 影対応 → AO 焼き込み → 透過光 → 幹）
3. 草（尖頭・フォールド → テクスチャ → Phong 移植 → 色調）
4. スクショ検証・README 更新
