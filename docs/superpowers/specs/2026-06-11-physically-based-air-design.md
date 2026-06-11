# 学術ベースのレンダリング改善 設計

- **日付**: 2026-06-11
- **前提**: PR #4/#5（ゴールデンアワー・オールドレンズ）マージ済み
- **採用技術**（ユーザー選択）:
  - B. AgX トーンマッピング（Sobotka 2022、three.js 組み込み）
  - A. 解析的な大気内散乱／空気遠近法（Hoffman & Preetham, SIGGRAPH 2002）
  - C. 葉の物理ベース薄板透過（Wang et al. 2005 / Jimenez らの透過近似）

## Step 1 (B): AgX トーンマッピング

- `renderer.toneMapping = THREE.AgXToneMapping`
- AgX は ACES よりハイライトの色相を保ちつつ滑らかにロールオフする。
  暗め・低コントラスト寄りになるため露出・グレード（彩度/コントラスト）を再調整

## Step 2 (A): 空気遠近法（フォグの物理化）

- 既存の高さフォグチャンクパッチを **Hoffman & Preetham 2002 の
  単一散乱モデル**に置き換える:
  - 消散: `ext = exp(-(βR+βM)·d)`（密度は既存の高さ変調を流用）
  - 内散乱: `L_in = E·(βR·Ph_R(θ)·C_R + βM·Ph_M(θ)·C_M)/(βR+βM)·(1−ext)`
  - Ph_R = Rayleigh 位相 `3/(16π)(1+cos²θ)`、Ph_M = Henyey-Greenstein（g≈0.65）
  - θ は視線と太陽のなす角。**太陽方向ほど明るく暖かく、反対側は青灰色**に
- 太陽方向・色は静的なので GLSL 定数として焼き込む（uniform 伝搬不要）。
  チャンクパッチは createSky 内（太陽計算後・各マテリアル生成前）で行う
- 視線方向のため varying を vFogWorldY → vFogWorldPos(vec3) に拡張
- scene.fog の fogColor は使わなくなる（fogDensity のみ密度として使用）

## Step 3 (C): 葉・草の物理ベース薄板透過

- 既存の ad hoc な `pow(dot(-V, L))` 透過項を、法線歪み付きの
  薄板透過近似に置換:
  `T = pow(saturate(dot(V, -normalize(L + N·δ))), p) · scale`（δ≈0.4）
- 法線が関与するため「太陽を向いた面は透けず、裏面が透ける」が正しく出る
- leafMaterial（木・低木）と grass の両方に適用

## 検証

- AgX: 夕日直視の白飛びの色相（黄被りが減るか）を Before/After
- 空気遠近法: 同一地点から太陽方向／反対方向を見て、フォグの色が
  暖色／青灰に分かれることを確認
- 葉の透過: 逆光の樹冠・草で、エッジの裏面だけが透けることを確認
- 各 Step でコンソールエラーなし・相対 FPS を確認
