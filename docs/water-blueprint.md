I have enough ground truth. Key corrections beyond the critique:
- Bloom is `UnrealBloomPass(threshold 0.85, strength 0.25, radius 0.7)` — confirms threshold 0.85.
- The fog system is fully custom (sky.js), reads `mvPosition` + `cameraPosition` + `fogColor`/`fogDensity` uniforms, bakes sun as constants. A ShaderMaterial MUST merge `UniformsLib.fog` AND name view-space pos `mvPosition`. The critique's C2/C3 are confirmed real and even more specific than stated.
- The shared time clock: `sharedUniforms.uTime` runs at RAW speed (main.js:314). The OLD foam aliases it at raw speed. The OLD `Water` runs `.time` at `time*0.5`. So the contract `userData.update(time)` must drive the new water's OWN `uTime` at `time*0.5`.

I have all I need to produce the corrected, complete blueprint. Here it is.

---

# water.js — EXTREME-REALISM Custom Water Surface: Authoritative Implementation Blueprint (CORRECTED)

**Target:** three.js r0.184, `WebGLRenderer` (non-reversed depth, AgX tonemap @ exposure 0.95, composer HalfFloat MSAA RT). Full rewrite of `/Users/ckazu/work/openworld_survey/src/water.js`. Calm clear mountain lake, golden hour (sun elev 8°, az 145°, `0xffc587` → linear ≈ `vec3(1.0, 0.773, 0.529)`).

This blueprint is self-contained and implementation-ready. Every CRITICAL/MAJOR defect from review has been fixed inline; MINOR items noted in §12. All GLSL `smoothstep(a,b,x)` calls have `a<b`; all symbols are defined; vertex/fragment math is consistent.

### Source re-verification (the review was right — the original blueprint's "source-verified" claims were not)
Re-read of actual source before writing this revision:
- **Time uniform:** `sharedUniforms = { uTime, uSunDir(Vector3), uSunColor(Color), uPlayerPos(Vector2) }` (main.js:38-43). `sharedUniforms.uTime` is written **raw** (`sharedUniforms.uTime.value = time;` main.js:314) and shared by grass/vegetation. The **old** `Water` material's `time` uniform (water.js:206, `time * 0.5`) is `Water.js`'s *private* uniform, not the shared one. The old foam aliases the **shared** `uTime` at **raw** speed (water.js:78). → **The new water owns a private `uTime` object driven at `time * 0.5` by `userData.update`; it is NEVER aliased to `sharedUniforms.uTime`.** (Fixes C1.)
- **Fog is fully custom & globally patched** (sky.js:11-75 `patchFogChunks`): `THREE.ShaderChunk.fog_vertex/fragment` are overwritten with a Hoffman-Preetham `FogExp2` single-scatter model. The patched `fog_vertex` reads **`mvPosition`** (sky.js:19) and uses raw `position`→`modelMatrix` for `vFogWorldPos` (sky.js:22-26). The patched `fog_fragment` reads `fogColor`, `fogDensity`, `cameraPosition`, and operates on `gl_FragColor.rgb` (sky.js:30-68). Sun dir/color are **baked as GLSL constants** — no sun uniforms needed for fog. (Fixes C2, C3.)
- **A raw `ShaderMaterial` does NOT auto-merge fog uniforms** even with `fog:true`. We must merge `THREE.UniformsLib.fog` (`fogColor`, `fogDensity`, `fogNear`, `fogFar`) into `material.uniforms` or the patched chunk fails to compile (undeclared `fogColor`). `fog:true` only injects the `#include`s + `USE_FOG`/`FOG_EXP2` defines. (Fixes C2.)
- **`bakeShoreMask(size = 256)`** default (water.js:53); old foam samples the mask by **`vUv`** (water.js:108), not world-XZ. (Fixes M1.)
- Composer chain confirmed: `RenderPass → GTAOPass → UnrealBloomPass(strength 0.25, radius 0.7, threshold 0.85) → shaft(luma 2.4-5.5) → Bokeh(focus 30) → flare → OutputPass → grade`. Composer RT is `HalfFloatType, samples:4`. (main.js:64-69, 104.)
- `camera.layers.enable(1)` (main.js:35); near=0.1, far=3000.
- `createSky` runs before `createWater` (main.js:45-48) → `scene.fog` and the patched chunks both exist when the water material compiles. Ordering OK.

---

## 1. ARCHITECTURE decision & module structure

### Decision: from-scratch `THREE.Mesh` + `THREE.ShaderMaterial`, driving its own reflection RT and refraction RT (+ DepthTexture) inside a single `mesh.onBeforeRender`.

**Why this over the alternatives (unchanged — all converge here):**
- **vs. patching `Water.js` (current):** current code does brittle `.replace()` string surgery (water.js internals). `Water.js` is reflection-only, single-RT, no refraction, no depth, no Gerstner vertex displacement. Rejected.
- **vs. `Reflector` + `Refractor`:** each owns a private `onBeforeRender`/camera/RT in constructor closures — not callable piecewise, separate meshes (won't share the displaced surface's wave normals), `Refractor` exposes no depthTexture. Rejected.
- **vs. WebGPU `Water2Mesh`/`WaterMesh`:** TSL/`three/webgpu` only — does not run on `WebGLRenderer`. Reference-only (confirms F0=0.02 Schlick). Rejected.
- **Why (a) wins:** one displaced surface owns its analytic wave normals; both RTs sampled in that fragment shader with the same normals; one recursion guard; explicit render order; per-RT layer masking + oblique clip like `Reflector`; outputs linear HDR consistent with terrain/grass; respects the **custom global fog**. `main.js` needs **zero changes** (external contract preserved).

### Module structure of new `src/water.js`

```
src/water.js
├─ imports          THREE; { UniformsLib, UniformsUtils } (fog merge);
│                   { WORLD_SIZE, WATER_LEVEL, LAKE, terrainHeight } from terrain.js;
│                   { tileableFbm } from noise.js
├─ CONSTANTS        WATER_SPAN=540, WATER_SEG=512, SHORE_AREA=500, SHORE_RANGE=8,
│                   SHORE_CENTER=LAKE, NWAVES=5, REFL_SCALE=0.5, REFR_SCALE=0.5,
│                   RT_CAP=1536, CLIP_BIAS=0.003, TIME_SCALE=0.5,
│                   LAKE_MAX_PATH = LAKE.depth + 2.0  (= 11.0)
├─ generateWaterNormals(size=256)   [REUSE unchanged] tileable RG-slope DataTexture, RepeatWrapping
├─ bakeShoreMask(size=512)          [REUSE, called with 512] terrain-vs-water DataTexture, ±8m
│                                   (default is 256 in source; we pass 512 at the call site)
├─ WAVES (module const)             5× Vector4(dirX,dirY,amp,λ) + WAVE_Q[5] + ampMax  (§5 table)
├─ makeWaterGeometry()              PlaneGeometry(540,540,512,512).rotateX(-PI/2); manual boundingSphere
├─ makeWaterMaterial(sharedUniforms, shoreTex, detailTex, foamTex)
│                                   ShaderMaterial: merges UniformsLib.fog; Gerstner VS + FS;
│                                   transparent, depthWrite:true, fog:true, side:FrontSide;
│                                   NO glslVersion (default GLSL1 → gl_FragColor chunks)
├─ class WaterRT                    owns 2 RTs + reflectionCamera + refractionCamera + recursion guard
│   ├─ ensure(renderer)             lazy-allocate RTs at drawingBufferSize on first frame
│   ├─ reflectionRT  (HalfFloat, samples:4, no depthTexture)
│   ├─ refractionRT  (HalfFloat, samples:0, + DepthTexture)
│   ├─ _reflCam / _refrCam (PerspectiveCamera), _reflTexMatrix (Matrix4), scratch vectors
│   ├─ update(renderer, scene, camera, mesh, foam)   ← bound to mesh.onBeforeRender (§4)
│   └─ setSize(w,h)
├─ createShoreFoam(sharedUniforms, shoreTex)   [REUSE, upgraded] wave-coupled, layer 1,
│                                              merges UniformsLib.fog, fog:true, samples mask by vUv
└─ export createWater(sunDirection, sharedUniforms) -> THREE.Group
       group.add(waterMesh); group.add(shoreFoam);
       waterMesh.onBeforeRender = (r,s,c) => rt.update(r,s,c,waterMesh,shoreFoam);
       group.userData.update = (time) => {
         const t = time * TIME_SCALE;                 // private clock — NOT the shared object
         waterMesh.material.uniforms.uTime.value = t;
         shoreFoam.material.uniforms.uTime.value = t;
       };
       group.userData.setSize = (w,h) => rt.setSize(w,h);
       group.userData.dispose = () => { ... };
```

`TIME_SCALE = 0.5` preserves the old calm pacing. Wave dispersion `ω=√(gk)` gives correct relative speeds; `TIME_SCALE` is the global "glassiness" knob, applied **once** by folding it into `uTime` (so `w = √(gk)` in the VS, never `√(gk)·TS` — fixes m1).

---

## 2. MESH spec

| Property | Value | Rationale |
|---|---|---|
| Geometry | `PlaneGeometry(540, 540, 512, 512)` then `geometry.rotateX(-Math.PI/2)` | 540m covers LAKE (diameter 260m) + far shore. Bake rotation into geometry (terrain.js pattern) so vertex up = +Y, `position.xz` = world-relative offsets — Gerstner Y-displacement and world-XZ phase need no basis swap. |
| Resolution | 512×512 quads = 263,169 verts / 524,288 tris | 540/512 = 1.055 m/quad. Shortest geom wave λ=2.6m → ~2.5 quads (marginal); λ≥4.2m well-sampled. Sub-2.6m detail is in fragment normals (§8). Drop to 384² for weak GPUs; never below 256². |
| Position | `mesh.position.set(LAKE.x, WATER_LEVEL, LAKE.z)` = `(-150, -0.6, 120)` | Centered on lake. Vertices displaced in Y in shader; transform static. |
| Transform | `mesh.matrixAutoUpdate = false; mesh.updateMatrix(); mesh.updateMatrixWorld(true);` | Static — skip per-frame recompute. `_meshWorld` cached after this. |
| Bounding sphere | **set AFTER `rotateX`**: `geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0,0,0), Math.hypot(270,270) + 0.5)` | After rotate, geometry spans XZ ±270 centered at local origin (boundingSphere is local-space; mesh translation does not change the center). `Math.hypot(270,270)=381.84`. The margin covers crest displacement at the edge; it must be set after `rotateX` or `PlaneGeometry`'s construction-time sphere is stale. (M2: the original "+0.3 Y-margin" rationale was bogus — a sphere is isotropic; the margin is just slack, kept small.) |
| `mesh.name` | `'water'` | RT passes also hide by `visible=false`. |
| Layers | mesh on **layer 0**; shore foam on **layer 1**. | Camera renders 0\|1; RT cameras render layer 0 only (§4) → foam excluded from reflection; water hidden in both passes. |
| Material flags | `transparent:true`, `depthWrite:true`, `fog:true`, `side:THREE.FrontSide`, **no `glslVersion`** | `depthWrite:true` so the surface occludes in the main color pass. **See §10 re GTAO** — the AO prepass does NOT include transparent water; AO bleed at the waterline is a documented, accepted limitation (M10), mitigated by foam + soft alpha. Default GLSL1 is required so `<fog_fragment>`/`<tonemapping_fragment>`/`<colorspace_fragment>` operate on `gl_FragColor` (M9). |
| renderOrder | leave default 0 (foam = 1, draws after) | |

---

## 3. RENDER TARGETS

| RT | Resolution | type | samples | depthTexture | colorSpace | filter |
|---|---|---|---|---|---|---|
| **reflectionRT** | `min(floor(drawW*0.5), 1536)` × `min(floor(drawH*0.5),1536)` | `HalfFloatType` | **4** | none | `LinearSRGBColorSpace` | Linear/Linear |
| **refractionRT** | `min(floor(drawW*0.5),1536)` × `min(floor(drawH*0.5),1536)` | `HalfFloatType` | **0** | `DepthTexture` `DepthFormat`/`UnsignedIntType` | `LinearSRGBColorSpace` | Linear/Linear |

**Rationale (review-adjusted):**
- **HalfFloat everywhere** → reflected/refracted sun glints stay >1.0 so Bloom (threshold 0.85) and shafts (luma 2.4-5.5) still fire through the reflection.
- **Reflection dropped to 0.5× (was 0.75×) and capped at 1536²** (fixes M3, m3): this open world re-renders the entire scene (terrain 512² + vegetation + instanced grass + sky) **twice** per frame on top of the main pass and GTAO's prepass — a real ~3× geometry cost. Halving reflection resolution and capping refraction (m3) cut RT cost and VRAM. Wave distortion hides the lower reflection resolution. Additional culling in §4 (`reflCam.far` tightened; grass LOD honored).
- **Refraction 0.5×, samples:0** — seen through an absorbing, distorting medium; half-res invisible. **samples:0 is mandatory** because a multisampled RT cannot expose a cleanly sampleable `depthTexture` in r0.184 WebGL2.
- **`rt.texture.colorSpace = LinearSRGBColorSpace`** explicitly (RT default is `NoColorSpace`) so re-sampling is identity (no accidental sRGB decode).
- Re-allocate on resize via `setSize`.

### Allocation code (verified API)

```js
import {
  WebGLRenderTarget, DepthTexture, DepthFormat, UnsignedIntType,
  HalfFloatType, LinearFilter, LinearSRGBColorSpace, PerspectiveCamera, Matrix4,
  DataTexture, RGBAFormat, UniformsLib, UniformsUtils, Sphere, Vector2, Vector3, Plane, Vector4, Matrix4 as Mat4
} from 'three';

const RT_CAP = 1536;
const clampRT = (n) => Math.min(Math.max(1, Math.floor(n)), RT_CAP);

function makeReflectionRT(w, h) {
  const rt = new WebGLRenderTarget(clampRT(w), clampRT(h), {
    type: HalfFloatType, samples: 4, depthBuffer: true, stencilBuffer: false,
  });
  rt.texture.colorSpace = LinearSRGBColorSpace;
  rt.texture.minFilter = LinearFilter;
  rt.texture.magFilter = LinearFilter;
  return rt;
}

function makeRefractionRT(w, h) {
  const rt = new WebGLRenderTarget(clampRT(w), clampRT(h), {
    type: HalfFloatType, samples: 0, depthBuffer: true, stencilBuffer: false,
  });
  rt.texture.colorSpace = LinearSRGBColorSpace;
  rt.texture.minFilter = LinearFilter;
  rt.texture.magFilter = LinearFilter;
  const depthTex = new DepthTexture(clampRT(w), clampRT(h)); // flipY=false, no mipmaps
  depthTex.format = DepthFormat;       // MUST be DepthFormat or it throws
  depthTex.type = UnsignedIntType;     // 24-bit; switch to FloatType only if shore banding shows
  rt.depthTexture = depthTex;
  return rt;
}

// 1×1 neutral fallback so frame-0 (before first RT render) is never black.
// Interpreted as linear; (12,28,38) → ~(0.047,0.110,0.149): a genuinely DIM teal (fixes m7).
function neutralTexture() {
  const data = new Uint8Array([12, 28, 38, 255]);
  const t = new DataTexture(data, 1, 1, RGBAFormat);
  t.colorSpace = LinearSRGBColorSpace;
  t.needsUpdate = true;
  return t;
}
```

`setSize(w,h)`: dispose both RTs (`rt.dispose()`, `rt.depthTexture.dispose()` for refraction), reallocate at the new clamped 0.5× sizes, and re-publish `material.uniforms.tReflect/tRefract/tDepth`.

---

## 4. onBeforeRender sequence

`mesh.onBeforeRender(renderer, scene, camera, geometry, material, group)` fires once/frame inside the composer's `RenderPass.render` → `renderer.render(scene, camera)`, just before the water draws. The two nested `renderer.render()` calls re-fire this hook → re-entry guard mandatory.

**Critical restore rule:** save and restore `renderer.getRenderTarget()` — it is the composer's HDR RT, **NOT** `null`. Hardcoding `setRenderTarget(null)` breaks the post pipeline.

**Lazy allocation (zero main.js change):** RTs are allocated on the **first** `update()` (it receives `renderer`), at `renderer.getDrawingBufferSize()`. Frame-0 before allocation uses neutral fallbacks + `uHasDepth=0`.

```js
class WaterRT {
  update(renderer, scene, camera, mesh, foam) {
    if (this._rendering) return;                        // (G) RE-ENTRY GUARD — hard stop
    if (camera.userData.isWaterRT === true) return;     // belt-and-suspenders vs nested cam
    this.ensure(renderer);                              // lazy allocate RTs + neutral fallbacks (once)
    this._rendering = true;

    // (S) STATE SAVE — exactly Reflector's set
    const prevRT      = renderer.getRenderTarget();     // composer HDR RT — restore THIS, never null
    const prevCubeFace = renderer.getActiveCubeFace();
    const prevMip      = renderer.getActiveMipmapLevel();
    const prevXr       = renderer.xr.enabled;
    const prevShadow   = renderer.shadowMap.autoUpdate;

    renderer.xr.enabled = false;                        // avoid camera hijack + recursion
    renderer.shadowMap.autoUpdate = false;              // reuse this frame's shadow map

    // (H) HIDE water + foam so they appear in NEITHER pass
    mesh.visible = false;
    foam.visible = false;

    // ============ PASS 1: REFLECTION ============
    this._buildReflectionCamera(camera);               // mirror across y=WATER_LEVEL, normal +Y (§4a)
    this._reflCam.far = Math.min(camera.far, 1200);     // (M3) don't mirror 3km of mountains at full cost
    this._reflCam.updateProjectionMatrix();             // far change → rebuild proj BEFORE oblique clip
    this._applyObliqueClip(this._reflCam, +1);          // Lengyel, normal +Y (cull below-water)
    this._updateReflTexMatrix(this._reflCam);           // bias * proj * viewInv * meshWorld (§4c)
    this._reflCam.layers.set(0);                        // layer 0 only → excludes layer 1 + water
    this._reflCam.userData.isWaterRT = true;

    renderer.setRenderTarget(this.reflectionRT);
    renderer.state.buffers.depth.setMask(true);         // ensure depth writable for clear (#18897)
    if (renderer.autoClear === false) renderer.clear(); // composer leaves autoClear=false
    renderer.render(scene, this._reflCam);              // nested render #1 (guarded)

    // ============ PASS 2: REFRACTION (+ depthTexture auto-populated) ============
    this._buildRefractionCamera(camera);               // COPY main camera pose+proj (§4b)
    this._applyObliqueClip(this._refrCam, -1);         // Lengyel, normal -Y (keep below-water)
    this._refrCam.layers.set(0);
    this._refrCam.userData.isWaterRT = true;

    renderer.setRenderTarget(this.refractionRT);        // has .depthTexture attached
    renderer.state.buffers.depth.setMask(true);
    if (renderer.autoClear === false) renderer.clear();
    renderer.render(scene, this._refrCam);              // nested render #2 (guarded)

    // (R) STATE RESTORE — reverse order
    renderer.setRenderTarget(prevRT, prevCubeFace, prevMip);
    renderer.xr.enabled = prevXr;
    renderer.shadowMap.autoUpdate = prevShadow;
    if (camera.viewport !== undefined) renderer.state.viewport(camera.viewport);

    // (U) PUBLISH textures + matrices + per-frame scalars
    const u = mesh.material.uniforms;
    u.tReflect.value = this.reflectionRT.texture;
    u.tRefract.value = this.refractionRT.texture;
    u.tDepth.value   = this.refractionRT.depthTexture;
    u.uReflectMatrix.value.copy(this._reflTexMatrix);
    u.uReflFar.value     = this._reflCam.far;            // (C5) for w-guard scale, see VS
    u.uCameraNear.value  = camera.near;
    u.uCameraFar.value   = camera.far;
    u.uResolution.value.set(this.refractionRT.width, this.refractionRT.height);
    u.uCameraPos.value.copy(camera.position);
    u.uHasDepth.value    = 1.0;

    // also drive refraction-camera basis for caustic bed-reconstruction (C6)
    u.uRefrViewInv.value.copy(this._refrCam.matrixWorld);

    // (V) un-hide so three draws the water now, this frame, this camera
    mesh.visible = true;
    foam.visible = true;
    this._rendering = false;
  }
}
```

### 4a. Build reflection camera (mirror across plane y = WATER_LEVEL, world normal +Y)

```js
_buildReflectionCamera(camera) {
  const c = this._reflCam;
  const wp = this._waterWorldPos.set(LAKE.x, WATER_LEVEL, LAKE.z);
  const n  = this._normal.set(0, 1, 0);

  const camPos = this._camPos.setFromMatrixPosition(camera.matrixWorld);
  const view = this._v1.subVectors(wp, camPos);
  view.reflect(n).negate().add(wp);
  c.position.copy(view);

  const rot = this._rot.extractRotation(camera.matrixWorld);
  const lookAt = this._v2.set(0, 0, -1).applyMatrix4(rot).add(camPos);
  const target = this._v3.subVectors(wp, lookAt);
  target.reflect(n).negate().add(wp);

  c.up.set(0, 1, 0).applyMatrix4(rot).reflect(n);
  c.lookAt(target);
  c.aspect = camera.aspect;
  c.fov = camera.fov;
  c.near = camera.near;
  // c.far set by caller (M3); c.updateProjectionMatrix() called by caller before clip
  c.updateMatrixWorld();
}
```

> Note: we set fov/aspect/near and let the caller set `far` then call `updateProjectionMatrix()`. We do **not** copy the main camera's projection here (we need our own, tighter far). The oblique clip then overwrites the near-plane skew terms.

### 4b. Build refraction camera (copy main camera, no mirror)

```js
_buildRefractionCamera(camera) {
  const c = this._refrCam;
  c.matrixWorld.copy(camera.matrixWorld);
  c.matrixWorldInverse.copy(c.matrixWorld).invert();
  c.projectionMatrix.copy(camera.projectionMatrix);  // refraction keeps full far (bed never beyond ~11m anyway)
  c.far = camera.far;
}
```

### 4c. Oblique near-plane clip (Lengyel) — **bias applied to the PLANE CONSTANT, not the projection element** (fixes C4)

`sign = +1` for reflection (cull below-water), `-1` for refraction (keep only below-water).

```js
_applyObliqueClip(rtCam, sign) {
  const wp = this._waterWorldPos;            // (LAKE.x, WATER_LEVEL, LAKE.z)
  const n  = this._normal.set(0, sign, 0);   // +Y reflection, -Y refraction
  const plane = this._plane.setFromNormalAndCoplanarPoint(n, wp);

  // (C4 FIX) push the plane slightly INTO the kept half-space to kill waterline z-fight,
  // by offsetting the plane CONSTANT in world space, NOT by tilting projectionMatrix[10].
  plane.constant += CLIP_BIAS;               // CLIP_BIAS=0.003 (m)

  plane.applyMatrix4(rtCam.matrixWorldInverse);
  const cp = this._clipPlane.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);

  const P = rtCam.projectionMatrix;          // we WRITE into the RT cam's own proj (already rebuilt)
  const q = this._q;
  q.x = (Math.sign(cp.x) + P.elements[8])  / P.elements[0];
  q.y = (Math.sign(cp.y) + P.elements[9])  / P.elements[5];
  q.z = -1.0;
  q.w = (1.0 + P.elements[10]) / P.elements[14];
  cp.multiplyScalar(2.0 / cp.dot(q));
  P.elements[2]  = cp.x;
  P.elements[6]  = cp.y;
  P.elements[10] = cp.z + 1.0;               // (C4 FIX) standard Lengyel — NO -CLIP_BIAS here
  P.elements[14] = cp.w;
}
```

> Both clip planes are baked into each RT camera's `projectionMatrix`. We never touch `renderer.clippingPlanes` (which would force-recompile every scene material). For reflection the camera is mirrored → `+Y` plane clips below-surface geometry; for refraction the camera is the main camera → `-Y` plane keeps only the lake bed. The bias now lives in the world-space plane constant, so the clip plane stays parallel to the water across the whole frustum (no growing gap band).

### 4d. Reflection texture matrix (projective UV) — Reflector convention (undisplaced local position)

```js
_updateReflTexMatrix(c) {
  this._reflTexMatrix.set(
    0.5, 0.0, 0.0, 0.5,
    0.0, 0.5, 0.0, 0.5,
    0.0, 0.0, 0.5, 0.5,
    0.0, 0.0, 0.0, 1.0
  );
  this._reflTexMatrix.multiply(c.projectionMatrix);
  this._reflTexMatrix.multiply(c.matrixWorldInverse);
  this._reflTexMatrix.multiply(this._meshWorld);   // mesh.matrixWorld (static, cached)
}
```

> **Convention:** `uReflectMatrix` includes `meshWorld`; the VS computes `vReflectCoord = uReflectMatrix * vec4(position, 1.0)` from the **undisplaced** local position. Wave wobble is added later only as a small UV distortion from the surface normal. Do not feed the Gerstner-displaced position into the reflection matrix — that double-counts the wave and smears the mirror. (Since the rotation is baked into the geometry and `matrixAutoUpdate=false`, `meshWorld` is just the translation to `(LAKE.x, WATER_LEVEL, LAKE.z)`, so the projective coords are correct.)

---

## 5. VERTEX shader spec

### 5.1 Gerstner wave bank (ΣQ=0.62 < 1 → no pinching). **`TIME_SCALE` folded into `uTime` once** — `ω = √(gk)` only (fixes m1)

| # | dir (unit XZ) | λ (m) | amplitude A (m) | Q_i | k = 2π/λ | ω = √(g·k) (rad/s, applied to `uTime`) | note |
|---|---|---|---|---|---|---|---|
| 0 | (0.800, 0.600) | 18.0 | 0.090 | 0.18 | 0.349 | 1.851 | wind-aligned long |
| 1 | (0.985, 0.174) | 11.0 | 0.060 | 0.16 | 0.571 | 2.367 | −22° |
| 2 | (0.515, 0.857) | 7.0  | 0.038 | 0.13 | 0.898 | 2.968 | +31° |
| 3 | (0.927, 0.375) | 4.2  | 0.022 | 0.09 | 1.496 | 3.832 | −12° |
| 4 | (0.469, 0.883) | 2.6  | 0.013 | 0.06 | 2.417 | 4.869 | +35° |
|   | | | | **ΣQ=0.62** | g=9.81 | | |

`uWaves[i] = vec4(dirX, dirY, A, λ)`, `uWaveQ[i]` separate. `ampMax = Σ A = 0.223` (foam crest-fraction normalization). Dominant wind `(0.8,0.6)`. `uChoppyScale` default 1.0 (0.85 glassy, ≤1.4 breezy — keep ΣQ·scale < 1). Because `uTime` already carries `·TIME_SCALE`, the **effective** wave speed is `ω·TIME_SCALE` automatically; do not multiply `ω` by TS in code or docs.

### 5.2 Analytic TBN (closed-form derivatives — zero finite-difference noise)

For wave i, `D=dir`, `k=2π/λ`, `A=amp·damp`, `ω=√(gk)`, `Q=Q_i·uChoppyScale`, phase `φ = k·dot(D,P) + ω·t` (with `t=uTime` already scaled), `S=sin φ`, `C=cos φ`, `kA=k·A`:

```
Displacement:  X += Q·A·D.x·C ;  Z += Q·A·D.y·C ;  Y += A·S
Binormal B (+X):  B.x -= Q·D.x·D.x·kA·S ;  B.z -= Q·D.x·D.y·kA·S ;  B.y += D.x·kA·C
Tangent  T (+Z):  T.x -= Q·D.x·D.y·kA·S ;  T.z -= Q·D.y·D.y·kA·S ;  T.y += D.y·kA·C
Normal:  N = normalize(cross(T, B))   // +Y-up
```
`B` starts `(1,0,0)`, `T` starts `(0,0,1)`.

### 5.3 Shore-mask amplitude damping (sample baked mask by world XZ)

```glsl
// uShoreParams = vec4(LAKE.x - SHORE_AREA/2, LAKE.z - SHORE_AREA/2, SHORE_AREA, SHORE_RANGE*2)
//             = vec4(-400, -130, 500, 16)   // LAKE=(-150,120): x∈[-400,100], z∈[-130,370]
float shoreAmp(vec2 P, out float bottomDepth) {
  vec2 suv = (P - uShoreParams.xy) / uShoreParams.z;
  if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) { bottomDepth = 8.0; return 1.0; }
  float h = (texture2D(uShore, suv).r - 0.5) * uShoreParams.w; // signed height vs water (meters)
  bottomDepth = max(0.0, -h);                                  // >0 underwater
  float damp  = smoothstep(0.05, 1.5, bottomDepth);            // 0 at lip → 1 by 1.5m
  float shoal = 1.0 + 0.35 * (smoothstep(1.5, 3.0, bottomDepth) * (1.0 - smoothstep(3.0, 5.0, bottomDepth)));
  return damp * shoal;   // ΣQ·shoal ≤ 0.62·1.35 = 0.84 < 1, safe
}
```

### 5.4 Vertex main + varyings — **view-space pos named `mvPosition`; `<fog_vertex>` reads it directly** (fixes C3)

```glsl
#define NWAVES 5
uniform vec4 uWaves[NWAVES]; uniform float uWaveQ[NWAVES];
uniform float uTime, uChoppyScale;
uniform sampler2D uShore; uniform vec4 uShoreParams;
uniform mat4 uReflectMatrix;
const float G = 9.81;

#include <fog_pars_vertex>   // patched in sky.js: declares vFogDepth, vFogWorldPos (under USE_FOG)

varying vec3  vWorldPos;     // displaced world position
varying vec3  vNormalGeom;   // analytic Gerstner normal (world)
varying float vWaveHeight;   // disp.y (foam crest + scatter)
varying float vViewDepth;    // -(viewMatrix*worldPos).z  (eye distance to surface)
varying vec4  vReflectCoord; // projective reflection UV (from UNDISPLACED local pos)
varying float vBottomDepth;  // static bathymetry depth (m) — fallback + foam

void main() {
  vec3 world0 = (modelMatrix * vec4(position, 1.0)).xyz;
  vec2 P = world0.xz;
  float bottomDepth;
  float ampScale = shoreAmp(P, bottomDepth);
  vBottomDepth = bottomDepth;

  vec3 disp = vec3(0.0);
  vec3 T = vec3(0.0,0.0,1.0), B = vec3(1.0,0.0,0.0);
  for (int i = 0; i < NWAVES; i++) {
    vec2  D = normalize(uWaves[i].xy);
    float A = uWaves[i].z * ampScale;
    float L = uWaves[i].w;
    float k = 6.28318530718 / L;
    float w = sqrt(G * k);                 // ω only; TIME_SCALE already folded into uTime
    float Q = uWaveQ[i] * uChoppyScale;
    float ph = k * dot(D, P) + w * uTime;
    float S = sin(ph), C = cos(ph);
    disp.x += Q*A*D.x*C; disp.z += Q*A*D.y*C; disp.y += A*S;
    float kA = k*A;
    B.x -= Q*D.x*D.x*kA*S; B.z -= Q*D.x*D.y*kA*S; B.y += D.x*kA*C;
    T.x -= Q*D.x*D.y*kA*S; T.z -= Q*D.y*D.y*kA*S; T.y += D.y*kA*C;
  }

  vec3 worldPos = world0 + disp;
  vWorldPos    = worldPos;
  vNormalGeom  = normalize(cross(T, B) + vec3(0.0, 1e-4, 0.0)); // +1e-4 guards normalize(0)
  vWaveHeight  = disp.y;

  // (C3 FIX) name it mvPosition so the patched <fog_vertex> (which reads mvPosition) compiles.
  vec4 mvPosition = viewMatrix * vec4(worldPos, 1.0);
  vViewDepth   = -mvPosition.z;
  vReflectCoord = uReflectMatrix * vec4(position, 1.0);  // UNDISPLACED local pos (§4d)

  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>   // patched chunk: uses mvPosition + position/modelMatrix (both present)
}
```

> **Fog chunk facts (verified in sky.js):** the project globally overrides `fog_vertex` to read `mvPosition` (so it MUST be named exactly that, done above) and to compute `vFogWorldPos` from raw `position`→`modelMatrix` (both present here; the small wave-bend error is negligible for fog, matching the chunk's own comment). `<fog_pars_vertex>` declares `vFogDepth`/`vFogWorldPos`. Material must set `fog:true` so `USE_FOG`+`FOG_EXP2` are defined and the includes activate.

---

## 6. FRAGMENT shader spec — full shading order

### 6.1 Fragment header — **merge fog uniforms via material (see §7); patched `<fog_*>` needs `fogColor`/`fogDensity`/`cameraPosition`** (fixes C2)

```glsl
#include <common>
#include <packing>            // perspectiveDepthToViewZ (standard non-reversed branch). Returns NEGATIVE viewZ.
#include <fog_pars_fragment>  // patched in sky.js: declares fogColor, fogDensity, vFogDepth, vFogWorldPos.
                             // cameraPosition is a built-in three uniform (auto-provided to ShaderMaterial).

uniform sampler2D tReflect, tRefract, tDepth, uDetailNormals, uFoamNoise, uShore;
uniform float uTime, uCameraNear, uCameraFar, uHasDepth, uChoppyScale, uReflFar;
uniform vec2  uResolution;
uniform vec3  uCameraPos, uSunDir, uSunColor;
uniform vec4  uShoreParams;
uniform mat4  uRefrViewInv;      // refraction camera matrixWorld (for caustic bed reconstruction, C6)
// ... all tuning uniforms from §7 ...

varying vec3  vWorldPos; varying vec3 vNormalGeom; varying float vWaveHeight;
varying float vViewDepth; varying vec4 vReflectCoord; varying float vBottomDepth;
```

> **fog uniforms are supplied by the material** (`UniformsUtils.merge([UniformsLib.fog, {...}])` in §7), NOT by `fog:true` alone. `fog:true` on a raw `ShaderMaterial` injects the chunk `#include`s and the `USE_FOG`/`FOG_EXP2` defines but does **not** add `fogColor`/`fogDensity` to `material.uniforms`. Omitting the merge → "undeclared identifier `fogColor`" compile error. `cameraPosition` IS auto-provided by three to every `ShaderMaterial`.

### 6.2 Shading order (each step numbered; all `smoothstep` forward-arg)

```glsl
void main() {
  vec3 V = normalize(uCameraPos - vWorldPos);            // surface → eye
  float dist = length(uCameraPos - vWorldPos);
  vec2 P = vWorldPos.xz;
  vec2 screenUV = gl_FragCoord.xy / uResolution;

  float depthWater = max(vBottomDepth, 0.0);             // bathymetry (always valid fallback)
  float shoreFade  = smoothstep(0.0, 1.2, depthWater);   // 0 at edge → 1 deep

  // ---- (1) NORMAL ASSEMBLY (macro + 3 detail octaves, RNM blend) ----
  vec3 N = normalize(vNormalGeom);
  vec2 s  = detailSlope(P,  9.00, vec2( 0.80, 0.60)*0.18) * 1.00;  // wind-aligned, slow
  s      += detailSlope(P,  3.30, vec2(-0.50, 0.85)*0.55) * 0.55;  // cat's-paw, faster
  s      += detailSlope(P,  1.15, vec2( 0.30,-0.95)*1.40) * 0.30;  // fine glitter, fastest
  float detStr = uNormalStrength * smoothstep(0.05, 0.8, depthWater);
  vec3 nDetail = normalize(vec3(-s.x*detStr, 1.0, -s.y*detStr));
  N = rnmBlend(N, nDetail);

  // ---- (2) DISTANCE FLATTEN (anti-strobe) + mip-fade ----
  float nFlat = smoothstep(uFlatNear, uFlatFar, dist);   // 0 near → 1 far
  N = normalize(mix(N, vec3(0.0,1.0,0.0), nFlat * uFlatMax));
  vec2 rc = P * 0.85;
  float footprint = max(length(dFdx(rc)), length(dFdy(rc)));
  float mipFade = 1.0 - smoothstep(0.5, 2.0, footprint); // >2 periods/pixel → flat
  float ld = (1.0 - nFlat) * mipFade;                    // detail-layer LOD weight
  float NdotV = clamp(dot(N, V), 1e-3, 1.0);

  // ---- (3) SCHLICK FRESNEL (F0=0.02), grazing anti-shimmer ----
  float F0 = 0.02;
  float rough = clamp(uBaseRough + dist * uRoughPerMeter, 0.0, 0.35);
  float F90  = clamp(1.0 - rough * 2.2, 0.0, 1.0);
  float F    = clamp(F0 + (F90 - F0) * pow(1.0 - NdotV, 5.0), 0.0, 1.0);

  // ---- (4) REFLECTION (projective + normal distortion), with NEGATIVE-W GUARD (C5/M5) ----
  float reflW = max(vReflectCoord.w, 1e-4);              // (M5 FIX) guard behind-mirror w<=0
  vec2 reflUV = vReflectCoord.xy / reflW;
  float distScale = 1.0 / (1.0 + dist * 0.02);
  reflUV += N.xz * uReflDistort * distScale * mix(0.25, 0.6, shoreFade); // (m2) cap deep-water boost at 0.6
  bool reflValid = (vReflectCoord.w > 1e-4) &&
                   reflUV.x > -0.05 && reflUV.x < 1.05 && reflUV.y > -0.05 && reflUV.y < 1.05;
  reflUV = clamp(reflUV, 0.002, 0.998);
  vec3 reflCol = texture2D(tReflect, reflUV).rgb;
  reflCol = mix(reflCol, reflCol * uSkyTint, 0.12);
  float horizonFade = smoothstep(0.97, 1.0, reflUV.y);
  reflCol = mix(reflCol, uHorizonSky, horizonFade);
  // (M5) where the reflection projection is invalid (grazing / behind mirror), fall back to sky tint
  reflCol = mix(uHorizonSky, reflCol, reflValid ? 1.0 : 0.0);

  // ---- (5) REFRACTION sample + depth-based water column ----
  vec2 refrDistort = N.xz * uRefrDistort * smoothstep(0.0, 3.0, depthWater);
  vec2 refrUV = clamp(screenUV + refrDistort, 0.002, 0.998);
  float rawDepth0 = texture2D(tDepth, refrUV).x;
  float sceneViewZ = perspectiveDepthToViewZ(rawDepth0, uCameraNear, uCameraFar); // negative
  float surfViewZ  = -vViewDepth;                        // negative (eye-space z of surface)
  // foreground reject: scene nearer than surface (less negative) ⇒ revert to undistorted UV
  if (uHasDepth > 0.5 && sceneViewZ > surfViewZ) refrUV = screenUV;
  float rawDepth = texture2D(tDepth, refrUV).x;
  sceneViewZ = perspectiveDepthToViewZ(rawDepth, uCameraNear, uCameraFar);
  vec3 bottomCol = texture2D(tRefract, refrUV).rgb;

  // (C5 FIX) reject sky/far-plane samples (no bed behind water at grazing): treat as max lake depth,
  // and CLAMP the optical column to the physical lake, so no black over-absorbed band at the far shore.
  bool bedHit = (uHasDepth > 0.5) && (rawDepth < 0.999999);
  float colDepthRaw = bedHit ? max(0.0, surfViewZ - sceneViewZ) : depthWater; // surfViewZ>sceneViewZ when bed deeper
  float colDepth = min(colDepthRaw, uLakeMaxPath);      // uLakeMaxPath = LAKE.depth+2 = 11.0
  float pathLen  = min(colDepth / max(NdotV, 0.25), uMaxPath); // uMaxPath=14 (oblique cap)

  // ---- (6) CAUSTICS into bottom (before absorption) — anchored to RECONSTRUCTED BED, not surface XZ (C6) ----
  // reconstruct bed world pos along the refraction view ray at the sampled depth
  vec3 Vrefr = normalize(vWorldPos - uCameraPos);        // eye→surface dir (approx refr ray)
  float bedDist = (-sceneViewZ);                         // positive eye-space distance to bed
  vec3 bedWorld = uCameraPos + Vrefr * bedDist;          // bed point in world space
  vec2 causP = bedHit ? bedWorld.xz : P;                 // anchor caustics on the sand, parallax-correct
  float cDepth = (1.0 - smoothstep(0.0, uCausticDepthMax, colDepth)) * smoothstep(0.04, 0.5, colDepth);
  float sunVis = max(0.0, uSunDir.y);
  vec3  caust  = causticRGB(causP, uTime) * uCausticTint * (uCausticStrength * cDepth * sunVis) * ld;
  bottomCol += bottomCol * caust * uSunColor;

  // ---- (7) BEER-LAMBERT absorption + body inscatter + sandy shelf ----
  const vec3 SIGMA = vec3(0.45, 0.085, 0.045);           // R dies ~10× faster than B (clear lake)
  vec3 absorb = exp(-SIGMA * pathLen);
  vec3 transmitted = bottomCol * absorb + uWaterBodyColor * (1.0 - absorb);
  const vec3 shallowSand = vec3(0.62, 0.55, 0.38);
  float sandMix = 1.0 - smoothstep(0.0, 1.0, colDepth);
  transmitted = mix(transmitted, bottomCol * shallowSand + uWaterBodyColor * 0.05, sandMix * 0.6);

  // ---- (8) DIELECTRIC BASE ----
  vec3 col = mix(transmitted, reflCol, F);

  // ---- (9) SUN SPECULAR + GLITTER (HDR → Bloom/shaft) with LOW-SUN SHEET SUPPRESSION (M8) ----
  vec3 L = normalize(uSunDir);
  vec3 H = normalize(L + V);
  float NdotL = max(dot(N, L), 0.0);
  float NdotH = max(dot(N, H), 0.0);
  vec3 sheen  = uSunColor * pow(NdotH, uSheenPower) * uSheenStrength * NdotL;
  // (M8) at 8° sun elevation the glint forms a broad "sun road"; gate it down to keep discrete sparkles.
  float sunElev = clamp(uSunDir.y, 0.0, 1.0);            // ≈ sin(8°)=0.139 at golden hour
  float lowSun  = smoothstep(0.05, 0.45, sunElev);       // ~0.30 at 8° → strong suppression
  vec2 mbump = (texture2D(uDetailNormals, P*1.15 + uTime*vec2(0.30,-0.95)*1.40).xy * 2.0 - 1.0);
  vec3 Nmicro = normalize(N + vec3(mbump.x, 0.0, mbump.y) * uMicroStrength);
  float glitSharp = mix(64.0, uGlintPower, ld);
  float glint = pow(max(dot(Nmicro, H), 0.0), glitSharp);
  float twinkle = texture2D(uDetailNormals, P*2.3 + uTime*0.6).a;
  // raise gate and clamp strength when the sun is low so the road breaks into sparkles, not a sheet
  float gateLo = mix(uGlintGate + 0.30, uGlintGate, lowSun);   // 8°→gate≈0.85; high sun→0.55
  float gate = smoothstep(gateLo, 1.0, glint * (0.5 + 0.6*twinkle));
  float glintMag = uGlintStrength * mix(0.45, 1.0, lowSun);    // 8°→~0.62× strength
  vec3 glitter = uSunColor * gate * glintMag * step(0.0, NdotL) * shoreFade * ld;
  col += sheen + glitter;

  // ---- (10) SUBSURFACE SCATTER (back-lit crest glow) ----
  vec3 Hs = normalize(L + N * uScatterDistort);
  float back = pow(clamp(dot(V, -Hs), 0.0, 1.0), uScatterPower);
  float crest = smoothstep(0.25, 1.0, clamp(vWaveHeight/0.09, 0.0, 1.0));
  col += uScatterColor * uSunColor * back * crest * uScatterStrength * mix(0.4, 1.0, shoreFade);

  // ---- (11) CREST + SHORE RIM FOAM (occludes everything) ----
  float foamN = texture2D(uFoamNoise, P*0.3 + uTime*0.05).r;
  float crestFoam = smoothstep(uFoamStart, 1.0, clamp(vWaveHeight/0.09,0.0,1.0) * (0.6 + 0.5*foamN));
  float rim = 1.0 - smoothstep(0.04, 0.35, colDepth);
  float foam = clamp(max(crestFoam, rim * 0.8 * foamN), 0.0, 1.0);
  col = mix(col, uFoamColor, foam);

  // ---- (12) SAFETY: finite, non-negative; DO NOT clamp top (HDR for Bloom) ----
  col = max(col, vec3(0.0));

  // ---- (13) ALPHA (soft shoreline) ----
  float alpha = mix(0.6, 1.0, smoothstep(0.0, 0.6, colDepth));
  alpha = max(alpha, foam);

  gl_FragColor = vec4(col, alpha);

  #include <fog_fragment>          // patched Hoffman-Preetham aerial perspective (reads gl_FragColor.rgb)
  #include <tonemapping_fragment>  // NO-OP in composer RT; correct on default FBO (forward-compat)
  #include <colorspace_fragment>   // NO-OP in composer RT; correct on default FBO
}
```

### 6.3 Beer-Lambert depth color ramp (numeric targets, all LINEAR) — **one consistent pathLen model** (fixes M7)

All rows use `pathLen = min(colDepth / max(NdotV,0.25), 14)`. Two columns: near-vertical view (`NdotV≈1` → `pathLen≈colDepth`) and grazing (`NdotV→0.25` → `pathLen≈4·colDepth`, capped 14).

| colDepth | pathLen (vertical) | absorb = exp(−SIGMA·pathLen), vertical | pathLen (grazing, cap 14) | absorb (grazing) | Look |
|---|---|---|---|---|---|
| 0–1.0 m | 0–1.0 | at 1m: (0.638, 0.918, 0.956) | 0–4.0 | at 4m: (0.165, 0.712, 0.835) | bright wet-sand → shelf (sandMix) |
| 3.0 m | 3.0 | (0.259, 0.774, 0.874) | 12.0 | (0.0045, 0.360, 0.583) | emerald→teal vertical; deep blue-green grazing |
| 6.0 m | 6.0 | (0.067, 0.600, 0.764) | 14 (cap) | (0.0018, 0.296, 0.532) | deep teal-blue |
| 11.0 m (lake floor, clamped) | 11.0 | (0.0071, 0.392, 0.604) | 14 (cap) | (0.0018, 0.296, 0.532) | deep blue-green, bottom invisible |

> The deep-water tint approaches `uWaterBodyColor` (set below) as `absorb→0`. **`uWaterBodyColor = vec3(0.012, 0.115, 0.105)`** — chosen with **g ≳ b** so the asymptote is genuinely **emerald/teal-green**, not blue (fixes M7's "body is blue, not emerald" defect — the original `(0.012,0.10,0.13)` had g<b). The emerald mid-tone is then reinforced by surviving bottom green; do not add a separate color ramp. If emerald still reads weak, nudge `uWaterBodyColor.g` to 0.12–0.14 (keep g ≥ b).

### 6.4 Output convention — RESOLVED, with custom-fog caveat

End the fragment shader with `#include <fog_fragment>` then `#include <tonemapping_fragment>` then `#include <colorspace_fragment>`. Emit LINEAR HDR.

Reasoning: in r0.184, `TONE_MAPPING`/output-colorspace conversion is defined only when `_currentRenderTarget === null`; rendering into the composer's HDR RT makes them identity. So both includes are **verified no-ops in this pipeline** yet **correct** if water ever renders to the default framebuffer — zero-risk forward-compat, and they cost nothing because they don't fire. Bloom sees raw HDR glints. `<fog_fragment>` is **mandatory** and here it is the project's **custom Hoffman-Preetham `FogExp2`** chunk (sky.js) that performs extinction + sun-aware inscatter on `gl_FragColor.rgb`; the water must recede into the same aerial perspective as terrain. The material **must NOT set `glslVersion: GLSL3`** (default GLSL1) so all three chunks operate on `gl_FragColor` (fixes M9). The upgraded shore foam (§9) likewise switches to `<fog_fragment>` (it currently has tonemap/colorspace includes but no fog — so today it does NOT fog, a real seam; adding fog fixes that).

---

## 7. UNIFORM TABLE — **fog uniforms merged in** (fixes C2)

Build the uniforms with:
```js
const material = new THREE.ShaderMaterial({
  uniforms: THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,   // fogColor, fogDensity, fogNear, fogFar  (REQUIRED — fog:true won't add these)
    { /* all water uniforms below */ },
  ]),
  fog: true,                 // injects #include chunks + USE_FOG/FOG_EXP2 defines
  transparent: true, depthWrite: true, side: THREE.FrontSide,
  vertexShader, fragmentShader,
});
// three syncs fogColor/fogDensity from scene.fog automatically when fog:true and material is in-scene.
```

| Uniform | Type | Default | Written by |
|---|---|---|---|
| `fogColor` | vec3 | from `scene.fog` (`0xe2c8a8`) | merged from `UniformsLib.fog`; three syncs from `scene.fog` |
| `fogDensity` | float | `0.0014` (from `scene.fog`) | merged; three syncs |
| `fogNear`/`fogFar` | float | unused under FOG_EXP2 | merged (harmless) |
| `uTime` | float | `{value:0}` **fresh object — NEVER aliased to `sharedUniforms.uTime`** (C1) | `group.userData.update(time)` → `time * 0.5` |
| `uSunDir` | vec3 | **aliased** `sharedUniforms.uSunDir` (by reference) | main.js (shared ref) |
| `uSunColor` | vec3/Color | **aliased** `sharedUniforms.uSunColor` (`0xffc587`→linear ~`(1.0,0.773,0.529)`) | main.js (shared ref) |
| `uCameraPos` | vec3 | — | controller `onBeforeRender` |
| `tReflect` | sampler2D | neutral 1×1 | controller |
| `tRefract` | sampler2D | neutral 1×1 | controller |
| `tDepth` | sampler2D (DepthTexture) | neutral 1×1 (gated off by `uHasDepth=0`) | controller |
| `uReflectMatrix` | mat4 | identity | controller |
| `uRefrViewInv` | mat4 | identity | controller (caustic bed reconstruction) |
| `uReflFar` | float | 1200 | controller |
| `uHasDepth` | float | 0.0 → 1.0 after first RT render | controller |
| `uCameraNear` | float | 0.1 | controller |
| `uCameraFar` | float | 3000 | controller |
| `uResolution` | vec2 | refractionRT size | controller / setSize |
| `uShore` | sampler2D | `bakeShoreMask(512)` | static (build) |
| `uShoreParams` | vec4 | `(-400, -130, 500, 16)` | static |
| `uDetailNormals` | sampler2D | `generateWaterNormals()` | static |
| `uFoamNoise` | sampler2D | reuse `generateWaterNormals()` (.r) | static |
| `uWaves[5]` | vec4[] | §5.1 table | static |
| `uWaveQ[5]` | float[] | `[0.18,0.16,0.13,0.09,0.06]` | static |
| `uChoppyScale` | float | 1.0 | static |
| `uLakeMaxPath` | float | `LAKE.depth + 2.0` = 11.0 | static (C5 clamp) |
| **Normals** |||
| `uNormalStrength` | float | 0.65 | static |
| `uMicroStrength` | float | 1.6 | static |
| `uFlatNear` / `uFlatFar` / `uFlatMax` | float | 25.0 / 220.0 / 0.8 | static |
| **Fresnel** | `uBaseRough` / `uRoughPerMeter` | 0.02 / 0.0016 | static |
| **Reflection** | `uReflDistort` / `uSkyTint` / `uHorizonSky` | 0.045 / (0.78,0.85,1.00) / (0.62,0.70,0.86) | static |
| **Refraction/absorption** | `uRefrDistort` / `uMaxPath` / `uWaterBodyColor` | 0.06 / 14.0 / **(0.012,0.115,0.105)** | static |
| `SIGMA` / `shallowSand` | in-shader const | (0.45,0.085,0.045) / (0.62,0.55,0.38) | — |
| **Caustics** | `uCausticTint` / `uCausticScale` / `uCausticSpeed` / `uCausticStrength` / `uCausticChroma` / `uCausticDepthMax` / `uCausticRidge` / `uCausticGain` | (0.55,0.85,1.0) / 0.85 / 0.13 / 1.35 / 0.018 / 4.5 / 3.5 / 1.5 | static (last two promoted from magic numbers, m6) |
| **Specular/glitter** | `uSheenPower` / `uSheenStrength` / `uGlintPower` / `uGlintGate` / `uGlintStrength` | 120.0 / 1.2 / 900.0 / 0.55 / 6.0 | static |
| **Scatter** | `uScatterColor` / `uScatterStrength` / `uScatterPower` / `uScatterDistort` | (0.18,0.55,0.42) / 1.3 / 3.0 / 0.5 | static |
| **Foam** | `uFoamStart` / `uFoamColor` | 0.6 / (0.92,0.94,0.95) | static |

> **Aliasing rule (C1-hardened):** assign shared uniform **objects** `uSunDir`, `uSunColor` by reference so main.js updates propagate. **`uTime` is a brand-new `{ value: 0 }` object and must NEVER be `= sharedUniforms.uTime`** — `userData.update` writes `time*0.5` into it, and aliasing would leak the half-speed clock into grass/vegetation (which read `sharedUniforms.uTime` at raw speed, main.js:314). Add an inline comment at the assignment site: `// DO NOT alias sharedUniforms.uTime — would leak *0.5 into grass`.

---

## 8. DETAIL layers (helper GLSL — defined before `main`)

### Detail-normal octave sampler + RNM blend

```glsl
vec2 detailSlope(vec2 worldXZ, float scale, vec2 vel) {
  vec2 uv = worldXZ / scale + vel * uTime / scale;
  return texture2D(uDetailNormals, uv).xy * 2.0 - 1.0;   // [-1,1]
}
vec3 rnmBlend(vec3 b, vec3 d) {
  vec3 t = b + vec3(0.0, 1.0, 0.0);
  vec3 u = d * vec3(-1.0, 1.0, -1.0);
  return normalize(t * dot(t, u) / max(t.y, 1e-3) - u);
}
```

### Caustics (ridged value-noise, chromatic) — quintic to match noise.js `smooth()`; magic numbers promoted (m6)

```glsl
float cnHash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453123); }
float cNoise(vec2 p){
  vec2 i=floor(p), f=fract(p);
  f = f*f*f*(f*(f*6.0-15.0)+10.0);                 // quintic, matches noise.js smooth()
  return mix(mix(cnHash(i),           cnHash(i+vec2(1,0)), f.x),
             mix(cnHash(i+vec2(0,1)), cnHash(i+vec2(1,1)), f.x), f.y);
}
float causticField(vec2 wxz, float t){
  vec2 a = wxz * uCausticScale;
  vec2 flow = vec2(cNoise(a*0.5 + t*0.07), cNoise(a*0.5 - t*0.06)) - 0.5;
  vec2 p = a + flow * 1.6;
  float n1 = cNoise(p            + vec2( t,  t*0.8) * uCausticSpeed);
  float n2 = cNoise(p*1.93 + 5.2 + vec2(-t*0.9, t) * uCausticSpeed);
  float r1 = 1.0 - abs(n1*2.0 - 1.0);
  float r2 = 1.0 - abs(n2*2.0 - 1.0);
  return pow(r1*r2, uCausticRidge) * uCausticGain; // uCausticRidge=3.5, uCausticGain=1.5 (m6)
}
vec3 causticRGB(vec2 wxz, float t){
  vec2 o = vec2(uCausticChroma, 0.0);
  return vec3(causticField(wxz+o.xy, t), causticField(wxz, t), causticField(wxz-o.xy, t));
}
```

> **Caustics anchored to the bed (C6):** `causticRGB` is called in §6 step 6 with `causP = bedHit ? bedWorld.xz : P` — the reconstructed bed world-XZ, not the surface XZ. This makes the caustic pattern sit on the sand and stay put as the camera moves (parallax-correct), instead of sliding across the bottom. This is an approximation (it ignores in-water refraction of the sun ray), but it is anchored to the actual bottom geometry, which is the visually important fix.

**Sparkle = HDR budget + low-sun sheet control (M8):** at the actual 8° sun elevation (`uSunDir.y≈0.139`), `lowSun≈0.30`, raising the glitter gate to ≈0.85 and scaling magnitude to ≈0.62× — this breaks the physically-broad low-sun "glint road" into discrete sparkles rather than a blown-white sheet, exactly the failure the prompt warned about. Peak sparkle `≈ 0.62·6.0·0.83 ≈ 3.1` still clears Bloom (0.85) and shaft (2.4). Glitter normal is kept out of reflection/refraction UV distortion (only macro+detail `N` distorts those) to avoid RT shimmer-alias.

---

## 9. SHORE FOAM — keep separate (decision) + spec

**Decision: keep foam as a separate additive plane on layer 1.** Folding it into the water material would force foam to inherit depth-fade/Fresnel and break additive-over-sand blending at the lapping line. Shared data = live Gerstner wave height, passed via a height-only Gerstner uniform set so crest foam aligns with real crests.

**Upgrades to current `createShoreFoam` (source uses `vUv` mask sampling and tonemap/colorspace includes, no fog):**
1. **Fog:** merge `UniformsLib.fog` into its uniforms and set `fog:true`; **add** `#include <fog_pars_vertex>`/`<fog_vertex>` (VS) and replace `<tonemapping_fragment>`/`<colorspace_fragment>` with `#include <fog_pars_fragment>` + `#include <fog_fragment>`. The VS must name view-space pos `mvPosition` so the patched fog chunk compiles. Today the foam has NO fog → it doesn't recede with the scene (a real seam at distance); this fixes it. (Tonemap/colorspace were no-ops in the composer RT, so dropping them is tidiness, not a visible bug.)
2. **Keep mask sampling by `vUv`** (the foam plane is `PlaneGeometry(SHORE_AREA)` centered on `SHORE_CENTER=LAKE`, so `vUv` 0..1 spans the 500m mask exactly — do NOT cross-wire it to the water shader's world-XZ `uShoreParams` scheme; they are different, both correct). (M1 cross-wiring guard.)
3. **Wave coupling:** add a height-only Gerstner sum `waveHeight(vWorld, uTime)` using the **same** `uWaves`/`uWaveQ` so the lapping line advances on crests: `effDepth = depth + waveHeight(...)`, `edge = 1.0 - smoothstep(0.02, 0.30 + wob, abs(effDepth))`.
4. **`uTime`:** the foam's `uTime` is driven by `group.userData.update(time*0.5)` (its OWN uniform), matching the water's glassiness — NOT the shared raw clock (the old foam used shared raw `uTime`; we switch it to the scaled private clock for consistency with the new water).
5. Keep at `WATER_LEVEL + 0.03`, `renderOrder=1`, `layers.set(1)`, `depthWrite:false`.

**Wet sand (out of scope — propose separately):** additive foam can't darken, so the dry/wet sand transition on the **terrain** at `WATER_LEVEL` is **a known, unsolved color seam** (m5 — explicitly NOT resolved here). A proper fix is a wet-sand band in terrain.js's `<color_fragment>` keyed on height near `WATER_LEVEL`; that is a separate terrain.js change and is not bundled into this water.js rewrite.

---

## 10. main.js / integration changes

**main.js requires ZERO changes.** External contract preserved exactly:
- `createWater(sunDirection, sharedUniforms)` → returns `THREE.Group`.
- `group.userData.update(time)` → writes `time * 0.5` into the water's and foam's **private** `uTime` objects (matching old `time*0.5` pacing; does NOT touch `sharedUniforms.uTime`).
- RT rendering self-drives via `waterMesh.onBeforeRender` (fires inside `RenderPass`).
- `sharedUniforms.uSunDir`/`uSunColor` aliased by reference → main.js per-frame writes propagate.
- Fog: the material merges `UniformsLib.fog` + `fog:true`, and the project's globally-patched fog chunks (sky.js) make it match terrain/grass aerial perspective. `createSky` runs before `createWater`, so `scene.fog` and the chunks exist at compile time (verified).

**Resize (lazy, zero main.js change):** the `WaterRT` is allocated on the first `onBeforeRender` (which receives `renderer`) at `renderer.getDrawingBufferSize()`, and registers a `resize` listener then that calls `rt.setSize(...)` with the new drawing-buffer size. Frame-0 before allocation uses neutral fallbacks + `uHasDepth=0`. `group.userData.setSize(w,h)` is also exposed for an optional explicit call, but is not required.

**GTAO interaction (M10 — documented limitation):** `GTAOPass(scene, camera)` (main.js:72) runs its own depth/normal prepass over the scene. A `transparent:true` material is generally excluded from that prepass, so the water surface is **absent from GTAO depth** → AO can be computed through the water onto the bed, producing faint dark halos near the waterline. This is **accepted and documented**, mitigated by: (a) the shore rim foam and soft alpha at the lip cover the worst of it; (b) GTAO `radius=0.7m` is small, so bleed is local. If it proves objectionable, the follow-up (out of scope) is to register the water in GTAO's prepass via a dedicated depth material or add the mesh to `userData.excludeFromGTAO` and accept no AO on it. Do not silently rely on `depthWrite:true` solving this — it only affects the main color pass, not the GTAO prepass.

**Cleanup:** `group.userData.dispose = () => { rt.dispose() (both RTs + depthTexture); material.dispose(); geometry.dispose(); foam.material.dispose(); foam.geometry.dispose(); shoreTex.dispose(); detailTex.dispose(); removeEventListener('resize', ...); }`.

---

## 11. BUILD SEQUENCE (ordered, verifiable)

1. **Geometry + flat material + fog wiring.** Build 540²×512² plane (rotated, positioned, boundingSphere set AFTER rotate), trivial `ShaderMaterial` (merge `UniformsLib.fog`, `fog:true`, GLSL1, name view-space pos `mvPosition`, include `<fog_*>`) returning constant emerald, as `Group` with `userData.update` writing `time*0.5`. **Verify it compiles** (fog uniforms present), renders over the lake, fogs with distance, no errors. (Locks contract + the C2/C3 compile fixes.)
2. **Gerstner VS + analytic normals.** 5 waves + analytic TBN; output `vNormalGeom*0.5+0.5`. Add shore-mask amplitude damping; verify waves flatten at the lip, no kinks.
3. **Reflection RT.** `WaterRT` reflection pass: mirror camera (far≤1200) + oblique +Y clip (bias on plane constant) + texture matrix + save/restore + recursion guard + `layers.set(0)`. Sample `tReflect` with the negative-w guard. Verify mountains/sky reflect; grass/flowers (layer 1) and water itself absent from reflection; no grazing edge streak (C5/M5).
4. **Refraction RT + depthTexture.** Refraction pass (main camera, −Y oblique clip, 0.5×, samples:0, DepthTexture). Compute `colDepth` via `perspectiveDepthToViewZ`, clamp to `uLakeMaxPath`, reject sky samples. Show raw `bottomCol`, then Beer-Lambert. Verify sandy bottom in shallows, emerald→blue in deep, NO black band at the far shore (C5), foreground-reject works.
5. **Fresnel blend** (F0=0.02 + F90 anti-shimmer). Verify grazing→reflective, top-down→see-through; no grazing fireflies on far shore.
6. **Detail normals + glitter + caustics.** 3 detail octaves (RNM); micro-normal glitter with low-sun suppression (verify at the real 8° sun it is discrete sparkles, NOT a sheet — M8); caustics anchored to reconstructed bed (verify they sit on the sand and don't slide with the camera — C6), fade by 4.5m.
7. **Scatter + crest foam.** Back-lit crest glow + height/rim crest foam.
8. **Shore foam upgrade.** Add fog (merge `UniformsLib.fog`, `fog:true`, `mvPosition`, `<fog_*>`), drop tonemap/colorspace, couple to live wave height, drive private `uTime*0.5`, keep `vUv` mask sampling. Verify still excluded from reflection (layer 1), fogs with distance.
9. **Distance LOD** (`nFlat` + `dFdx/dFdy` mip-fade). Verify far water flattens, no crawling shimmer.
10. **Resize + fog/exposure consistency + perf.** Resize re-allocates RTs (clamped). Compare water radiance vs terrain at the waterline (linear HDR, single tonemap at OutputPass); fog matches. **Profile frame time** with both RTs active (M3) — confirm the 0.5× reflection + far≤1200 + cap 1536 keeps the 3× scene-render cost acceptable; drop to 384² geometry or 0.4× RT if needed.

---

## 12. FAILURE MODES & guards

| Failure | Cause | Guard / Fix |
|---|---|---|
| **Shader won't compile — undeclared `fogColor`/`fogDensity`** | raw `ShaderMaterial` + `fog:true` does NOT auto-add fog uniforms | **(C2)** merge `THREE.UniformsLib.fog` into `material.uniforms`; `fog:true` only injects chunks+defines |
| **Shader won't compile — undeclared `mvPosition` in `<fog_vertex>`** | project's patched `fog_vertex` reads `mvPosition` | **(C3)** name the view-space position exactly `mvPosition` in the VS |
| **Half-speed clock leaks into grass** | aliasing `material.uniforms.uTime = sharedUniforms.uTime` then writing `*0.5` | **(C1)** `uTime` is a fresh `{value:0}`, never aliased; `userData.update` writes only into it; only `uSunDir`/`uSunColor` are aliased |
| Waterline gap band growing with distance | biasing `projectionMatrix[10]` tilts the clip plane | **(C4)** bias the world-space plane **constant** (`plane.constant += CLIP_BIAS`); keep `M[10]=cp.z+1.0` |
| Black over-absorbed band at far shore | `colDepth` runs to far plane where bed sample misses (sky) | **(C5)** reject `rawDepth≥0.999999` (sky), clamp `colDepth ≤ uLakeMaxPath=11`, cap `pathLen≤14` |
| Caustics slide across the bottom with camera | computed at surface XZ, not bed | **(C6)** reconstruct bed world pos from refraction depth; sample caustics at `bedWorld.xz` |
| Grazing reflection edge streak / garbage at horizon | `vReflectCoord.w ≤ 0` behind mirror; clamp smears edge texel | **(M5)** `reflW=max(w,1e-4)`; if `w≤1e-4` or UV far out of range, fall back to `uHorizonSky` |
| Frame-rate cliff (3× full-scene render, grass-heavy) | reflection 0.75× full far + refraction, no RT culling | **(M3)** reflection 0.5×, cap 1536²; `reflCam.far≤1200`; grass LOD honored by RT cams; cap refraction too (m3) |
| Low-sun glitter blows into a white sheet | broad "sun road" at 8° elevation + Bloom | **(M8)** `lowSun` factor raises gate (~0.85) + scales strength (~0.62×) at low sun → discrete sparkles |
| AO dark halo at waterline | water (`transparent`) absent from GTAO depth prepass | **(M10)** documented limitation; mitigated by rim foam + soft alpha; follow-up = custom depth material (out of scope) |
| Deep water reads blue, not emerald | `uWaterBodyColor` had g<b | **(M7)** `uWaterBodyColor=(0.012,0.115,0.105)` (g≳b); consistent pathLen table in §6.3 |
| Infinite recursion / stack overflow | nested `renderer.render()` re-fires water's `onBeforeRender` | `_rendering` re-entry guard (bail first); `camera.userData.isWaterRT` early-return; `mesh/foam.visible=false` during both passes |
| Composer pipeline broken | `setRenderTarget(null)` instead of saved RT | save `renderer.getRenderTarget()` (= composer HDR RT), restore THAT, never `null` |
| Black water on frame 0 | RTs not yet rendered | neutral 1×1 fallbacks (dim teal, m7); `uHasDepth=0` → mask-derived `vBottomDepth` color |
| Self-reflection / water in refraction | water/foam in nested renders | `mesh/foam.visible=false` before both passes; restore after |
| Layer-1 (grass/flowers/foam) in reflection | RT camera inherits 0\|1 mask | `reflCam.layers.set(0)` and `refrCam.layers.set(0)` (never copy `camera.layers.mask`) |
| Below-water geom in reflection / above-water in refraction | no oblique clip | Lengyel oblique near-plane baked into each RT cam's proj (+Y reflection, −Y refraction); + foreground-reject |
| Scene-wide material recompile | `renderer.clippingPlanes` | NEVER touch it; clip is per-camera projection only |
| MSAA depth read fails | multisampled refraction RT + depthTexture | refraction RT `samples:0` (reflection `samples:4`, no depth) |
| Reversed-arg `smoothstep` (UB) | `smoothstep(hi,lo,x)` | every `smoothstep(a,b,x)` has `a<b`; "fade out" uses `1.0 - smoothstep(a,b,x)` |
| NaN normals → NaN pixels | `normalize(0)`; `pow(neg,…)`; `w≈0` | `vNormalGeom + vec3(0,1e-4,0)`; `clamp(NdotV,1e-3,1)`; `max(dot,0)` before `pow`; clamp UVs; `reflW=max(w,1e-4)` |
| Double tonemap / washed-out water | tonemap/colorspace firing in RT | verified no-ops when RT≠null; HDR survives to Bloom; **material must NOT set `glslVersion:GLSL3`** (M9) so chunks act on `gl_FragColor` |
| Foam no longer fogs / hard distant seam | old foam has no `<fog_*>` | upgrade foam: merge `UniformsLib.fog`, `fog:true`, `mvPosition`, `<fog_*>` (§9) |
| Foam mask cross-wired to water world-XZ scheme | "reuse" confusion | keep foam mask sampling by `vUv` (centered 500m plane); water uses world-XZ `uShoreParams` — distinct, both correct (M1) |
| Time-scale double-applied to waves | `ω=√(gk)·TS` AND `uTime=t·TS` | **(m1)** `ω=√(gk)` only; TS folded once into `uTime` |
| Reflection sample off-screen at deep horizon | deep-water distortion boost pushes UV out | **(m2)** cap distortion boost `mix(0.25,0.6,shoreFade)` (was up to 1.0) |
| VRAM blowup at 4K | uncapped refraction RT | **(m3)** cap both RTs at 1536² |
| Magic numbers in caustics | `3.5`, `1.5` hardcoded | **(m6)** promoted to `uCausticRidge`, `uCausticGain` |
| Bright frame-0 teal flash | bright neutral fallback | **(m7)** neutral `(12,28,38)` → dim linear teal |
| Frustum pop along surface | stale `PlaneGeometry` sphere | manual `boundingSphere` set AFTER `rotateX` (M2; isotropic radius+0.5 slack) |
| Mirror smears with waves | feeding displaced pos into reflection matrix | `vReflectCoord` uses UNDISPLACED local `position`; wobble only via `N.xz` UV distortion |
| Wet/dry sand seam on terrain at WATER_LEVEL | additive foam can't darken | **(m5)** KNOWN unsolved; fix is in terrain.js `<color_fragment>` (out of scope) |
| Shadows recomputed in RT passes | shadow autoUpdate during nested renders | `renderer.shadowMap.autoUpdate=false` around RTs, restore after |
| RT not cleared (stale frame) | composer leaves `autoClear=false` | `renderer.state.buffers.depth.setMask(true)` + `if(autoClear===false) renderer.clear()` before each pass (#18897) |
| Wrong viewport after RTs | RT viewport left active | restore `renderer.state.viewport(camera.viewport)` and saved RT at end |
| Depth precision banding (shore) | 24-bit depth, near=0.1/far=3000 | linearize via `perspectiveDepthToViewZ`; if banding, switch DepthTexture to `FloatType`+`DepthFormat` |

---

### Files relevant to implementation (all absolute)
- `/Users/ckazu/work/openworld_survey/src/water.js` — full rewrite target; reuse `generateWaterNormals`, call `bakeShoreMask(512)` (source default is 256), keep `SHORE_AREA=500`/`SHORE_RANGE=8`/`SHORE_CENTER=LAKE`, upgrade `createShoreFoam` (add fog, wave-couple, keep `vUv` mask, private `uTime*0.5`).
- `/Users/ckazu/work/openworld_survey/src/main.js` — NO edits; contract: `createWater(sunDirection, sharedUniforms)→Group`, `water.userData.update(time)` per frame (writes only the water's private `uTime`), `camera.layers.enable(1)`, composer HalfFloat MSAA RT, Bloom threshold 0.85, shaft luma 2.4-5.5. `sharedUniforms.uTime` is written RAW (:314) and shared by grass — never alias it.
- `/Users/ckazu/work/openworld_survey/src/sky.js` — **globally patches `THREE.ShaderChunk.fog_pars_vertex/fog_vertex/fog_pars_fragment/fog_fragment`** (Hoffman-Preetham `FogExp2`, sun baked as GLSL constants). The patched `fog_vertex` reads `mvPosition`; `fog_fragment` reads `fogColor`/`fogDensity`/`cameraPosition` and writes `gl_FragColor.rgb`. `scene.fog = FogExp2(0xe2c8a8, 0.0014)`. `createSky` runs before `createWater` — ordering OK.
- `/Users/ckazu/work/openworld_survey/src/terrain.js` — `WORLD_SIZE=800`, `WATER_LEVEL=-0.6`, `LAKE={x:-150,z:120,radius:130,depth:9}`, `terrainHeight`, `geometry.rotateX(-Math.PI/2)` pattern. Optional separate wet-sand `<color_fragment>` (m5, out of scope).
- `/Users/ckazu/work/openworld_survey/src/noise.js` — `tileableFbm`/`fbm` (CPU) for DataTextures; in-shader caustics use quintic `cNoise` matching its `smooth()`.