// Progressive voxel path tracer. One sample per pixel per dispatch, summed into `accum`.
//
// Traversal: a coarse 8×8×8 "brick" occupancy grid lets rays skip empty space, then a fine
// DDA walks voxels inside occupied bricks. Rays travelling inside glass use the same walk
// but stop at the first voxel that isn't the glass they are in (that's the exit surface).
//
// Lighting: sun (sampled directly, with soft shadows that pass through glass), plus a sky
// that is uniform, an analytic atmosphere, or an HDR environment image.

export const PATHTRACE_WGSL = /* wgsl */ `
struct Params {
  camPos: vec4f,      // w: aperture radius (0 = pinhole)
  camFwd: vec4f,      // w: focus distance
  camRight: vec4f,    // w: tan(fov/2) for perspective, half-height for orthographic
  camUp: vec4f,       // w: 0 perspective, 1 orthographic
  sunDir: vec4f,      // direction towards the sun; w: cos(angular radius)
  sunColor: vec4f,    // rgb irradiance; w: 1 enabled
  skyColor: vec4f,    // rgb radiance of the uniform sky
  bgColor: vec4f,     // rgb; w: 1 = camera rays that miss show this instead of the sky
  ground: vec4f,      // rgb albedo; w: 1 enabled
  gridOrigin: vec4f,  // world position of voxel (0,0,0); w: ground height (world z)
  dims: vec4u,        // grid size; w: sample index
  misc: vec4u,        // x width, y height, z max bounces, w seed
  rayleigh: vec4f,    // atmosphere: rgb Rayleigh colour × density; w Mie density
  mie: vec4f,         // rgb Mie colour; w Mie anisotropy g
  env: vec4f,         // x sky mode (0 uniform, 1 atmosphere, 2 HDR), y HDR intensity, z HDR rotation (rad), w atmosphere intensity
  extra: vec4f,       // x scene radius, y horizon fade, z show sun disk, w fog anisotropy g
  envSample: vec4u,   // x,y size of the sky sampling table; z 1 = importance sampling on
  fog: vec4f,         // rgb fog colour (scattering albedo); w extinction per voxel (0 = off)
};

struct Material {
  color: vec4f,  // linear rgb, a = alpha
  a: vec4f,      // x type (0 diffuse, 1 metal, 2 glass, 3 emit, 4 blend, 5 media), y rough, z metal, w emit
  b: vec4f,      // x ior, y flux, z spec, w transparency (0-1)
  c: vec4f,      // x density, y 1 = scattering medium inside, z phase anisotropy g, w reserved
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var voxels: texture_3d<u32>;
@group(0) @binding(2) var bricks: texture_3d<u32>;
@group(0) @binding(3) var<storage, read> mats: array<Material, 256>;
@group(0) @binding(4) var<storage, read_write> accum: array<vec4f>;
@group(0) @binding(5) var envTex: texture_2d<f32>;
@group(0) @binding(6) var<storage, read> envTable: array<f32>;

const PI = 3.14159265359;
const BRICK = 8;
const GROUND_ID = 256u;
const BIG = 1e30;
const EPS = 1e-3;
// Density scale for media inside voxels. TODO(match): calibrate against MagicaVoxel's _d.
const MEDIA_SCALE = 40.0;

// ---------- random numbers ----------
var<private> rngState: u32;
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rand() -> f32 {
  rngState = pcg(rngState);
  return f32(rngState >> 8u) * (1.0 / 16777216.0);
}

// ---------- sampling ----------
fn basis(n: vec3f) -> mat3x3f {
  let s = select(-1.0, 1.0, n.z >= 0.0);
  let a = -1.0 / (s + n.z);
  let b = n.x * n.y * a;
  let t = vec3f(1.0 + s * n.x * n.x * a, s * b, -s * n.x);
  let bt = vec3f(b, s + n.y * n.y * a, -n.y);
  return mat3x3f(t, bt, n);
}
fn cosineHemisphere(n: vec3f) -> vec3f {
  let u = rand(); let v = rand();
  let r = sqrt(u); let phi = 2.0 * PI * v;
  return normalize(basis(n) * vec3f(r * cos(phi), r * sin(phi), sqrt(max(0.0, 1.0 - u))));
}
fn sampleCone(dir: vec3f, cosMax: f32) -> vec3f {
  let u = rand(); let v = rand();
  let c = 1.0 - u * (1.0 - cosMax);
  let s = sqrt(max(0.0, 1.0 - c * c));
  let phi = 2.0 * PI * v;
  return normalize(basis(dir) * vec3f(s * cos(phi), s * sin(phi), c));
}
fn randomInDisk() -> vec2f {
  let r = sqrt(rand()); let phi = 2.0 * PI * rand();
  return vec2f(cos(phi), sin(phi)) * r;
}
fn randomUnit() -> vec3f {
  let z = rand() * 2.0 - 1.0; let phi = 2.0 * PI * rand();
  let r = sqrt(max(0.0, 1.0 - z * z));
  return vec3f(r * cos(phi), r * sin(phi), z);
}

// ---------- voxel traversal ----------
// A hit is the first cell whose id differs from \`inside\` (0 = travelling through air).
// n points back towards the ray's origin, across the face that was crossed.
struct Hit { t: f32, n: vec3f, id: u32, hit: bool };

fn safeInv(d: vec3f) -> vec3f {
  return 1.0 / select(d, vec3f(1e-9), abs(d) < vec3f(1e-9));
}

fn traceBrick(ro: vec3f, rd: vec3f, inv: vec3f, bcell: vec3i, tStart: f32, tEnd: f32, n0: vec3f, inside: u32) -> Hit {
  var h: Hit; h.hit = false;
  let lo = bcell * BRICK;
  let hi = min(lo + vec3i(BRICK), vec3i(P.dims.xyz)) - vec3i(1);
  let stepf = sign(rd);
  let st = vec3i(stepf);
  var v = clamp(vec3i(floor(ro + rd * tStart)), lo, hi);
  let tDelta = abs(inv);
  var tNext = select(vec3f(BIG), (vec3f(v) + max(stepf, vec3f(0.0)) - ro) * inv, st != vec3i(0));
  var t = tStart;
  var n = n0;
  for (var i = 0; i < 32; i++) {
    if (any(v < lo) || any(v > hi) || t > tEnd) { break; }
    let id = textureLoad(voxels, v, 0).r;
    if (id != inside) { h.hit = true; h.t = t; h.n = n; h.id = id; return h; }
    if (tNext.x < tNext.y && tNext.x < tNext.z) { v.x += st.x; t = tNext.x; tNext.x += tDelta.x; n = vec3f(-stepf.x, 0.0, 0.0); }
    else if (tNext.y < tNext.z) { v.y += st.y; t = tNext.y; tNext.y += tDelta.y; n = vec3f(0.0, -stepf.y, 0.0); }
    else { v.z += st.z; t = tNext.z; tNext.z += tDelta.z; n = vec3f(0.0, 0.0, -stepf.z); }
  }
  return h;
}

// ro is in grid space (world minus gridOrigin).
fn traceGrid(ro: vec3f, rd: vec3f, tLimit: f32, inside: u32) -> Hit {
  var h: Hit; h.hit = false; h.t = tLimit;
  let dims = vec3f(P.dims.xyz);
  let inv = safeInv(rd);
  let ta = (vec3f(0.0) - ro) * inv;
  let tb = (dims - ro) * inv;
  let tmin3 = min(ta, tb);
  let tmax3 = max(ta, tb);
  let tEnter = max(max(tmin3.x, tmin3.y), max(tmin3.z, 0.0));
  let tExit = min(min(tmax3.x, tmax3.y), tmax3.z);
  if (tEnter >= tExit || tEnter > tLimit) { return h; }

  let stepf = sign(rd);
  let st = vec3i(stepf);
  var n = vec3f(0.0);
  if (tmin3.x >= tmin3.y && tmin3.x >= tmin3.z) { n = vec3f(-stepf.x, 0.0, 0.0); }
  else if (tmin3.y >= tmin3.z) { n = vec3f(0.0, -stepf.y, 0.0); }
  else { n = vec3f(0.0, 0.0, -stepf.z); }

  let bdims = (vec3i(P.dims.xyz) + vec3i(BRICK - 1)) / BRICK;
  let B = f32(BRICK);
  var cell = clamp(vec3i(floor((ro + rd * tEnter) / B)), vec3i(0), bdims - vec3i(1));
  let tDelta = abs(inv) * B;
  var tNext = select(vec3f(BIG), (vec3f(cell) * B + max(stepf, vec3f(0.0)) * B - ro) * inv, st != vec3i(0));
  var t = tEnter;
  for (var i = 0; i < 1024; i++) {
    if (any(cell < vec3i(0)) || any(cell >= bdims) || t > tExit || t > tLimit) { break; }
    let tCellExit = min(min(tNext.x, tNext.y), tNext.z);
    // Inside glass every brick must be walked: an empty brick is where the glass ends.
    if (inside != 0u || textureLoad(bricks, cell, 0).r != 0u) {
      let r = traceBrick(ro, rd, inv, cell, t, min(tCellExit, tExit), n, inside);
      if (r.hit && r.t < tLimit) { return r; }
    }
    if (tNext.x < tNext.y && tNext.x < tNext.z) { cell.x += st.x; t = tNext.x; tNext.x += tDelta.x; n = vec3f(-stepf.x, 0.0, 0.0); }
    else if (tNext.y < tNext.z) { cell.y += st.y; t = tNext.y; tNext.y += tDelta.y; n = vec3f(0.0, -stepf.y, 0.0); }
    else { cell.z += st.z; t = tNext.z; tNext.z += tDelta.z; n = vec3f(0.0, 0.0, -stepf.z); }
  }
  return h;
}

// World-space scene query: voxels plus the optional ground plane.
fn traceScene(ro: vec3f, rd: vec3f, inside: u32) -> Hit {
  var h = traceGrid(ro - P.gridOrigin.xyz, rd, BIG, inside);
  if (inside == 0u && P.ground.w > 0.5 && rd.z < 0.0) {
    let tg = (P.gridOrigin.w - ro.z) / rd.z;
    if (tg > 0.0 && (!h.hit || tg < h.t)) {
      h.hit = true; h.t = tg; h.n = vec3f(0.0, 0.0, 1.0); h.id = GROUND_ID;
    }
  }
  return h;
}

// ---------- materials ----------
fn isClear(m: Material) -> bool {
  return m.b.w > 0.0 && (m.a.x == 2.0 || m.a.x == 4.0 || m.a.x == 5.0);
}

// Light absorbed per voxel of travel inside a transparent material (Beer's law).
// TODO(match): calibrate against MagicaVoxel's _d density.
fn absorption(m: Material) -> vec3f {
  if (m.c.y > 0.5) { return vec3f(0.0); } // media scatter instead (see the main loop)
  return (vec3f(1.0) - m.color.rgb) * m.c.x * 40.0;
}

fn isMedium(m: Material) -> bool { return m.c.y > 0.5; }
fn mediumSigma(m: Material) -> f32 { return max(m.c.x, 1e-4) * MEDIA_SCALE; }

// Light lost per voxel along a shadow ray inside a material (absorption or scattering out).
fn shadowExtinction(m: Material) -> vec3f {
  if (isMedium(m)) { return vec3f(mediumSigma(m)); }
  return absorption(m);
}

// ---------- fog and media ----------
fn phaseHG(cosT: f32, g: f32) -> f32 {
  let d = 1.0 + g * g - 2.0 * g * cosT;
  return (1.0 - g * g) / (4.0 * PI * pow(max(d, 1e-4), 1.5));
}

// New travel direction after scattering, around the current travel direction.
fn sampleHG(dir: vec3f, g: f32) -> vec3f {
  if (abs(g) < 1e-3) { return randomUnit(); }
  let s = (1.0 - g * g) / (1.0 - g + 2.0 * g * rand());
  let cosT = clamp((1.0 + g * g - s * s) / (2.0 * g), -1.0, 1.0);
  let sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
  let phi = 2.0 * PI * rand();
  return normalize(basis(dir) * vec3f(sinT * cos(phi), sinT * sin(phi), cosT));
}

// Fog fills the scene's box (a little wider than the voxels, down to the ground).
fn fogInterval(ro: vec3f, rd: vec3f) -> vec2f {
  let pad = vec3f(vec2f(P.dims.xy) * 0.25, 0.0);
  let lo = vec3f(P.gridOrigin.xy, min(P.gridOrigin.w, P.gridOrigin.z)) - pad;
  let hi = P.gridOrigin.xyz + vec3f(P.dims.xyz) + pad + vec3f(0.0, 0.0, f32(P.dims.z) * 0.25);
  let inv = safeInv(rd);
  let ta = (lo - ro) * inv; let tb = (hi - ro) * inv;
  let t0 = max(max(min(ta.x, tb.x), min(ta.y, tb.y)), max(min(ta.z, tb.z), 0.0));
  let t1 = min(min(max(ta.x, tb.x), max(ta.y, tb.y)), max(ta.z, tb.z));
  return vec2f(t0, t1);
}

fn fogTransmittance(ro: vec3f, rd: vec3f, tMax: f32) -> f32 {
  if (P.fog.w <= 0.0) { return 1.0; }
  let iv = fogInterval(ro, rd);
  let len = max(0.0, min(iv.y, tMax) - iv.x);
  return exp(-P.fog.w * len);
}

fn fresnel(cosi: f32, eta: f32) -> f32 {
  let r0 = (1.0 - eta) / (1.0 + eta);
  let f0 = r0 * r0;
  return f0 + (1.0 - f0) * pow(1.0 - clamp(cosi, 0.0, 1.0), 5.0);
}

// Reflect or refract at an interface. nf faces the incoming ray; eta = n_from / n_to.
// Returns the new direction in xyz and w = 1 when it went through.
fn dielectric(rd: vec3f, nf: vec3f, eta: f32, rough: f32) -> vec4f {
  let cosi = -dot(rd, nf);
  let refr = refract(rd, nf, eta);
  let tir = dot(refr, refr) < 1e-8;
  if (tir || rand() < fresnel(cosi, eta)) {
    var d = reflect(rd, nf);
    let g = normalize(d + randomUnit() * rough * rough);
    if (dot(g, nf) > 0.0) { d = g; }
    return vec4f(d, 0.0);
  }
  var d = normalize(refr);
  let g = normalize(d + randomUnit() * rough * rough);
  if (dot(g, nf) < 0.0) { d = g; }
  return vec4f(d, 1.0);
}

// ---------- sky ----------
fn envLookup(rd: vec3f) -> vec3f {
  let size = textureDimensions(envTex);
  let u = fract(atan2(rd.y, rd.x) / (2.0 * PI) + 0.5 + P.env.z / (2.0 * PI));
  let v = acos(clamp(rd.z, -1.0, 1.0)) / PI;
  let px = min(vec2u(vec2f(u, v) * vec2f(size)), size - vec2u(1u));
  return textureLoad(envTex, px, 0).rgb * P.env.y;
}

// Single-scattering sky: Rayleigh + Mie, thicker towards the horizon.
// TODO(match): MagicaVoxel's _atm model is not public; this is tuned by eye.
fn atmosphere(rd: vec3f) -> vec3f {
  let up = max(rd.z, 0.0);
  let depth = 1.0 / (up + 0.12);
  let mu = dot(rd, P.sunDir.xyz);
  let rayPhase = 0.0597 * (1.0 + mu * mu);
  let g = P.mie.w;
  let miePhase = 0.0796 * (1.0 - g * g) / pow(max(1e-4, 1.0 + g * g - 2.0 * g * mu), 1.5);
  let betaR = P.rayleigh.rgb;
  let betaM = P.mie.rgb * P.rayleigh.w;
  let beta = betaR + betaM;
  let ext = exp(-beta * depth);
  let scatter = (betaR * rayPhase + betaM * miePhase) / max(beta, vec3f(1e-4)) * (vec3f(1.0) - ext);
  let sun = max(P.sunColor.rgb, vec3f(0.05));
  // Below the horizon, fade to a dimmer version of the horizon colour.
  let below = smoothstep(0.0, -0.3, rd.z);
  return scatter * sun * 4.0 * P.env.w * mix(1.0, 0.35, below);
}

// ---------- sky importance sampling (HDR mode) ----------
fn envSampling() -> bool { return P.env.x > 1.5 && P.envSample.z == 1u; }

// Index of the first entry in [start, start+count] greater than u, minus one.
fn searchCdf(start: u32, count: u32, u: f32) -> u32 {
  var lo = 0u; var hi = count;
  while (lo < hi) {
    let mid = (lo + hi) / 2u;
    if (envTable[start + mid + 1u] <= u) { lo = mid + 1u; } else { hi = mid; }
  }
  return min(lo, count - 1u);
}

fn envDir(u: f32, v: f32) -> vec3f {
  let phi = (u - 0.5 - P.env.z / (2.0 * PI)) * 2.0 * PI;
  let theta = v * PI;
  return vec3f(sin(theta) * cos(phi), sin(theta) * sin(phi), cos(theta));
}

fn envPdf(rd: vec3f) -> f32 {
  let w = P.envSample.x; let h = P.envSample.y;
  let u = fract(atan2(rd.y, rd.x) / (2.0 * PI) + 0.5 + P.env.z / (2.0 * PI));
  let v = acos(clamp(rd.z, -1.0, 1.0)) / PI;
  let x = min(u32(u * f32(w)), w - 1u);
  let y = min(u32(v * f32(h)), h - 1u);
  let sinT = max(sin(v * PI), 1e-4);
  let p = envTable[(h + 1u) + h * (w + 1u) + y * w + x];
  return p / (2.0 * PI * PI * sinT);
}

// Returns a direction towards the sky in xyz and its probability density in w.
fn sampleEnv() -> vec4f {
  let w = P.envSample.x; let h = P.envSample.y;
  let y = searchCdf(0u, h, rand());
  let x = searchCdf((h + 1u) + y * (w + 1u), w, rand());
  let u = (f32(x) + rand()) / f32(w);
  let v = (f32(y) + rand()) / f32(h);
  let d = envDir(u, v);
  return vec4f(d, envPdf(d));
}

fn skyRadiance(rd: vec3f) -> vec3f {
  let mode = P.env.x;
  if (mode > 1.5) { return envLookup(rd); }
  if (mode > 0.5) { return atmosphere(rd); }
  return P.skyColor.rgb;
}

// What a camera ray sees when it misses everything.
fn backgroundRadiance(rd: vec3f) -> vec3f {
  if (P.bgColor.w > 0.5) { return P.bgColor.rgb; }
  var c = skyRadiance(rd);
  if (P.extra.z > 0.5 && dot(rd, P.sunDir.xyz) > P.sunDir.w) {
    c += P.sunColor.rgb / max(2.0 * PI * (1.0 - P.sunDir.w), 1e-4) * 0.05;
  }
  return c;
}

// Fraction of sunlight reaching p along l: solid voxels block it, clear ones tint it.
fn shadowTransmittance(p: vec3f, l: vec3f, startInside: u32) -> vec3f {
  var T = vec3f(1.0);
  var o = p;
  var inside = startInside;
  for (var i = 0; i < 12; i++) {
    let h = traceScene(o, l, inside);
    if (inside == 0u) { T *= fogTransmittance(o, l, select(BIG, h.t, h.hit)); }
    if (!h.hit) { return T; }
    if (h.id == GROUND_ID) { return vec3f(0.0); }
    if (inside != 0u) { T *= exp(-shadowExtinction(mats[inside]) * h.t); }
    if (h.id == 0u) {
      inside = 0u;
    } else {
      let m = mats[h.id];
      if (!isClear(m)) { return vec3f(0.0); }
      T *= m.b.w;
      inside = h.id;
    }
    if (max(T.r, max(T.g, T.b)) < 0.01) { return vec3f(0.0); }
    o = o + l * (h.t + EPS);
  }
  return T;
}



fn cameraRay(px: vec2f, ro: ptr<function, vec3f>, rd: ptr<function, vec3f>) {
  let size = vec2f(f32(P.misc.x), f32(P.misc.y));
  let ndc = vec2f((px.x / size.x) * 2.0 - 1.0, 1.0 - (px.y / size.y) * 2.0);
  let aspect = size.x / size.y;
  let fwd = P.camFwd.xyz; let right = P.camRight.xyz; let up = P.camUp.xyz;
  let k = P.camRight.w;
  if (P.camUp.w > 0.5) {
    *ro = P.camPos.xyz + right * (ndc.x * k * aspect) + up * (ndc.y * k);
    *rd = fwd;
    return;
  }
  var dir = normalize(fwd + right * (ndc.x * k * aspect) + up * (ndc.y * k));
  var origin = P.camPos.xyz;
  if (P.camPos.w > 0.0) {
    let focusPoint = origin + dir * (P.camFwd.w / dot(dir, fwd));
    let d = randomInDisk() * P.camPos.w;
    origin = origin + right * d.x + up * d.y;
    dir = normalize(focusPoint - origin);
  }
  *ro = origin; *rd = dir;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let w = P.misc.x; let hgt = P.misc.y;
  if (gid.x >= w || gid.y >= hgt) { return; }
  let pixel = gid.y * w + gid.x;
  rngState = pcg(pixel ^ pcg(P.dims.w * 9781u + P.misc.w));

  var ro: vec3f; var rd: vec3f;
  cameraRay(vec2f(gid.xy) + vec2f(rand(), rand()), &ro, &rd);

  var radiance = vec3f(0.0);
  var throughput = vec3f(1.0);
  var inside = 0u;          // id of the clear material or medium the ray is travelling through
  var cameraPath = true;    // still seeing directly through glass from the camera
  var lastDiffusePdf = 0.0; // pdf of the last bounce if it was diffuse (for MIS), else 0
  let maxBounces = P.misc.z;

  // Direct light is queued as one shadow ray and traced at the top of the next iteration,
  // so the whole shader has a single shadow-ray call site (keeps compile times short).
  var neePending = false;
  var neeValue = vec3f(0.0);
  var neeOrigin = vec3f(0.0);
  var neeDir = vec3f(0.0);
  var neeInside = 0u;
  var done = false;
  var bounce = 0u;

  loop {
    if (neePending) {
      radiance += neeValue * shadowTransmittance(neeOrigin, neeDir, neeInside);
      neePending = false;
    }
    if (done || bounce > maxBounces + 8u) { break; }
    bounce++;

    let h = traceScene(ro, rd, inside);
    if (inside != 0u) { throughput *= exp(-absorption(mats[inside]) * min(h.t, 64.0)); }

    // Scattering inside a medium (smoke, clouds, subsurface) or in the fog.
    var scatterT = BIG;
    var scatterColor = vec3f(1.0);
    var scatterG = 0.0;
    if (inside != 0u && isMedium(mats[inside])) {
      let m = mats[inside];
      let tf = -log(max(1.0 - rand(), 1e-7)) / mediumSigma(m);
      if (tf < h.t) { scatterT = tf; scatterColor = m.color.rgb; scatterG = m.c.z; }
    } else if (inside == 0u && P.fog.w > 0.0) {
      let iv = fogInterval(ro, rd);
      let tEnd = min(iv.y, select(BIG, h.t, h.hit));
      if (iv.x < tEnd) {
        let tf = iv.x - log(max(1.0 - rand(), 1e-7)) / P.fog.w;
        if (tf < tEnd) { scatterT = tf; scatterColor = P.fog.rgb; scatterG = P.extra.w; }
      }
    }
    if (scatterT < BIG) {
      if (bounce > maxBounces) { done = true; continue; }
      let p = ro + rd * scatterT;
      throughput *= scatterColor;
      if (P.sunColor.w > 0.5) {
        let l = sampleCone(P.sunDir.xyz, P.sunDir.w);
        neeValue = throughput * P.sunColor.rgb * phaseHG(dot(rd, l), scatterG);
        neeOrigin = p; neeDir = l; neeInside = inside; neePending = true;
      }
      ro = p;
      rd = sampleHG(rd, scatterG);
      cameraPath = false;
      lastDiffusePdf = 0.0;
      continue;
    }

    if (!h.hit) {
      var sky = select(skyRadiance(rd), backgroundRadiance(rd), cameraPath);
      // The sky was also sampled directly at the last diffuse bounce: combine the two (MIS).
      if (lastDiffusePdf > 0.0 && envSampling()) {
        let e = envPdf(rd);
        sky *= lastDiffusePdf * lastDiffusePdf / (lastDiffusePdf * lastDiffusePdf + e * e);
      }
      radiance += throughput * sky;
      done = true;
      continue;
    }
    let hp = ro + rd * h.t;

    // Leaving a medium: no surface, just carry on.
    if (inside != 0u && h.id == 0u && isMedium(mats[inside])) {
      inside = 0u;
      ro = hp - h.n * EPS;
      continue;
    }

    // Leaving a clear material into air.
    if (inside != 0u && h.id == 0u) {
      let m = mats[inside];
      let r = dielectric(rd, h.n, m.b.x, m.a.y);
      if (r.w > 0.5) { inside = 0u; ro = hp - h.n * EPS; } else { ro = hp + h.n * EPS; lastDiffusePdf = 0.0; }
      rd = r.xyz;
      continue;
    }

    // Ground seen from the camera fades into the background towards the horizon.
    if (h.id == GROUND_ID && cameraPath && P.extra.y > 0.0) {
      let r = P.extra.x;
      let fade = smoothstep(r, r * (1.0 + P.extra.y * 40.0), length(hp.xy - (P.gridOrigin.xy + vec2f(P.dims.xy) * 0.5)));
      if (rand() < fade) { radiance += throughput * backgroundRadiance(rd); done = true; continue; }
    }

    var m: Material;
    if (h.id == GROUND_ID) {
      m.color = vec4f(P.ground.rgb, 1.0); m.a = vec4f(0.0, 1.0, 0.0, 0.0); m.b = vec4f(1.5, 0.0, 0.0, 0.0); m.c = vec4f(0.0);
    } else {
      m = mats[h.id];
    }

    // Entering a medium: no surface, the ray continues inside and may scatter.
    if (h.id != GROUND_ID && h.id != inside && isMedium(m) && isClear(m) && rand() < m.b.w) {
      inside = h.id;
      ro = hp - h.n * EPS;
      continue;
    }

    // Entering a clear material (glass, or the see-through part of a blend).
    if (h.id != GROUND_ID && h.id != inside && isClear(m) && rand() < m.b.w) {
      let r = dielectric(rd, h.n, 1.0 / m.b.x, m.a.y);
      if (r.w > 0.5) { inside = h.id; ro = hp - h.n * EPS; } else { ro = hp + h.n * EPS; cameraPath = false; lastDiffusePdf = 0.0; }
      rd = r.xyz;
      continue;
    }

    let albedo = m.color.rgb;
    let mtype = m.a.x;
    if (mtype == 3.0 && m.a.w > 0.0) {
      // TODO(match): calibrate emission strength against MagicaVoxel (_emit, _flux, _ldr).
      radiance += throughput * albedo * m.a.w * exp2(m.b.y) * 0.5;
    }
    if (bounce > maxBounces) { done = true; continue; }
    cameraPath = false;
    let p = hp + h.n * EPS;

    // Blend materials have a glossy coat whose strength follows Fresnel and _sp.
    let coat = select(0.0, fresnel(-dot(rd, h.n), 1.0 / m.b.x) * clamp(m.b.z, 0.0, 1.0), mtype == 4.0);
    if ((mtype == 1.0 || mtype == 4.0) && rand() < m.a.z) {
      let refl = reflect(rd, h.n);
      var dir = normalize(refl + randomUnit() * m.a.y * m.a.y);
      if (dot(dir, h.n) <= 0.0) { dir = refl; }
      throughput *= albedo;
      ro = p; rd = dir;
      lastDiffusePdf = 0.0;
    } else if (rand() < coat) {
      let refl = reflect(rd, h.n);
      var dir = normalize(refl + randomUnit() * m.a.y * m.a.y);
      if (dot(dir, h.n) <= 0.0) { dir = refl; }
      ro = p; rd = dir;
      lastDiffusePdf = 0.0;
    } else {
      // Direct light: the sun or the HDR sky (picked at random when both are on).
      let useSun = P.sunColor.w > 0.5;
      let useEnv = envSampling();
      var pickSun = useSun;
      var weight = 1.0;
      if (useSun && useEnv) { pickSun = rand() < 0.5; weight = 2.0; }
      if (pickSun) {
        let l = sampleCone(P.sunDir.xyz, P.sunDir.w);
        let ndl = dot(h.n, l);
        if (ndl > 0.0) {
          neeValue = throughput * albedo * (1.0 / PI) * P.sunColor.rgb * ndl * weight;
          neeOrigin = p; neeDir = l; neeInside = inside; neePending = true;
        }
      } else if (useEnv) {
        let s = sampleEnv();
        let ndl = dot(h.n, s.xyz);
        if (ndl > 0.0 && s.w > 0.0) {
          let bsdfPdf = ndl / PI;
          let mis = s.w * s.w / (s.w * s.w + bsdfPdf * bsdfPdf);
          neeValue = throughput * albedo * (1.0 / PI) * envLookup(s.xyz) * ndl / s.w * mis * weight;
          neeOrigin = p; neeDir = s.xyz; neeInside = inside; neePending = true;
        }
      }
      throughput *= albedo;
      ro = p; rd = cosineHemisphere(h.n);
      lastDiffusePdf = max(dot(rd, h.n), 0.0) / PI;
    }

    if (bounce >= 4u) {
      let q = clamp(max(throughput.r, max(throughput.g, throughput.b)), 0.05, 1.0);
      if (rand() > q) { done = true; continue; }
      throughput /= q;
    }
  }

  // Clamp rare fireflies so progressive frames settle quickly.
  radiance = min(radiance, vec3f(64.0));
  let prev = select(vec4f(0.0), accum[pixel], P.dims.w > 0u);
  accum[pixel] = prev + vec4f(radiance, 1.0);
}
`;
