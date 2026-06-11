import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { WORLD_SIZE, WATER_LEVEL, terrainHeight, terrainSlope, forestDensity } from './terrain.js';
import { mulberry32, fbm } from './noise.js';
import { barkNormalMap, rockNormalMap, rockRoughnessMap, leafClusterTexture, broadleafTexture, flowerTexture } from './textures.js';

const rand = mulberry32(20260611);

// 頂点を法線方向にノイズで変位させ、有機的なシルエットにする
function displace(geometry, amount, freq, seed = 0) {
  geometry.computeVertexNormals();
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const d = (fbm(x * freq + y * freq * 0.7 + seed, z * freq - y * freq * 0.5, 3, seed) - 0.5) * 2 * amount;
    pos.setXYZ(i, x + nor.getX(i) * d, y + nor.getY(i) * d, z + nor.getZ(i) * d);
  }
  geometry.computeVertexNormals();
  return geometry;
}

// 高さ方向のグラデーションで頂点カラーを塗る（下が暗く上が明るい = 簡易 AO + 透過光）
function paintGradient(geometry, bottomHex, topHex, yMin, yMax) {
  const c0 = new THREE.Color(bottomHex);
  const c1 = new THREE.Color(topHex);
  const tmp = new THREE.Color();
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, (pos.getY(i) - yMin) / (yMax - yMin)));
    tmp.lerpColors(c0, c1, t);
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function standardMaterial(extra = {}) {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
    ...extra,
  });
}

// 葉用マテリアル。アルファカットアウトでベタ塗りカードを「葉の塊」に見せる。
// 逆光時は太陽光が葉を透ける（uniforms から uSunDir / uSunColor を受ける）
function leafMaterial(uniforms, extra = {}) {
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.68, // 実物の葉の艶。下げすぎると空の映り込みで白くテカる
    metalness: 0,
    side: THREE.DoubleSide,
    map: leafClusterTexture(),
    alphaTest: 0.5,
    // 陰側の葉が黒切り絵にならないよう、葉だけ IBL を強めに受ける
    // （上げすぎると日向側が白飛びする）
    envMapIntensity: 1.2,
    ...extra,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDir = uniforms.uSunDir;
    shader.uniforms.uSunColor = uniforms.uSunColor;
    shader.uniforms.uTime = uniforms.uTime;
    // 階層的な風（GPU Gems 3, Crysis）: ①樹全体の大曲げ（ワールド座標の gust）
    // ②枝（タフト）単位の位相差スウェイ ③葉の高周波フラッター の 3 階層合成。
    // aWind = (タフト位相, 幹からの距離による重み)
    shader.vertexShader =
      'uniform float uTime;\nattribute vec2 aWind;\n' +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        `vec4 mvPosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
        #endif
        {
          float hgt = clamp((position.y - 1.0) / 5.0, 0.0, 1.0);
          vec2 w = mvPosition.xz;
          // ① 樹全体のうねり（森を渡る風）
          float gust = sin(uTime * 0.9 + w.x * 0.05 + w.y * 0.04)
                     + sin(uTime * 1.7 + w.x * 0.13 - w.y * 0.09) * 0.5;
          // ② 枝単位のスウェイ（タフトごとに位相が異なる）
          float branch = sin(uTime * 2.2 + aWind.x) * aWind.y;
          // ③ 葉のフラッター（高周波・微小）
          float flutter = sin(uTime * 6.5 + aWind.x * 3.0 + position.x * 5.0 + position.y * 4.0);
          mvPosition.xz += vec2(0.912, 0.41)
            * (gust * 0.08 * hgt + branch * 0.06 + flutter * 0.015 * aWind.y);
          mvPosition.y += branch * 0.02 + flutter * 0.008;
        }
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`
      );
    shader.fragmentShader =
      'uniform vec3 uSunDir;\nuniform vec3 uSunColor;\n' +
      shader.fragmentShader.replace(
        // DoubleSide は裏面で法線を反転させるが、外向きに張り替えた樹冠法線が
        // 裏面で内向きになり暗い斑になる。反転させずボリューム陰影を保つ
        '#include <normal_fragment_begin>',
        '#include <normal_fragment_begin>\n normal = normalize( vNormal );'
      ).replace(
        '#include <opaque_fragment>',
        `{
          // 薄板透過の近似（Barré-Brisebois & Bouchard, GDC 2011）:
          // 透過ローブを法線で歪ませることで「裏面に光が回り込む」が正しく出る
          vec3 sunView = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
          vec3 viewDir = normalize(vViewPosition);
          vec3 transH = normalize(sunView + normal * 0.4);
          float trans = pow(clamp(dot(viewDir, -transH), 0.0, 1.0), 3.0);
          outgoingLight += uSunColor * vec3(0.5, 1.0, 0.35) * trans * 0.42 * diffuseColor.rgb;
        }
        #include <opaque_fragment>`
      );
  };
  return material;
}

// 影もアルファ抜きにする（無いと葉カードが矩形の影を落とす）
function leafDepthMaterial(texture = leafClusterTexture()) {
  return new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    map: texture,
    alphaTest: 0.5,
  });
}

// 先端が反り返る小さな葉カード（基部が原点、上方向に伸びる）
function makeLeafCard(w, h) {
  const g = new THREE.PlaneGeometry(w, h, 1, 2);
  g.translate(0, h * 0.5, 0);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) / h;
    pos.setZ(i, pos.getZ(i) + t * t * h * 0.35);
  }
  return g;
}

// ボリューム関数 place(rnd) -> {x,y,z,scale,ao} に従い葉カードを多数ばら撒いて 1 ジオメトリにマージ。
// ブロブ（滑らかな塊）の代わりに、無数の葉が重なった樹冠を作る。
// ao（0..1、内側ほど小）は aoBake 属性に保存し、paintGradient の後で乗算する。
function createLeafCluster(count, place, card, seed, flat = false) {
  const r = mulberry32(seed);
  const cards = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  // 階層風（GPU Gems 3, Crysis）: クラスタ＝枝先タフトを 1 単位として
  // 同位相で揺らすため、タフト共通の位相を属性に焼く
  const windPhase = r() * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    const o = place(r);
    const g = card.clone();
    if (flat) {
      // 広葉樹: 葉は重力と光に応じて水平寄りに広がる（±30°程度）
      e.set(-Math.PI / 2 * 0.75 + (r() - 0.5) * 1.0, r() * Math.PI * 2, (r() - 0.5) * 0.6);
    } else {
      e.set((r() - 0.5) * Math.PI * 1.2, r() * Math.PI * 2, (r() - 0.5) * Math.PI);
    }
    q.setFromEuler(e);
    p.set(o.x, o.y, o.z);
    s.setScalar(o.scale ?? 1);
    m.compose(p, q, s);
    g.applyMatrix4(m);
    const n = g.attributes.position.count;
    const ao = new Float32Array(n).fill(o.ao ?? 1);
    g.setAttribute('aoBake', new THREE.BufferAttribute(ao, 1));
    const wind = new Float32Array(n * 2);
    const weight = Math.min(1, Math.hypot(o.x, o.z) / 2.2); // 幹から遠いほど大きく揺れる
    for (let j = 0; j < n; j++) {
      wind[j * 2] = windPhase;
      wind[j * 2 + 1] = weight;
    }
    g.setAttribute('aWind', new THREE.BufferAttribute(wind, 2));
    cards.push(g);
  }
  return BufferGeometryUtils.mergeGeometries(cards);
}

// 葉カードの法線を「樹冠中心から外向き」に張り替える。
// カードごとのフラット法線では面の向きで明暗が割れて紙くず状に見えるため、
// 樹冠全体をひとつのボリュームとして滑らかに陰影させる（実在ゲームの定番手法）。
// normalFn(x, y, z) -> THREE.Vector3（正規化不要、ここで正規化する）
function sphericalNormals(geometry, normalFn) {
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.copy(normalFn(pos.getX(i), pos.getY(i), pos.getZ(i))).normalize();
    nor.setXYZ(i, v.x, v.y, v.z);
  }
  return geometry;
}

// 樹冠の内側・下側ほど暗くする焼き込み AO（paintGradient の後に呼ぶ）
function applyBakedAO(geometry) {
  const ao = geometry.attributes.aoBake;
  const colors = geometry.attributes.color;
  if (!ao || !colors) return geometry;
  for (let i = 0; i < colors.count; i++) {
    const a = ao.getX(i);
    colors.setXYZ(i, colors.getX(i) * a, colors.getY(i) * a, colors.getZ(i) * a);
  }
  geometry.deleteAttribute('aoBake');
  return geometry;
}

// 明示座標のリストに葉カードを置いてマージする（1 座標につき 2 枚を交差気味に）
function createLeafCardsAt(positions, card, seed) {
  const r = mulberry32(seed);
  const cards = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  for (const o of positions) {
    // 階層風: 房（同一座標の 3 枚）を 1 単位として同位相で揺らす
    const windPhase = r() * Math.PI * 2;
    const weight = Math.min(1, Math.hypot(o.x, o.z) / 2.2);
    for (let k = 0; k < 3; k++) {
      const g = card.clone();
      e.set((r() - 0.5) * Math.PI * 1.2, r() * Math.PI * 2, (r() - 0.5) * Math.PI);
      q.setFromEuler(e);
      p.set(o.x, o.y, o.z);
      s.setScalar(o.scale ?? 1);
      m.compose(p, q, s);
      g.applyMatrix4(m);
      const n = g.attributes.position.count;
      const ao = new Float32Array(n).fill(o.ao ?? 1);
      g.setAttribute('aoBake', new THREE.BufferAttribute(ao, 1));
      const wind = new Float32Array(n * 2);
      for (let j = 0; j < n; j++) {
        wind[j * 2] = windPhase;
        wind[j * 2 + 1] = weight;
      }
      g.setAttribute('aWind', new THREE.BufferAttribute(wind, 2));
      cards.push(g);
    }
  }
  return BufferGeometryUtils.mergeGeometries(cards);
}

// 針葉樹の樹冠: 幹から放射状に伸びる枝（下ほど長い）に沿って葉房を置き、
// モミの木の「段々の層」シルエットを作る。円錐に一様に撒くより枝の構造が読める
// 針葉樹の構造: 段ごとの放射状の枝（実ジオメトリ付き）と、枝に沿った針葉の房。
// 枝を実際に描くことで「葉群が宙に浮く」のを防ぐ
function createConiferStructure(card, seed) {
  const r = mulberry32(seed);
  const positions = [];
  const branchGeos = [];
  const whorls = 8;        // 枝の段数
  const yMin = 2.0;
  const yMax = 6.5;
  for (let w = 0; w < whorls; w++) {
    const t = w / (whorls - 1);
    const y = yMin + (yMax - yMin) * t;
    const maxLen = (1 - t) * 2.0 + 0.25; // 下の枝ほど長い
    const branches = 5 + Math.floor(r() * 3);
    const yawOff = r() * Math.PI * 2;
    for (let b = 0; b < branches; b++) {
      const yaw = yawOff + (b / branches) * Math.PI * 2 + (r() - 0.5) * 0.5;
      // 枝の実ジオメトリ（やや垂れて先で持ち上がる先端へ向かう細い円柱）
      const tipDroop = -maxLen * 0.18 + 0.08;
      const p0 = new THREE.Vector3(0, y, 0);
      const p1 = new THREE.Vector3(Math.cos(yaw) * maxLen, y + tipDroop, Math.sin(yaw) * maxLen);
      branchGeos.push(cylinderBetween(p0, p1, 0.04 * (1.2 - t * 0.5), 0.012));
      const tufts = 2 + Math.floor(r() * 2);
      for (let k = 0; k < tufts; k++) {
        const f = (k + 1) / tufts; // 枝に沿った位置（先端 = 1）
        const len = maxLen * f;
        const droop = -len * 0.18 + f * 0.08;
        positions.push({
          x: Math.cos(yaw) * len,
          y: y + droop + (r() - 0.5) * 0.1,
          z: Math.sin(yaw) * len,
          scale: 0.7 + f * 0.55 + r() * 0.25,
          ao: 0.65 + 0.35 * f, // 幹に近い内側ほど陰る
        });
      }
    }
  }
  positions.push({ x: 0, y: yMax + 0.25, z: 0, scale: 0.8, ao: 1 }); // 頂部の房
  return {
    crown: createLeafCardsAt(positions, card, seed + 1),
    branches: BufferGeometryUtils.mergeGeometries(branchGeos),
  };
}

// 楕円球ボリューム（広葉樹の葉塊用）。球内に一様分布
function blobVolume(cx, cy, cz, rx, ry, rz) {
  return (rnd) => {
    const theta = rnd() * Math.PI * 2;
    const phi = Math.acos(2 * rnd() - 1);
    const rr = Math.cbrt(rnd());
    return {
      x: cx + Math.sin(phi) * Math.cos(theta) * rx * rr,
      y: cy + Math.cos(phi) * ry * rr,
      z: cz + Math.sin(phi) * Math.sin(theta) * rz * rr,
      scale: 0.8 + rnd() * 0.6,
      ao: 0.7 + 0.3 * rr, // 塊の中心ほど陰る（下げすぎると黒切り絵になる）
    };
  };
}

// 幹に曲がりと根元の張り出しを与える（displace の前に呼ぶ）
function shapeTrunk(geometry, height, bendAmp, flare) {
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = Math.min(1, Math.max(0, y / height));
    // ゆるい S 字の曲がり
    const bend = Math.sin(t * Math.PI) * bendAmp;
    // 根元のフレア（下端ほど外へ広げる）
    const f = 1 + flare * Math.pow(Math.max(0, 1 - y / (height * 0.25)), 2);
    pos.setX(i, pos.getX(i) * f + bend);
    pos.setZ(i, pos.getZ(i) * f);
  }
  geometry.computeVertexNormals();
  return geometry;
}

// 2 点間を結ぶテーパー円柱（枝のセグメント）
function cylinderBetween(p0, p1, r0, r1) {
  const dir = new THREE.Vector3().subVectors(p1, p0);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, 6);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    dir.clone().normalize()
  );
  const m = new THREE.Matrix4().compose(p0, q, new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(m);
  return g;
}

// Space Colonization（Runions et al., NPH 2007）による広葉樹の枝生成。
// 樹冠ボリュームに撒いた引力点に向かって枝が伸び、本物の分岐階層
// （幹→大枝→小枝→末端）が生成される。太さはパイプモデル（Murray の法則）。
// tips には葉タフトを置くべき末端ノードを返す
function createBroadleafSkeleton(seed) {
  const r = mulberry32(seed);
  const INFLUENCE = 2.4;   // 引力点がノードを引き寄せる半径
  const KILL = 0.4;        // 点が消える距離
  const STEP = 0.34;       // 1 反復の成長距離
  const CROWN = { x: 0, y: 3.4, z: 0, rx: 2.3, ry: 1.7, rz: 2.3 };

  // 引力点: 樹冠の楕円球内に一様分布
  const attractors = [];
  for (let i = 0; i < 250; i++) {
    const theta = r() * Math.PI * 2;
    const phi = Math.acos(2 * r() - 1);
    const rr = Math.cbrt(r());
    attractors.push(new THREE.Vector3(
      CROWN.x + Math.sin(phi) * Math.cos(theta) * CROWN.rx * rr,
      CROWN.y + Math.cos(phi) * CROWN.ry * rr,
      CROWN.z + Math.sin(phi) * Math.sin(theta) * CROWN.rz * rr
    ));
  }

  // ノード: 幹の柱（成長の起点）。parent=-1 が根
  const nodes = [{ p: new THREE.Vector3(0, 0, 0), parent: -1 }];
  for (let y = 0.45; y <= 1.85; y += 0.45) {
    nodes.push({ p: new THREE.Vector3((r() - 0.5) * 0.1, y, (r() - 0.5) * 0.1), parent: nodes.length - 1 });
  }

  // 成長反復
  const dir = new THREE.Vector3();
  for (let iter = 0; iter < 120 && attractors.length > 0; iter++) {
    // 各引力点を影響半径内の最近傍ノードに紐付け
    const pull = new Map(); // nodeIndex -> 方向ベクトル和
    for (const a of attractors) {
      let bi = -1;
      let bd = INFLUENCE;
      for (let i = 0; i < nodes.length; i++) {
        const d = a.distanceTo(nodes[i].p);
        if (d < bd) { bd = d; bi = i; }
      }
      if (bi >= 0) {
        dir.subVectors(a, nodes[bi].p).normalize();
        if (!pull.has(bi)) pull.set(bi, new THREE.Vector3());
        pull.get(bi).add(dir);
      }
    }
    if (pull.size === 0) break;
    // 紐付いたノードから新ノードを伸ばす（わずかに上向きバイアス）
    for (const [i, v] of pull) {
      v.normalize().y += 0.08;
      const np = nodes[i].p.clone().addScaledVector(v.normalize(), STEP);
      nodes.push({ p: np, parent: i });
    }
    // 殺到半径内の引力点を消す
    for (let k = attractors.length - 1; k >= 0; k--) {
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (attractors[k].distanceTo(nodes[i].p) < KILL) {
          attractors.splice(k, 1);
          break;
        }
      }
    }
  }

  // パイプモデルで太さを決める: 末端 r_min、親 = (Σ 子^2.5)^(1/2.5)
  const childCount = new Array(nodes.length).fill(0);
  for (const n of nodes) if (n.parent >= 0) childCount[n.parent]++;
  const radius = new Array(nodes.length).fill(0);
  // 末端から根へ向かって伝播（ノードは生成順 = 親が先なので逆順走査でよい）
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (childCount[i] === 0) radius[i] = 0.022;
    if (nodes[i].parent >= 0) {
      const p = nodes[i].parent;
      radius[p] = Math.pow(Math.pow(radius[p], 2.5) + Math.pow(radius[i], 2.5), 1 / 2.5);
    }
  }

  // エッジをテーパー円柱にしてマージ。根元はフレア
  const parts = [];
  const tips = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.parent >= 0) {
      const rp = Math.min(0.5, radius[n.parent]);
      const rc = Math.min(0.45, radius[i]);
      const flare = n.parent === 0 ? 1.5 : 1.0; // 最下段は根元を広げる
      parts.push(cylinderBetween(nodes[n.parent].p, n.p, rp * flare, rc));
    }
    if (childCount[i] === 0) tips.push({ x: n.p.x, y: n.p.y, z: n.p.z });
  }

  return { trunk: BufferGeometryUtils.mergeGeometries(parts), tips };
}

// 樹皮の色: 高さグラデーション + fbm のむら（のっぺり感を消す）
function paintBark(geometry, bottomHex, topHex, yMin, yMax, seed) {
  paintGradient(geometry, bottomHex, topHex, yMin, yMax);
  const pos = geometry.attributes.position;
  const colors = geometry.attributes.color;
  for (let i = 0; i < pos.count; i++) {
    const v = 0.85 + fbm(pos.getX(i) * 3 + seed, pos.getY(i) * 2.2 + pos.getZ(i) * 3, 3, seed) * 0.3;
    colors.setXYZ(i, colors.getX(i) * v, colors.getY(i) * v, colors.getZ(i) * v);
  }
  return geometry;
}

// 条件を満たす地点をばら撒く（rejection sampling）
function scatter(count, accept) {
  const points = [];
  let attempts = 0;
  const maxAttempts = count * 40;
  while (points.length < count && attempts < maxAttempts) {
    attempts++;
    const x = (rand() - 0.5) * WORLD_SIZE * 0.92;
    const z = (rand() - 0.5) * WORLD_SIZE * 0.92;
    const h = terrainHeight(x, z);
    if (accept(x, z, h)) points.push({ x, z, h });
  }
  return points;
}

// 配置（位置・回転・スケール・色味）を一度だけ確定させる。
// 幹と樹冠を別メッシュにしても配置がズレないよう、rand の消費をここに集約する。
function computePlacements(points, place) {
  const axisY = new THREE.Vector3(0, 1, 0);
  return points.map((p) => {
    const o = place(p);
    const quaternion = new THREE.Quaternion().setFromAxisAngle(axisY, rand() * Math.PI * 2);
    return { p, o, quaternion };
  });
}

function buildInstances(geometry, material, placements, useTint = true) {
  const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const color = new THREE.Color();

  placements.forEach(({ p, o, quaternion }, i) => {
    position.set(p.x, p.h + (o.sink ?? 0), p.z);
    scale.setScalar(o.scale);
    if (o.scaleY) scale.y = o.scale * o.scaleY;
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(i, matrix);
    if (useTint && o.tint) {
      color.setHSL(o.tint.h, o.tint.s, o.tint.l);
      mesh.setColorAt(i, color);
    }
  });
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

// 幹（樹皮法線マップ）と葉カードの樹冠を別メッシュで作り、同じ配置で重ねる
function assembleTree(trunkGeo, crownGeo, points, place, uniforms, leafTex = leafClusterTexture()) {
  const placements = computePlacements(points, place);
  const trunkMesh = buildInstances(trunkGeo, standardMaterial({
    normalMap: barkNormalMap(),
    normalScale: new THREE.Vector2(0.5, 0.5),
    roughness: 0.9,
  }), placements, false);
  const crownMesh = buildInstances(crownGeo, leafMaterial(uniforms, { map: leafTex }), placements, true);
  crownMesh.customDepthMaterial = leafDepthMaterial(leafTex);
  // GTAO のプリパスは alphaTest 非対応で葉カードが矩形の AO を焼くため除外する
  crownMesh.userData.excludeFromGTAO = true;
  const group = new THREE.Group();
  [trunkMesh, crownMesh].forEach((m) => {
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  });
  return group;
}

// 針葉樹 1 変種: 幹 + 実体のある枝 + 枝に沿った針葉の房
function createConiferVariant(seed) {
  const r = mulberry32(seed);
  // 幹: 樹冠の最上段（y6.5）近くまで細く続く
  let trunk = BufferGeometryUtils.mergeVertices(new THREE.CylinderGeometry(0.06, 0.34, 6.4, 8, 8));
  trunk.translate(0, 3.2, 0);
  shapeTrunk(trunk, 6.4, 0.05 + r() * 0.04, 0.5);

  const card = makeLeafCard(0.42, 0.82);
  const { crown, branches } = createConiferStructure(card, seed);
  trunk = BufferGeometryUtils.mergeGeometries([trunk, branches]);
  paintBark(trunk, 0x4a3826, 0x5d4630, 0, 6.4, seed % 100);

  // 円錐の軸から放射状 + やや上向きの法線で、樹冠全体を滑らかに陰影させる
  sphericalNormals(crown, (x, y, z) => new THREE.Vector3(x, 0.55, z));
  paintGradient(crown, 0x244a1e, 0x5c8f3c, 1.9, 6.7);
  applyBakedAO(crown);
  return { trunk, crown };
}

function createConifers(uniforms) {
  // シード違いの変種で「全部同じ木」感を消す
  const variants = [7501, 7603, 7707].map(createConiferVariant);

  const points = scatter(1400, (x, z, h) => {
    if (h < WATER_LEVEL + 2 || h > 30) return false;
    if (terrainSlope(x, z) > 0.85) return false;
    return forestDensity(x, z) > 0.55;
  });
  const buckets = variants.map(() => []);
  for (const p of points) buckets[Math.floor(rand() * variants.length)].push(p);

  const group = new THREE.Group();
  variants.forEach((v, i) => {
    if (buckets[i].length === 0) return;
    group.add(assembleTree(v.trunk, v.crown, buckets[i], () => ({
      scale: 0.8 + rand() * 1.1,
      sink: -0.15,
      tint: { h: 0.28 + rand() * 0.06, s: 0.25 + rand() * 0.2, l: 0.5 + rand() * 0.18 },
    }), uniforms));
  });
  return group;
}

// 広葉樹 1 変種: Space Colonization の末端ノードごとに小さな葉タフトを置く。
// 葉が「枝の末端に付く」という本物の構造が、大クラスタ方式より自然に出る
function createBroadleafVariant(seed) {
  const { trunk, tips } = createBroadleafSkeleton(seed);
  paintBark(trunk, 0x55432e, 0x6b5238, 0, 5.2, seed % 100);

  const card = makeLeafCard(0.38, 0.52);
  const clusters = tips.map((t, i) => {
    // 樹冠中心からの距離で AO（内側の末端ほど陰る）
    const depth = Math.min(1, Math.hypot(t.x, (t.y - 3.4) / 0.74, t.z) / 2.3);
    const place = blobVolume(t.x, t.y, t.z, 0.36, 0.3, 0.36);
    return createLeafCluster(9, (rnd) => {
      const o = place(rnd);
      o.ao = 0.6 + 0.4 * depth;
      return o;
    }, card, seed * 13 + i, true);
  });
  const crown = BufferGeometryUtils.mergeGeometries(clusters);
  // 樹冠全体をひとつのボリュームとして陰影させる（中心から外向きの法線）
  sphericalNormals(crown, (x, y, z) => new THREE.Vector3(x, (y - 3.4) * 0.8, z));
  paintGradient(crown, 0x33591f, 0x79aa46, 1.8, 5.6);
  applyBakedAO(crown);
  return { trunk, crown };
}

function createBroadleaves(uniforms) {
  // シード違いの変種で「全部同じ木」感を消す
  const variants = [9101, 9203, 9407].map(createBroadleafVariant);

  // 草原にぽつぽつ生える広葉樹（森の外側）
  const points = scatter(280, (x, z, h) => {
    if (h < WATER_LEVEL + 2 || h > 26) return false;
    if (terrainSlope(x, z) > 0.7) return false;
    const f = forestDensity(x, z);
    return f > 0.35 && f < 0.55 && rand() < 0.5;
  });
  const buckets = variants.map(() => []);
  for (const p of points) buckets[Math.floor(rand() * variants.length)].push(p);

  const group = new THREE.Group();
  variants.forEach((v, i) => {
    if (buckets[i].length === 0) return;
    group.add(assembleTree(v.trunk, v.crown, buckets[i], () => ({
      scale: 0.7 + rand() * 0.9,
      sink: -0.15,
      tint: { h: 0.24 + rand() * 0.08, s: 0.25 + rand() * 0.15, l: 0.5 + rand() * 0.15 },
    }), uniforms, broadleafTexture()));
  });
  return group;
}

// 森の下草（低木）。葉クラスタ基盤を再利用し、森の下層に茂みの密度感を作る
function createBushes(uniforms) {
  const card = makeLeafCard(0.34, 0.5);
  const bush = createLeafCluster(110, blobVolume(0, 0.45, 0, 0.75, 0.5, 0.75), card, 909, true);
  sphericalNormals(bush, (x, y, z) => new THREE.Vector3(x, y - 0.2, z));
  paintGradient(bush, 0x2a4a1c, 0x567f35, 0, 0.95);
  applyBakedAO(bush);

  // 森の中＋森の縁に集中させる（開けた草原には置かない）
  const points = scatter(1800, (x, z, h) => {
    if (h < WATER_LEVEL + 1.8 || h > 28) return false;
    if (terrainSlope(x, z) > 0.8) return false;
    return forestDensity(x, z) > 0.45 && rand() < 0.7;
  });

  const placements = computePlacements(points, () => ({
    scale: 0.6 + rand() * 1.0,
    scaleY: 0.7 + rand() * 0.5,
    sink: -0.08,
    tint: { h: 0.25 + rand() * 0.08, s: 0.3 + rand() * 0.2, l: 0.45 + rand() * 0.2 },
  }));
  const mesh = buildInstances(bush, leafMaterial(uniforms, { map: broadleafTexture() }), placements);
  mesh.customDepthMaterial = leafDepthMaterial(broadleafTexture());
  mesh.userData.excludeFromGTAO = true; // 樹冠と同じく矩形 AO を防ぐ
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// 上向きの面に苔を、それ以外に露出岩肌を頂点カラーで塗り分ける（簡易 AO 込み）
function paintRock(geometry) {
  const moss = new THREE.Color(0x4a5a32);
  const stoneLow = new THREE.Color(0x4d473d);
  const stoneHigh = new THREE.Color(0x9a948a);
  const tmp = new THREE.Color();
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    // 高さで岩肌の明暗（下＝谷間が暗い簡易 AO）、上向き度で苔の量を決める
    const t = Math.min(1, Math.max(0, (pos.getY(i) + 1) / 2));
    tmp.lerpColors(stoneLow, stoneHigh, t);
    const up = Math.max(0, nor.getY(i));
    const mossiness = Math.pow(up, 2.5) * 0.7 * (0.5 + 0.5 * fbm(pos.getX(i) * 1.5, pos.getZ(i) * 1.5, 3, 61));
    tmp.lerp(moss, mossiness);
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function createRocks() {
  // 高 detail の正二十面体を多重スケールで変位させ、割れ目・段差・ザラつきを作る
  let geometry = BufferGeometryUtils.mergeVertices(new THREE.IcosahedronGeometry(1, 4));
  displace(geometry, 0.42, 0.8, 41);
  displace(geometry, 0.16, 2.2, 47);
  displace(geometry, 0.05, 5.2, 53);
  geometry.computeVertexNormals();
  paintRock(geometry);
  const material = standardMaterial({
    roughness: 1.0,
    normalMap: rockNormalMap(),
    roughnessMap: rockRoughnessMap(),
    normalScale: new THREE.Vector2(0.7, 0.7),
  });

  const points = scatter(180, (x, z, h) => h > WATER_LEVEL - 2 && h < 35);

  const placements = computePlacements(points, () => ({
    scale: 0.4 + rand() * 1.6,
    scaleY: 0.6 + rand() * 0.4,
    sink: -0.3,
    tint: { h: 0.1, s: 0.02 + rand() * 0.06, l: 0.45 + rand() * 0.2 },
  }));
  const mesh = buildInstances(geometry, material, placements);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function createFlowers() {
  // 細い茎 + 花弁テクスチャの上向きヘッド。十字の白い矩形をやめ、
  // 5 弁シルエットのアルファカットアウトで「花」として読めるようにする。
  // 草（高さ ~0.7m）から花が覗くように少し背を高くする
  const stem = new THREE.PlaneGeometry(0.03, 0.55).translate(0, 0.275, 0);
  {
    const c = new THREE.Color(0x3f7a33);
    const n = stem.attributes.position.count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    stem.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  const stemMaterial = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  stemMaterial.reflectivity = 0;

  // 上向きの花ヘッド（少し傾けて表情をつける。向きは配置のヨー回転でばらける）
  const head = new THREE.PlaneGeometry(0.16, 0.16)
    .rotateX(-Math.PI / 2 + 0.35)
    .translate(0, 0.56, 0);
  const headMaterial = new THREE.MeshLambertMaterial({
    side: THREE.DoubleSide,
    map: flowerTexture(),
    alphaTest: 0.5,
  });
  headMaterial.reflectivity = 0;

  // 開けた草原（森の外）に群生させる
  const points = scatter(9000, (x, z, h) => {
    if (h < WATER_LEVEL + 1.6 || h > 22) return false;
    if (forestDensity(x, z) > 0.5) return false;
    return terrainSlope(x, z) < 0.5;
  });

  // Bloom 閾値（0.85）を超えて白飛びしないよう明度を抑える
  const palette = [
    { h: 0.12, s: 0.85, l: 0.6 },  // 黄
    { h: 0.0, s: 0.0, l: 0.82 },   // 白
    { h: 0.9, s: 0.55, l: 0.68 },  // 桃
    { h: 0.75, s: 0.45, l: 0.64 }, // 紫
  ];
  const placements = computePlacements(points, () => {
    const p = palette[Math.floor(rand() * palette.length)];
    return {
      scale: 0.8 + rand() * 0.6,
      tint: { h: p.h + rand() * 0.02, s: p.s, l: p.l + rand() * 0.06 },
    };
  });
  const group = new THREE.Group();
  const stems = buildInstances(stem, stemMaterial, placements, false);
  const heads = buildInstances(head, headMaterial, placements, true);
  // 木陰では花も暗くする。反射に映す必要はない
  for (const m of [stems, heads]) {
    m.receiveShadow = true;
    m.layers.set(1);
  }
  group.add(stems, heads);
  return group;
}

export function createVegetation(uniforms) {
  const group = new THREE.Group();
  group.add(createConifers(uniforms));
  group.add(createBroadleaves(uniforms));
  group.add(createBushes(uniforms));
  group.add(createRocks());
  group.add(createFlowers());
  return group;
}
