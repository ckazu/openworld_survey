The critique's two highest-risk source claims are confirmed: water's reflection RT renders synchronously inside `userData.update(time)` at water.js:227 (not inside `composer.render()`), and reflCam.far=1200 at line 217. The smoothstep early-return behavior is a well-established three.js fact. I have enough to produce the corrected blueprint.

---

# Day/Night Celestial System — Authoritative Implementation Blueprint (v2, critique-integrated)

three.js r0.184 · `WebGLRenderer` + `EffectComposer` · no external libs. All paths absolute. Conflicts between the six inputs resolved inline with **[DECISION]**; adversarial critique findings folded in inline and tagged **[FIXED Cn]** / **[FIXED Mn]** / **[NOTE mn]**.

## 0. Conflicts resolved (read first)

| # | Conflict | Decision & justification |
|---|---|---|
| C1 | **Astronomy source**: F NOAA/J2000 vs A Schlyter (JD 2451543.5). | **Use A (Schlyter), one module `celestial.js`.** Verified to machine precision; F's `j2000()` has ~0.9° sun error + different epoch — mixing breaks moon/star LST agreement. |
| C2 | **LST source**: A `meanLon`-driven GMST vs E Meeus. | **One shared GMST helper** drives sun, moon AND stars (see §2 `gmst()`). E's separate `computeLST` dropped. **[FIXED M2]** — a single `gmst(date, sunMeanLon)` fn is called by both `horizontal()` and `localSiderealTimeDeg()`; no parallel transcription. |
| C3 | **Fog uniform names**: B vs C. | **Use B's names** (`uFogSunDir/uFogSunColor/uFogNight/uFogNightColor`). Ref-aliasing per material (B §1d), not `UniformsLib.fog` mutation — already-merged ShaderMaterials are deep-cloned by `UniformsUtils.merge`, so mutation does not retroactively alias them. |
| C4 | **Where uniforms declared**: per-material vs global chunk. | **Declare in global `fog_pars_fragment`.** Guarantees no `undeclared identifier` link error. **[FIXED critique-C3]**: this declaration is **mandatory, not optional** — the current `sky.js` lines 28–39 do NOT declare them; the §3a edit adds them. EXP2 materials whose `applyDynamicFog` ran get live refs; missed EXP2 materials link but sample zero (acceptable). |
| C5 | **Moon fog**: B global rewrite vs D self-contained `uFogScale`. | **D for moon mesh.** Moon does NOT `#include <fog_fragment>`; replicates single-scattering at `uFogScale=0.02`. Moon `#include <fog_pars_fragment>` for global decls and is added to `applyDynamicFog`. **[FIXED critique-C5]**: moon material MUST set `fog:true` and scene fog MUST be `FogExp2` (asserted at init, §4e). |
| C6 | **PMREM throttle**: B 250–500ms vs C ≥1.5°/4s/0.5s/skip>25ms. | **Use C verbatim.** |
| C7 | **Toggle key**: B `KeyP/Tab` vs F `KeyO`. | **`KeyO`** + F pointer-lock arbitration. |
| C8 | **`createSky` return shape.** | **B's rich shape; celestial bodies (moon/stars) live in main.js.** `createSky(scene, renderer, sharedUniforms)` returns `{ sky, sunDirection, fogUniforms, followPlayer, update, refreshEnv }`. |
| C9 | **Sun color space**: C linear-RGB vs sRGB hex. | **Linear-RGB ramps** via `color.setRGB(r,g,b, THREE.LinearSRGBColorSpace)`; shaders consume linear. |
| C10 | **Moon direction**: D hardcoded vs A ephemeris. | **A's `moonHorizontal` + `moonPhase`.** |
| C11 | **Star LST animation**: E incremental. | **Recompute `LST_deg` from `celestial` each frame** — exact under any time-warp. |
| **C12** | **JS `smoothstep(min>max)`** assumed "handled correctly." | **[FIXED critique-C1 — CRITICAL]** FALSE. `THREE.MathUtils.smoothstep(x,min,max)` early-returns `0` if `x<=min` and `1` if `x>=max`, evaluated **before** any divide. Passing `min>max` inverts the ramp (full night at noon). **All falling JS ramps use a dedicated `fall()` helper** (§2). GLSL `smoothstep` clamps symmetrically and is unaffected — only JS-side ramps were broken. |
| **C13** | **Water RT render site / loop order.** | **[FIXED critique-C2 — CRITICAL]** Water reflection/refraction render synchronously inside `water.userData.update(time)` (water.js:227/238), NOT inside `composer.render()`. Therefore moon/stars must be updated **before** `water.userData.update`. Corrected per-frame order in §8. |

---

## 1. MODULE / FILE PLAN

### New files
- **`/Users/ckazu/work/openworld_survey/src/celestial.js`** — pure astronomy (Schlyter). Exports `sunHorizontal`, `moonHorizontal`, `moonPhase`, `localSiderealTimeDeg`, `altAzToVector`, ramp helpers `sunLightColor`, `sunColorE`, `kAboveHor`, `nightFactor`, `fall`, plus internal shared `gmst`. No scene objects.
- **`/Users/ckazu/work/openworld_survey/src/clock.js`** — `createSimClock`, `SPEED_PRESETS` (incl. 144× default), `CITY_PRESETS` (F §1 verbatim).
- **`/Users/ckazu/work/openworld_survey/src/moon.js`** — `createMoon(scene, fogUniforms)` (D + C5 fog + C10 real-dir).
- **`/Users/ckazu/work/openworld_survey/src/stars.js`** — `createStarField({latitudeDeg})` → `{ group, update(latDeg, lstDeg, sunDirY, dt, time) }` (E + C2/C11 LST).
- **`/Users/ckazu/work/openworld_survey/src/ui/settings.js`** — `createSettingsPanel` (F §4 verbatim incl. tz helpers).
- **`src/astronomy.js` — NOT created.** Folded into `celestial.js`.

### Edited files
- **`src/sky.js`** — rewrite `patchFogChunks()` (uniforms, no consts); add `applyDynamicFog` export; add `fogUniforms`; signature `createSky(scene, renderer, sharedUniforms)`; build `update(sunDir, moonAlt, illum)` / `refreshEnv(now, frameMs)`; persistent PMREM with **dedicated env scene owning its own Sky clone**; add `moonLight`.
- **`src/main.js`** — import clock/celestial/moon/stars/settings; build them; `scene.traverse` fog safety pass; loop reorder (§8); HUD 4 lines; `KeyO` wiring; assert `scene.fog instanceof THREE.FogExp2`.
- **`src/grass.js`** — fold 4 `uFog*` refs into existing `onBeforeCompile`.
- **`index.html`** — `#settings` panel HTML+CSS; 4-line `#hud`; `O` row in overlay controls.
- **`src/terrain.js`, `src/vegetation.js`, `src/ambience.js`, `src/water.js`** — **no source edits**; covered by main.js `scene.traverse` safety pass (their meshes exist at init).

---

## 2. ASTRONOMY API — `src/celestial.js`

```js
import * as THREE from 'three';
const RAD = Math.PI/180, DEG = 180/Math.PI;
const rev = x => x - Math.floor(x/360)*360;
const sind=x=>Math.sin(x*RAD), cosd=x=>Math.cos(x*RAD), tand=x=>Math.tan(x*RAD);
const atan2d=(y,x)=>Math.atan2(y,x)*DEG;

// --- epoch: Schlyter day number, JD 2451543.5 ---
function julianDate(date){ return date.getTime()/86400000 + 2440587.5; }
function dayNumber(date){ return julianDate(date) - 2451543.5; }

export function sunEquatorial(date){ /* A §2 verbatim → {RA,Dec,lon,r,meanLon,M} */ }
export function moonEquatorial(date){ /* A §3 verbatim → {RA,Dec,lon,lat,distanceEarthRadii,meanLon} */ }

// [FIXED M2] ONE shared GMST. Called by BOTH horizontal() and localSiderealTimeDeg().
// Returns GMST in DEGREES (sidereal at Greenwich). LST = rev(gmst + lonEast).
function gmst(date, sunMeanLon){
  const UT = date.getUTCHours()+date.getUTCMinutes()/60+date.getUTCSeconds()/3600
           + date.getUTCMilliseconds()/3.6e6;
  const GMST0 = rev(sunMeanLon + 180);          // degrees (Schlyter: L+180)
  return rev(GMST0 + UT*15.0);                   // degrees; 15°/h
}
export function localSiderealTimeDeg(date, lonEastDeg, sunMeanLon){
  return rev(gmst(date, sunMeanLon) + lonEastDeg); // degrees
}

// shared horizontal transform — uses the SAME gmst() as localSiderealTimeDeg (M2 lock)
function horizontal(date, RA, Dec, latDeg, lonEastDeg, sunMeanLon){
  const lstDeg = localSiderealTimeDeg(date, lonEastDeg, sunMeanLon);
  const HA = rev(lstDeg - RA);                    // hour angle, degrees
  const sinAlt = sind(Dec)*sind(latDeg) + cosd(Dec)*cosd(latDeg)*cosd(HA);
  const altitude = Math.asin(THREE.MathUtils.clamp(sinAlt,-1,1));
  // azimuth from North, clockwise toward East (radians)
  const y = -cosd(Dec)*cosd(latDeg)*0 ; // placeholder removed below
  const azimuth = Math.atan2(
    sind(HA),
    cosd(HA)*sind(latDeg) - tand(Dec)*cosd(latDeg)
  ) + Math.PI;                                    // +π → North-origin, CW-East
  return { altitude, azimuth };
}

export function sunHorizontal(date, latDeg, lonEastDeg){
  const s = sunEquatorial(date);
  return { ...horizontal(date, s.RA, s.Dec, latDeg, lonEastDeg, s.meanLon), meanLon: s.meanLon };
}
export function moonHorizontal(date, latDeg, lonEastDeg){
  const m = moonEquatorial(date), s = sunEquatorial(date);   // [NOTE m4] sun computed 2nd time/frame; deterministic, acceptable
  return { ...horizontal(date, m.RA, m.Dec, latDeg, lonEastDeg, s.meanLon),
           distanceEarthRadii: m.distanceEarthRadii, meanLon: s.meanLon };
}
const _phase = { illuminatedFraction:0, waxing:false, phaseAngle:0 };
export function moonPhase(date, out=_phase){ /* A §4 → writes into out (reused, no per-frame alloc) [NOTE m4] */ return out; }

// alt/az (radians) → three.js Y-up vector (North=−Z, East=+X, Up=+Y)
export function altAzToVector(altitude, azimuth, out=new THREE.Vector3()){
  const ca = Math.cos(altitude);
  return out.set(ca*Math.sin(azimuth), Math.sin(altitude), -ca*Math.cos(azimuth));
}
```

**Convention lock (consistent across §4–§6):**
- World frame: **North = −Z, East = +X, Up = +Y, South = +Z**.
- Azimuth from North, clockwise toward East (radians).
- **`altAzToVector` is canonical. F's `setFromSphericalCoords(1, 90−elev, az)` is dropped** (different azimuth origin). The static sun in `sky.js` is replaced by `altAzToVector(sunAlt, sunAz)`. **[NOTE M1]** Verified self-consistent: az=90° (East)→+X; az=0 (North)→−Z. Pre-ship grep `uSunDir.xz` / `sunDirection.x` in water.js to confirm no specular-glint azimuth assumption broke (water reads `uSunDir.y` for elevation only — confirmed no edit needed).
- **One LST** from `localSiderealTimeDeg(date, lon, sun.meanLon)` feeds the §2 transform AND the §6 star group — identical number, cannot diverge.

### Ramp helpers (C9 linear RGB + C12 smoothstep fix), in `celestial.js`

```js
const lerp = THREE.MathUtils.lerp;
const ss   = THREE.MathUtils.smoothstep;          // rising only; min<max ALWAYS
// [FIXED C12] dedicated falling ramp — never pass min>max to THREE.MathUtils.smoothstep
export const fall = (x, hi, lo) => 1 - ss(x, lo, hi);   // 1 below lo, 0 above hi; lo<hi

function rampRGB(table, a, out){ /* piecewise-linear over table[{a,rgb}], linear space, writes into out [NOTE m4] */ }

// sun directional-light color (linear), C §2 table
const SUN_C = [
  {a:60,rgb:[1.00,0.98,0.95]},{a:30,rgb:[1.00,0.95,0.86]},{a:12,rgb:[1.00,0.83,0.62]},
  {a:6,rgb:[1.00,0.66,0.40]},{a:2,rgb:[1.00,0.50,0.26]},{a:0,rgb:[0.98,0.38,0.18]}];
export function sunLightColor(a, out=new THREE.Color()){ return rampRGB(SUN_C,a,out); }

// kAboveHor: 0 below −6°, 1 at/above 0° (RISING — valid smoothstep edges)
export const kAboveHor = a => ss(a, -6, 0);

// sun irradiance E for fog (= sun color × kAboveHor)
export function sunColorE(a, out=new THREE.Color()){
  return sunLightColor(Math.max(a,0), out).multiplyScalar(kAboveHor(a));
}

// nightFactor: 0 day → 1 night. FALLING ramp → use fall(), NOT smoothstep(a,2,-8). [FIXED C12]
export const nightFactor = a => fall(a, 2, -8);   // 0 above +2°, 1 below −8°
```

> **[FIXED C12]** `kAboveHor` is rising (`-6→0`, valid). `nightFactor` and the star fade are falling → expressed via `fall(x, hi, lo)` which internally calls `ss(x, lo, hi)` with `lo<hi`. No `THREE.MathUtils.smoothstep` call anywhere receives `min>max`. Sanity: `nightFactor(60)=fall(60,2,-8)=1-ss(60,-8,2)=1-1=0` (day at noon ✓); `nightFactor(-30)=1-ss(-30,-8,2)=1-0=1` (night at midnight ✓).

---

## 3. DYNAMIC FOG REFACTOR

### 3a. `patchFogChunks()` rewrite — `src/sky.js`

`fog_pars_vertex` / `fog_vertex` **unchanged** (keep `vFogWorldPos` + `position`-based world pos — water/cloud ShaderMaterials lack `transformed`). Replace `fog_pars_fragment` and `fog_fragment`. **[FIXED critique-C4]** the uniform declarations below are mandatory — current sky.js does not have them.

```js
function patchFogChunks() {  // no args (C9, drop baked consts)
  THREE.ShaderChunk.fog_pars_vertex = /* unchanged */;
  THREE.ShaderChunk.fog_vertex      = /* unchanged */;

  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogWorldPos;
  uniform vec3  uFogSunDir;
  uniform vec3  uFogSunColor;
  uniform float uFogNight;
  uniform vec3  uFogNightColor;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;

  THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
  {
    vec3 FOG_SUN_DIR = uFogSunDir;
    vec3 FOG_SUN_E   = uFogSunColor * 1.15;
    const vec3 FOG_RAYLEIGH_TINT = vec3(0.42, 0.60, 1.0);
    const vec3 FOG_MIE_TINT      = vec3(1.0, 0.86, 0.66);
    vec3  fogView = vFogWorldPos - cameraPosition;
    float fogDist = length(fogView);
    float cosT    = dot(fogView / max(fogDist, 1e-4), FOG_SUN_DIR);
    float fogHeight = exp( -max( 0.0, vFogWorldPos.y - ${WATER_LEVEL.toFixed(2)} ) * 0.16 );
    float dens = fogDensity * ( 1.0 + fogHeight * 1.8 );
    float bR = dens * 0.62, bM = dens * 0.38;
    float ext = exp( -(bR + bM) * fogDist );
    float phR = 0.0597 * ( 1.0 + cosT * cosT );
    const float g = 0.5;
    float phM = 0.0796 * (1.0-g)*(1.0-g) / pow(1.0 + g*g - 2.0*g*cosT, 1.5);
    vec3 inscatter = FOG_SUN_E
      * ( bR*phR*FOG_RAYLEIGH_TINT + bM*phM*FOG_MIE_TINT ) / (bR+bM) * 6.5;
    inscatter *= (1.0 - uFogNight);                 // kill orange glow at midnight
    inscatter += uFogNightColor * uFogNight;        // night ambient floor (no black fog)
    gl_FragColor.rgb = gl_FragColor.rgb * ext + inscatter * ( 1.0 - ext );
  }
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );  // GLSL smoothstep: symmetric clamp, fine
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
  #endif
#endif`;
}
```

`bR+bM = dens > 0` always (fogDensity ≥ 0.0011), divide never hits 0. Call `patchFogChunks();` in `createSky` (no args). Must run **before** any fog material compiles — `createSky` is at main.js:45, before terrain/water/etc. **Keep that order.**

### 3b. `fogUniforms` object (owned by sky.js, returned by ref)

```js
const fogUniforms = {
  uFogSunDir:     { value: new THREE.Vector3(0,1,0) },
  uFogSunColor:   { value: new THREE.Color(0,0,0) },     // sun irradiance E
  uFogNight:      { value: 0 },
  uFogNightColor: { value: new THREE.Color(0.02, 0.04, 0.09) }, // deep navy, linear
};
```

### 3c. `applyDynamicFog(material, fog)` export — `src/sky.js`

```js
export function applyDynamicFog(material, fog) {
  if (!material || material.fog === false) return material;
  if (material.userData.__dynFog) return material;     // idempotent
  material.userData.__dynFog = true;
  const refs = (u) => {
    u.uFogSunDir = fog.uFogSunDir; u.uFogSunColor = fog.uFogSunColor;
    u.uFogNight = fog.uFogNight;   u.uFogNightColor = fog.uFogNightColor;
  };
  if (material.isShaderMaterial) { refs(material.uniforms); return material; }  // plain assign, NOT re-merge
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    refs(shader.uniforms);
  };
  material.needsUpdate = true;
  return material;
}
```

> **[FIXED critique-C3]** For ShaderMaterials (cloud/water/foam/moon) the branch *adds* the 4 keys to the already-deep-cloned `material.uniforms` object via plain assignment — this works and aliases the shared value objects by reference. The cloud material's `#include <fog_fragment>` references `uFogSunDir` etc.; those keys exist **only because** `applyDynamicFog` ran on it (via traverse). Clouds are `scene.add`-ed before the traverse pass and `ambience.update` builds nothing lazily, so coverage is guaranteed.

### 3d. Exact material coverage (verified against source)

| # | File | Symbol | Type | `fog:true`? | Branch | Covered by |
|---|------|--------|------|---|---|---|
| 1 | terrain.js | createTerrain mat | MeshStandard | yes | EXP2 | traverse |
| 2 | grass.js | createGrassMaterial | MeshPhong | yes | EXP2 | **explicit (lazy)** |
| 3 | vegetation.js | standardMaterial ×7+ | MeshStandard | yes | EXP2 | traverse |
| 4 | vegetation.js | leafMaterial ×many | MeshStandard | yes | EXP2 | traverse |
| 5 | vegetation.js | stemMaterial | MeshLambert | yes | EXP2 | traverse |
| 6 | vegetation.js | headMaterial | MeshLambert | yes | EXP2 | traverse |
| 7 | ambience.js | createBirds | **MeshBasic** | yes(default) | EXP2 | **traverse (trap)** |
| 8 | ambience.js | createButterflies ×4 | **MeshBasic** | yes(default) | EXP2 | **traverse (trap)** |
| 9 | water.js | makeWaterMaterial | ShaderMaterial | yes | EXP2 | traverse (by ref) |
| 10 | water.js | createShoreFoam | ShaderMaterial | yes | EXP2 (`layers.set(1)`) | traverse |
| 11 | ambience.js | createCloudMaterial | ShaderMaterial | yes, **`#include <fog_fragment>`** | EXP2 | traverse (by ref) |
| 12 | moon.js | moon material | ShaderMaterial | **yes**, **NO `fog_fragment`** | declared only | **explicit in createMoon** |

**Skip (no fog chunk):** `leafDepthMaterial` (MeshDepth), `Sky` addon (`fog:false`), stars/milkyway (`fog:false`), all `ShaderPass`es.

> **[NOTE m6]** Birds/butterflies are `MeshBasicMaterial` (unlit). The new EXP2 fog chunk tints them at night, but they do **not** darken with sun/moon like lit geometry — they hold base `0x2a2c30`. Acceptable for distant silhouettes; documented, not fixed.

### 3e. Two injection sites
1. **main.js `scene.traverse` safety pass** (after scene assembly) — catches #1,3,4,5,6,7,8,9,10,11.
2. **Explicit** — grass (#2, lazy meshes) and moon (#12, inside `createMoon`).

```js
// main.js, after all scene.add(...):
scene.traverse((o) => {
  const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
  for (const m of mats) applyDynamicFog(m, fogUniforms);
});
```
Grass: in `createGrassMaterial`'s existing `onBeforeCompile`, add the 4 refs alongside `uSunDir`/`uSunColor`. Pass `fogUniforms` into `createGrassField(sharedUniforms, fogUniforms)`.

---

## 4. SKY & LIGHTING — `src/sky.js`

### Driver
`a = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(sunDir.y,-1,1)))` (degrees).
Per-frame factors (**all rising-edge or `fall()`**, C12-safe):
- `kAboveHor = kAboveHor(a) = ss(a,-6,0)` (rising)
- `kNight = fall(a, 2, -6)` (falling → `fall`) — used by moonlight/light gating
- `kNightFog = nightFactor(a) = fall(a, 2, -8)` (falling → `fall`) — fog

> **[NOTE m7]** Edge pairs are deliberately staggered: fog night `2/−8`, light night `2/−6`, env floor implicit `−6/0`. All share the upper edge `+2°` for the *start* of darkening and differ only in how deep the lower edge goes, so transitions are monotonic and don't pop. Verify visually at dusk (build step 8).

### 4a. Sky dome uniforms (per frame, linear interp by `a`)
```
u.sunPosition.value.copy(sunDir);
turbidity/rayleigh/mieCoefficient = rampScalar(a) using:
 a:  60   30   12    4    0   -6  -12  -18
 tu: 2.5  3.5  6.0  9.0 10.0  7.0 2.0  0.3
 ra: 1.0  1.4  2.2  3.0  3.4  2.0 0.6  0.2
 mi:.0050 .0050 .0040 .0030 .0022 .0015 .0010 .0008
u.mieDirectionalG.value = 0.82;
```
> **[FIXED M6]** The night Sky still renders a faint navy gradient; additive stars over it could wash out. The coefficient collapse above (turbidity 0.3 / rayleigh 0.2 at `a=−18`) drives night-sky luminance well below faint-star additive brightness in this scene's exposure. Build step 6 explicitly verifies night Sky luminance < star brightness; if it fails, apply a final `uNightDim` multiplier `mix(1.0, 0.25, nightFactor(a))` on the Sky output (single-line addon patch, kept in reserve).

### 4b. Sun DirectionalLight
```
sunLight.color = sunLightColor(a)               // linear ramp
I_sun(a): a>=12 → 3.4 ; 0..12 → lerp(3.4→1.4) ; <0 → 0
sunLight.intensity = I_sun(a) * kAboveHor;       // 0 at night
sunLight.visible = sunLight.intensity > 0.001;   // skip shadow pass at night
```
> **[NOTE m5]** Toggling `.visible` skips the shadow pass cleanly; verify at dawn no stale shadow lingers when it re-enables. Keep shadow camera + `followPlayer` as-is.

### 4c. Moonlight DirectionalLight (new) — driven by moon altitude `am` (deg) + illum `f`
```js
const moonLight = new THREE.DirectionalLight(0x000000, 0);
moonLight.color.setRGB(0.55, 0.66, 1.0, THREE.LinearSRGBColorSpace);
moonLight.castShadow = false;
scene.add(moonLight, moonLight.target);
// per frame:
const I_moon = 0.30 * ss(am,-4,12) * (0.15 + 0.85*f) * kNight;  // ss rising (−4→12), kNight via fall()
moonLight.intensity = I_moon;
moonLight.visible = I_moon > 0.002;
// followPlayer also positions moonLight: pos = player + moonDir*180; target = player
```

### 4d. Ambient
```
scene.environmentIntensity = envRamp(a): a>=30→1.0; 8..30→.55..1.0; 0..8→.38..55; -6..0→.12..38; <-6→0.10
hemiLight.intensity = hemiRamp(a): >=30→.5; 0..30→.4..5; -6..0→.15..4; <-6→0.08
hemiLight.color/groundColor = lerp over day(.45,.62,1.0)/(.30,.27,.20),
  golden(.79,.72,.85)/(.43,.37,.23), night(.08,.11,.22)/(.04,.05,.09)
```
Floors 0.10 env / 0.08 hemi — never 0.

### 4e. Fog write-through (per frame) + EXP2 assertion
```
// at init (main.js): console.assert(scene.fog instanceof THREE.FogExp2,
//   'EXP2 fog required by celestial fog_fragment'); [FIXED critique-C5]
fogUniforms.uFogSunDir.value.copy(sunDir);
sunColorE(a, fogUniforms.uFogSunColor.value);     // sunLightColor*kAboveHor
fogUniforms.uFogNight.value = nightFactor(a);     // fall(a,2,-8)
scene.fog.density = fogRamp(a): >30→0.0011; 0..12→0.0014; <-6→0.0016
```

### 4f. PMREM throttle — persistent generator + dedicated env scene **[FIXED M4]**
```js
const pmrem = new THREE.PMREMGenerator(renderer);  // compileEquirectangularShader() omitted (no-op in r184)
// dedicated env scene owns its OWN Sky clone — live `sky` NEVER leaves the main scene
const envScene = new THREE.Scene();
const envSky   = sky.clone();                        // separate Sky instance
envScene.add(envSky);
function syncEnvSky(){ envSky.material.uniforms = sky.material.uniforms; } // share live uniforms by ref
let envRT = pmrem.fromScene(envScene);
scene.environment = envRT.texture;
let aLastBake = a0, tLastBake = 0;

function refreshEnv(now /*sec*/, frameMs){
  if (now - tLastBake < 0.5) return;                // hard min interval
  if (frameMs > 25) return;                          // skip janky frames
  if (Math.abs(a - aLastBake) < 1.5 && now - tLastBake < 4.0) return;
  syncEnvSky();                                       // env Sky uses current uniforms; no graph mutation
  const next = pmrem.fromScene(envScene);
  const prev = envRT; envRT = next; scene.environment = envRT.texture;
  if (prev) prev.dispose();                           // dispose AFTER swap
  aLastBake = a; tLastBake = now;
}
function disposeSky(){ pmrem.dispose(); envRT?.dispose(); }  // teardown
```
> **[FIXED M4]** No re-parenting of the live `sky` between scenes — eliminates the one-bake "sky absent from main scene" flicker. `refreshEnv` runs strictly before `composer.render` (§8). Sky uniforms (turbidity/rayleigh/sunPosition) are set in `update` before `refreshEnv` each frame. Moon/stars are NOT in `envScene` (negligible IBL).

### `createSky` return
```js
return { sky, sunDirection: sun, fogUniforms, followPlayer, update, refreshEnv, disposeSky };
// signature: createSky(scene, renderer, sharedUniforms)
// update(sunDir, moonAltDeg, moonIllum): writes sky uniforms, sun+moon light, hemi/env,
//   fog uniforms+density, AND sharedUniforms.uSunDir/uSunColor (+ sunDirection alias copy).
```

---

## 5. MOON — `src/moon.js`

`createMoon(scene, fogUniforms)`. Use D's full module verbatim with these locked deltas:

1. **C5 fog**: `#include <fog_pars_fragment>` (global decls so `uFogSunDir/uFogSunColor/uFogNight/uFogNightColor` **and** `fogDensity` compile), **NO** `#include <fog_fragment>`; self-contained single-scattering at `uFogScale=0.02`. **Moon material MUST set `fog:true`** so the `#ifdef USE_FOG`/`#ifdef FOG_EXP2` blocks activate and `fogDensity` is declared (scene is `FogExp2`, asserted §4e). The merged `UniformsLib.fog` supplies `fogDensity` (synced from `scene.fog` by three). Inside `createMoon`, call `applyDynamicFog(material, fogUniforms)` so the declared `uFog*` keys resolve to shared values (harmless; moon ignores them but they must not be absent). **[FIXED critique-C5]**

2. **Constants** (verified vs water.js): `MOON_DISTANCE=1000` (< reflCam.far 1200 ✓), `MOON_RADIUS=9.0`, `mesh.layers.set(0)`, `renderOrder=1`, `depthWrite:false`, `transparent:true`, **`depthTest:true`** (so terrain occludes the moon — **[FIXED M5]** explicitly stated, not left to default), `material.extensions={derivatives:true}`.

3. **Per-fragment normal**: phase shading uses the **true sphere world-space normal** from geometry, not the billboard quad normal. `lookAt(camera)` provides tidal-lock orientation; the sphere mesh (not a quad) yields correct per-fragment `N_world`. **[FIXED M5]** — confirm the mesh is a `SphereGeometry`, not a billboard plane.

4. **update contract (C10 real ephemeris):**
```js
moon.update(camera, sunDir, moonDir, illumFraction)
// moonDir = altAzToVector(moonAlt, moonAz) from celestial.moonHorizontal
// illumFraction = celestial.moonPhase(date).illuminatedFraction
// hides below -2° altitude; opacity smoothstep(-2°..+4°) (GLSL smoothstep, symmetric ✓); lookAt(camera)
```

Phase is **automatic** from `dot(N_world, normalize(uSunDir))`. `illumFraction` only scales earthshine/glow. No phase uniform, no `χ`. Angular size ≈ 2·atan(9/1000) ≈ 1.03° (~2× real, acceptable). HDR sunlit center ≈1.3 (> bloom threshold 0.85 → soft halo). `tonemapping_fragment`/`colorspace_fragment` are no-ops in the composer's HalfFloat target. Full GLSL+JS = D's listing, dropping the hardcoded `moonDir`/`moonIllum` placeholders (computed in main.js from `celestial`).

---

## 6. STARS + MILKY WAY — `src/stars.js`

Use E's Points + BackSide dome with the LST consistency fix (C2/C11) and the radius fix below. Rotation math consumes `celestial`'s LST and A §6b nested-group convention (verified to machine precision).

### Geometry build (NCP at +Y)
```glsl
star_local = ( cosDec*sin(RA), sinDec, cosDec*cos(RA) )   // RA,Dec radians
```

**[DECISION C-stars / radius]**: reflCam.far = 1200 (water.js:217, verified). Geometry at radius 2700 would be clipped from the water reflection. **Place star group at radius 1100, milky-way dome at 1120 (both < 1200)**, camera-relative each frame, so stars appear in the reflection. Both < camera.far 3000. Sky is pinned to the far plane (`gl_Position.z=w` → depth 1.0); radius-1100 depth < 1.0 → stars draw over the night dome but are terrain-occluded (`depthTest:true`).

### Rotation (A §6b, verified signs) — driven by celestial LST each frame
```js
// nesting: tiltGroup (parent) ⊃ spinGroup (child) ⊃ {stars Points, milkyWay Mesh}
const latRad = latDeg * DEG;
spinGroup.rotation.set(0, -lstRad, 0);                 // spin = −LST about +Y
tiltGroup.rotation.set(-(Math.PI/2 - latRad), 0, 0);   // tilt = −(90°−φ) about +X
// lstRad = celestial.localSiderealTimeDeg(date, lon, sunMeanLon) * DEG  (SAME LST as sun/moon)
group.position.copy(camera.position);                   // camera-relative
```
> **[FIXED M3]** Nesting is **tiltGroup parent, spinGroup child** (tilt applied after spin in world order) — this is load-bearing for the sign convention; do not invert. NCP lands at altitude=φ due North (Tokyo φ=+35.68° → NCP alt +35.68° North ✓; southern φ → NCP below horizon ✓). Stars rise East (+X) → culminate South → set West. Circumpolar for `|Dec| > 90−φ`. Identical LST as §2 → sun, moon, stars cannot diverge.

### Materials
`fog:false` (critical — else daylight haze tints stars), `transparent:true`, `AdditiveBlending`, `depthWrite:false`, `depthTest:true`, `toneMapped:true`. Stars `renderOrder=3`, MilkyWay `renderOrder=2`. Both `frustumCulled=false`.

### Day/night fade (C12-safe falling ramp)
```js
// [FIXED C12] star fade is FALLING in sunDirY → use fall(), NOT smoothstep(sunDirY, sin(-12°), sin(-2°))
const fade = celestial.fall(sunDirY, Math.sin(-2*DEG), Math.sin(-12*DEG));
// fall(x, hi, lo) = 1 - ss(x, lo, hi); lo=sin(-12°) < hi=sin(-2°). 0 above −2°, 1 below −12°.
// starMat/mwMat uNightFade = fade.
```
`update(latDeg, lstDeg, sunDirY, dt, time)` → set tilt/spin, fade, `uTime`. Camera offset vs reflection cam is negligible at radius 1100.

---

## 7. TIME SYSTEM + SETTINGS PANEL + HUD

- **`src/clock.js`** = F §1 verbatim. `SPEED_PRESETS` includes `{label:'144倍 (10分=24h)', mult:144}` (default). `advance(dt)` adds `dt*1000*mult` ms; does NOT `emit()` (panel reads on HUD cadence).
- **`src/ui/settings.js`** = F §4 verbatim (DOM wiring, tz helpers `tzOffsetMs`/`dateToLocalInput`/`localInputToDate`, pointer-lock arbitration). **[NOTE m1]** `<input type="datetime-local">` is tz-naive; the tz helpers MUST key off the simulated location's longitude-derived offset, not the browser's. Pre-ship test: set lon to London coords, confirm displayed local time matches solar noon (not JST).
- **`index.html`** = F §3 verbatim: `#settings` panel CSS (`z-index:8`, between `#hud`(5) and `#overlay`(10)); 4-line `#hud` (`#hud-time/-loc/-astro/-pos`); panel markup; add `<b>O</b><span>設定</span>` to overlay controls.
- **Pointer-lock (C7/F)**: toggle key `KeyO` (guarded against typing in INPUT/SELECT/TEXTAREA — guard on the **same keydown** that drives WASD so movement keys don't leak into fields, **[NOTE m3]**). **`openPanel()` MUST call `document.exitPointerLock()` first** — otherwise the panel's `<input>`/`<select>` are unreachable while the pointer is captured **[FIXED m3]**. `settingsOpen` flag makes the unlock handler suppress the start overlay while editing. `close()` need not re-lock (user clicks to re-lock via existing overlay). Esc closes panel if open. Settings slider drives `simClock.set(...)` live → reflected next frame.

---

## 8. MAIN.JS LOOP INTEGRATION

### Module exposure summary
| Module | Factory | Returns / contract |
|---|---|---|
| sky.js | `createSky(scene, renderer, sharedUniforms)` | `{ sky, sunDirection, fogUniforms, followPlayer, update(sunDir,moonAltDeg,illum), refreshEnv(now,frameMs), disposeSky }` |
| celestial.js | (pure fns) | `sunHorizontal/moonHorizontal/moonPhase/localSiderealTimeDeg/altAzToVector` + ramps `sunLightColor/sunColorE/kAboveHor/nightFactor/fall` |
| clock.js | `createSimClock(opts)` | `{ state, advance(dt), set, setNow, togglePause, speedLabel }` |
| moon.js | `createMoon(scene, fogUniforms)` | `{ mesh, material, update(camera,sunDir,moonDir,illum), dispose }` |
| stars.js | `createStarField({latitudeDeg})` | `{ group, update(latDeg,lstDeg,sunDirY,dt,time) }` |
| ui/settings.js | `createSettingsPanel({clock,controls,overlay})` | `{ toggle, openPanel, close, isOpen }` |

### Construction order (main.js)
```js
const sharedUniforms = /* existing, constructed BEFORE createSky */;   // [FIXED critique-C4]
const simClock = createSimClock({ latitude:35.6812, longitude:139.7671, speedMultiplier:144 });
const { sky, sunDirection, fogUniforms, followPlayer, update:skyUpdate, refreshEnv }
  = createSky(scene, renderer, sharedUniforms);
console.assert(scene.fog instanceof THREE.FogExp2, 'EXP2 fog required'); // [FIXED critique-C5]
scene.add(createTerrain());
const water = createWater(sunDirection, sharedUniforms);  scene.add(water);
scene.add(createVegetation(sharedUniforms));
const grass = createGrassField(sharedUniforms, fogUniforms); scene.add(grass.group);
const ambience = createAmbience(); scene.add(ambience.group);
const moon = createMoon(scene, fogUniforms);
const stars = createStarField({ latitudeDeg: simClock.state.latitude }); scene.add(stars.group);
// FOG SAFETY PASS — after all scene.add (clouds present, no lazy fog meshes):
scene.traverse((o)=>{ const ms=Array.isArray(o.material)?o.material:(o.material?[o.material]:[]);
  for (const m of ms) applyDynamicFog(m, fogUniforms); });
const settings = createSettingsPanel({ clock: simClock, controls: player.controls, overlay });
const _moonDir = new THREE.Vector3();
```

### Per-frame order **[FIXED critique-C2]** — moon/stars BEFORE `water.userData.update` (water RTs render synchronously inside it)
```js
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;
  const frameMs = dt * 1000;

  simClock.advance(dt);
  const { simDate, latitude, longitude } = simClock.state;

  // --- astronomy (ONE clock, ONE LST via shared gmst()) ---
  const sh = sunHorizontal(simDate, latitude, longitude);
  const mh = moonHorizontal(simDate, latitude, longitude);
  const ph = moonPhase(simDate);                                 // writes into reusable struct
  const lstDeg = localSiderealTimeDeg(simDate, longitude, sh.meanLon);  // same gmst() as sh/mh
  altAzToVector(sh.altitude, sh.azimuth, sunDirection);          // mutate shared sun vector
  const moonDir = altAzToVector(mh.altitude, mh.azimuth, _moonDir);
  const sunAltDeg  = THREE.MathUtils.radToDeg(sh.altitude);
  const moonAltDeg = THREE.MathUtils.radToDeg(mh.altitude);

  // --- sky/lights/fog + sharedUniforms.uSunDir/uSunColor (MUST precede water RTs) ---
  skyUpdate(sunDirection, moonAltDeg, ph.illuminatedFraction);
  followPlayer(camera.position);                                  // sun+moon shadow cams

  // --- celestial bodies BEFORE water RTs so the reflection captures them this frame ---
  moon.update(camera, sunDirection, moonDir, ph.illuminatedFraction);
  stars.group.position.copy(camera.position);
  stars.update(latitude, lstDeg, sunDirection.y, dt, time);

  // --- shared uniforms current → water RT passes render correct sun/moon/stars ---
  sharedUniforms.uTime.value = time;
  sharedUniforms.uPlayerPos.value.set(camera.position.x, camera.position.z);
  gradePass.uniforms.uTime.value = time;
  water.userData.update(time);          // renders reflection+refraction RTs synchronously here

  if (!window.__demo?.freeze) player.update(dt);
  grass.update(camera.position);
  ambience.update(dt, time, camera.position);

  refreshEnv(time, frameMs);            // throttled PMREM, strictly before composer.render
  updateLightShafts();                  // reads sunDirection (now updated)

  hudTimer += dt;
  if (hudTimer > 0.25) { hudTimer = 0; updateHud(sh, mh); }
  composer.render();
});
```
> **[FIXED critique-C2]** Corrected order vs original: `skyUpdate` → `followPlayer` → **moon.update / stars.update** → **water.userData.update** → player/grass/ambience → refreshEnv → lightShafts → composer.render. The reflection RT (water.js:227) now captures moon/stars at the **current** frame's position — no one-frame lag under 144×/3600× time-warp. `skyUpdate` still precedes water (sun uniforms current — original got that right, kept).
> **[NOTE m2/m4]** `dt` clamped at 0.05 (existing, saves backgrounded-tab spikes). `moonPhase`/ramp helpers write into reusable structs/Color outs — no per-frame allocation. `_moonDir` reused.

`skyUpdate` does `sharedUniforms.uSunDir.value.copy(sunDirection)` + `uSunColor` write — water/grass/leaves get the live sun with zero new wiring (they already alias `sharedUniforms`).

---

## 9. UNIFORM / STATE CONTRACT

**Single source of celestial state**: `simClock.state` (date, lat, lon, speed) → `celestial.js` pure fns → world vectors. One `gmst()` → one LST → sun/moon/stars locked.

**Shared sun (existing, reused):** `sharedUniforms.uSunDir` (Vector3), `uSunColor` (Color). Consumers alias by reference:
- water.js:671-672 → `material.uniforms.uSunDir/uSunColor = sharedUniforms.*`. Frag uses `uSunDir.y` (caustics 525, sun elev 546) → auto-dims at night. **[NOTE M1]** uses `uSunDir.y` only for elevation, no `.xz` azimuth glint dependency — confirmed safe with the new convention. **No edit.**
- grass.js:103-104 → aliased in `onBeforeCompile`. Translucency uses `uSunColor`. **Edit only to add 4 fog refs.**
- vegetation.js leafMaterial:68 → aliased. **No edit.**
`skyUpdate` mutates `.value` in place each frame → propagates everywhere.

**Shared fog (new):** `fogUniforms` (4 objects, owned by sky.js). Every fog material aliases by ref via `applyDynamicFog` (traverse + grass explicit + moon explicit). Declared globally in `fog_pars_fragment` → no undeclared-identifier link error.

**Lights:** sunLight (dynamic color/intensity, `.visible` gated), moonLight (new, dynamic), hemiLight (dynamic). `scene.environment` (throttled PMREM, dedicated env scene) + `scene.environmentIntensity` (per-frame ramp).

---

## 10. BUILD SEQUENCE (ordered, each step verifiable in-browser)

1. **`celestial.js`** — Schlyter + shared `gmst()` + ramps (`fall`-based). Verify in console: `sunHorizontal(new Date('1990-04-19T00:00:00Z'),0,0)` → sane alt; `moonPhase(new Date('2026-01-03'))` → ~0.99; **assert `nightFactor(60)===0` and `nightFactor(-30)===1`** (C12 regression guard); confirm `localSiderealTimeDeg` and the alt/az HA both call the same `gmst()` (M2). No render change.
2. **`clock.js`** — log `state.simDate` advancing under `advance(0.016)`.
3. **`sky.js` fog refactor** — `patchFogChunks()` + `fogUniforms` + `applyDynamicFog` + traverse pass + `FogExp2` assert. **Verify: scene renders identically; no GLSL link errors** (watch console). Temporarily set `uFogNight=0`.
4. **`sky.js` dynamic update + persistent PMREM (dedicated env scene)** — wire `skyUpdate`/`refreshEnv` with a hardcoded ramp. Verify sun arcs, colors shift, **no PMREM hitch, no sky-flicker (M4), no VRAM growth** (DevTools memory). Confirm `nightFactor` produces dark fog at night, lit fog at day (C12 in-scene).
5. **`moon.js`** — `createMoon(scene, fogUniforms)`; real `moonDir`. Verify disc visible, `depthTest:true` so terrain occludes it (M5), phase matches `illumFraction`, **appears in water reflection** (R=1000<1200), sphere normal (not billboard) drives phase.
6. **`stars.js`** — radius 1100/1120. Verify night fade (`fall`-based, C12), rise-East/set-West, NCP at lat (tiltGroup parent / spinGroup child, M3), reflection presence, `fog:false`, **and night-Sky luminance < star brightness (M6)** — apply reserve `uNightDim` only if washed.
7. **Settings + HUD** — `index.html` panel/CSS/HUD; `ui/settings.js`; `KeyO`. Verify `openPanel()` calls `exitPointerLock()` (m3 — inputs clickable), typing guard on same keydown as WASD (m3), tz helpers key off sim longitude not browser (m1), live slider → instant sky/water-reflection update.
8. **Full integration loop** — final per-frame order (§8). Verify a full cycle at 3600× (1s=1h): dawn→noon→dusk→stars→moon→dawn; **reflected moon/stars not lagging real ones (C2)**; fog/IBL/water/grass coherent; dusk transitions don't pop (m7); dawn shadow re-enables cleanly (m5).

---

## 11. FAILURE MODES & GUARDS

1. **JS smoothstep min>max inversion (FATAL, was core bug)** → **[FIXED C12]** dedicated `fall(x,hi,lo)=1-ss(x,lo,hi)` for every falling JS ramp (`nightFactor`, `kNight`, star fade). No `THREE.MathUtils.smoothstep` call receives `min>max`. `kAboveHor` and moon `ss(am,-4,12)` are rising (valid). GLSL `smoothstep(fogNear,fogFar,…)` and moon opacity unchanged (GLSL clamps symmetrically). Build step 1 asserts `nightFactor(60)===0 && nightFactor(-30)===1`.
2. **Water-RT-stale reflected sky (FATAL, was order bug)** → **[FIXED C2]** moon/stars updated **before** `water.userData.update` (water.js:227 renders RTs synchronously). `skyUpdate` precedes water (sun uniforms current). Build step 8 verifies reflected moon/stars track real ones under time-warp.
3. **Fog GLSL undeclared identifier (FATAL)** → uniforms declared in **global `fog_pars_fragment`** (mandatory edit, current file lacks them). Even a missed material links; missed EXP2 material samples zero (silent). Build step 3 watches console.
4. **Silent black fog on a material** → every fog material gets value objects by ref (traverse + grass + moon). Traps = birds + 4 butterflies (MeshBasic, default `fog:true`) + cloud (`#include <fog_fragment>`) — covered by traverse (clouds present at traverse time, no lazy fog meshes).
5. **EXP2/FogExp2 invariant** → **[FIXED critique-C5]** `console.assert(scene.fog instanceof THREE.FogExp2)` at init; moon material `fog:true` so `fogDensity` is declared. If scene fog were linear `Fog`, the EXP2 design collapses — asserted, not assumed.
6. **Coordinate sign errors** → ONE convention (`altAzToVector`, North=−Z/East=+X/Up=+Y). Star spin=−LST, tilt=−(90−φ), **tiltGroup parent / spinGroup child (M3)**. One shared `gmst()` for sun/moon/stars (M2). F's `setFromSphericalCoords` dropped; water `uSunDir.y`-only elevation confirmed safe (M1).
7. **NaN** → `clamp(sunDir.y,-1,1)` before `asin`; `max(fogDist,1e-4)`; `bR+bM>0` always; moon `mu0/(mu0+mu+1e-3)`; Kepler 3× fixed iters; `rev()` normalizes all angles.
8. **Pointer-lock trap** → **[FIXED m3]** `openPanel()` calls `exitPointerLock()` so inputs are clickable; `settingsOpen` suppresses start overlay on edit-unlock; `KeyO` (not Esc); typing guard on the same keydown driving WASD; panel `stopPropagation` + `pointer-events:none` when hidden.
9. **IBL hitching / flicker** → **[FIXED M4]** persistent PMREM, dedicated `envScene` owning its own `Sky` clone (live sky never leaves main scene), throttle ≥1.5°/4s, min 0.5s, skip if frameMs>25; dispose previous RT after swap; `disposeSky()` for teardown. sunLight/uSunColor stay per-frame smooth between bakes.
10. **Stars washed out** → `fog:false`; additive over dark night sky; `uNightFade` via `fall()`; radius 1100 < Sky far-plane depth → draws over dome but terrain-occluded. **[FIXED M6]** build step 6 verifies night-Sky luminance < star brightness; reserve `uNightDim` Sky multiplier if needed.
11. **Moon phase backwards / billboard normal** → phase from `dot(N_world, uSunDir)` using true **sphere** normal (not billboard quad, **M5**); light = Sun's sky direction; bright limb auto-points at sun. `depthTest:true` so terrain occludes (M5). `illumFraction` only scales earthshine.
12. **Moon clipped from reflection** → R=1000 < reflCam.far=1200 (water.js:217 verified). Raising R>1200 requires raising water.js:217.
13. **Perf** → no new render passes (uniform writes only). sunLight.visible=false at night skips shadow pass; moonLight.castShadow=false. Stars=1 Points, MilkyWay=1 mesh, moon=1 mesh — main + reflection pass only. PMREM throttled. No per-frame alloc (reused Color outs, `_moonDir`, `moonPhase` struct, **m4**).
14. **Time-warp LST drift** → LST recomputed from `simDate` each frame (not accumulated, C11) → exact at any multiplier. `dt` clamped 0.05 (m2).
15. **Unlit birds/butterflies** → **[NOTE m6]** MeshBasic; fog-tinted but won't darken with sun/moon. Accepted for distant silhouettes.
16. **datetime-local tz ambiguity** → **[NOTE m1]** tz helpers must key off sim longitude offset, not browser; verified build step 7.

**Files touched (final):** new `celestial.js`, `clock.js`, `moon.js`, `stars.js`, `ui/settings.js`; edited `sky.js`, `main.js`, `grass.js`, `index.html`. **No edits** to `terrain.js`, `vegetation.js`, `ambience.js`, `water.js`, `player.js` (covered by traverse + existing sharedUniforms aliasing).

---

**Critique resolution summary:** CRITICAL C1 (smoothstep inversion → `fall()` helper, §2/§4/§6/FM1, with build-step assertion), C2 (water-RT ordering → moon/stars before `water.userData.update`, §8/FM2), C3 (ShaderMaterial uniform aliasing → plain-assign branch + mandatory global decl, §3a/3c/FM3), C4 (createSky signature/sharedUniforms-first + mandatory decls, §8/FM3), C5 (moon `fog:true` + `FogExp2` assert, §5/§4e/FM5) all fixed inline. MAJOR M1 (azimuth grep-verified safe), M2 (single shared `gmst()`), M3 (tiltGroup parent / spinGroup child), M4 (dedicated env scene, no live-sky re-parenting), M5 (sphere normal + `depthTest:true`), M6 (night-Sky luminance check + reserve `uNightDim`) all fixed. MINOR m1–m7 noted with concrete guards (tz keying, dt clamp, `openPanel` exitPointerLock + WASD-keydown guard, reused-alloc audit, dawn shadow check, unlit-birds caveat, staggered ramp edges).