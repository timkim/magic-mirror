// Progressive voxel path tracer. One sample per pixel per dispatch, summed into `accum`.
// Acceleration: a coarse 8×8×8 "brick" occupancy grid lets rays skip empty space,
// then a fine DDA walks the voxels inside occupied bricks.

export const PATHTRACE_WGSL = /* wgsl */ `
struct Params {
  camPos: vec4f,      // w: aperture radius (0 = pinhole)
  camFwd: vec4f,      // w: focus distance
  camRight: vec4f,    // w: tan(fov/2) for perspective, half-height for orthographic
  camUp: vec4f,       // w: 0 perspective, 1 orthographic
  sunDir: vec4f,      // direction towards the sun; w: cos(angular radius)
  sunColor: vec4f,    // rgb irradiance; w: 1 enabled
  skyColor: vec4f,    // rgb radiance
  bgColor: vec4f,     // rgb; w: 1 = camera rays that miss show this instead of the sky
  ground: vec4f,      // rgb albedo; w: 1 enabled
  gridOrigin: vec4f,  // world position of voxel (0,0,0); w: ground height (world z)
  dims: vec4u,        // grid size; w: sample index
  misc: vec4u,        // x width, y height, z max bounces, w seed
};

struct Material {
  color: vec4f,  // linear rgb, a = alpha
  a: vec4f,      // x type (0 diffuse, 1 metal, 2 glass, 3 emit, 4 blend, 5 media), y rough, z metal, w emit
  b: vec4f,      // x ior, y flux, z spec, w reserved
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var voxels: texture_3d<u32>;
@group(0) @binding(2) var bricks: texture_3d<u32>;
@group(0) @binding(3) var<storage, read> mats: array<Material, 256>;
@group(0) @binding(4) var<storage, read_write> accum: array<vec4f>;

const PI = 3.14159265359;
const BRICK = 8;
const GROUND_ID = 256u;
const BIG = 1e30;

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
struct Hit { t: f32, n: vec3f, id: u32, hit: bool };

fn safeInv(d: vec3f) -> vec3f {
  return 1.0 / select(d, vec3f(1e-9), abs(d) < vec3f(1e-9));
}

fn traceBrick(ro: vec3f, rd: vec3f, inv: vec3f, bcell: vec3i, tStart: f32, tEnd: f32, n0: vec3f) -> Hit {
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
    if (id != 0u) { h.hit = true; h.t = t; h.n = n; h.id = id; return h; }
    if (tNext.x < tNext.y && tNext.x < tNext.z) { v.x += st.x; t = tNext.x; tNext.x += tDelta.x; n = vec3f(-stepf.x, 0.0, 0.0); }
    else if (tNext.y < tNext.z) { v.y += st.y; t = tNext.y; tNext.y += tDelta.y; n = vec3f(0.0, -stepf.y, 0.0); }
    else { v.z += st.z; t = tNext.z; tNext.z += tDelta.z; n = vec3f(0.0, 0.0, -stepf.z); }
  }
  return h;
}

// ro is in grid space (world minus gridOrigin).
fn traceGrid(ro: vec3f, rd: vec3f, tLimit: f32) -> Hit {
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
    if (textureLoad(bricks, cell, 0).r != 0u) {
      let r = traceBrick(ro, rd, safeInv(rd), cell, t, min(tCellExit, tExit), n);
      if (r.hit && r.t < tLimit) { return r; }
    }
    if (tNext.x < tNext.y && tNext.x < tNext.z) { cell.x += st.x; t = tNext.x; tNext.x += tDelta.x; n = vec3f(-stepf.x, 0.0, 0.0); }
    else if (tNext.y < tNext.z) { cell.y += st.y; t = tNext.y; tNext.y += tDelta.y; n = vec3f(0.0, -stepf.y, 0.0); }
    else { cell.z += st.z; t = tNext.z; tNext.z += tDelta.z; n = vec3f(0.0, 0.0, -stepf.z); }
  }
  return h;
}

// World-space scene query: voxels plus the optional ground plane.
fn traceScene(ro: vec3f, rd: vec3f) -> Hit {
  var h = traceGrid(ro - P.gridOrigin.xyz, rd, BIG);
  if (P.ground.w > 0.5 && rd.z < 0.0) {
    let tg = (P.gridOrigin.w - ro.z) / rd.z;
    if (tg > 0.0 && (!h.hit || tg < h.t)) {
      h.hit = true; h.t = tg; h.n = vec3f(0.0, 0.0, 1.0); h.id = GROUND_ID;
    }
  }
  return h;
}

fn occluded(ro: vec3f, rd: vec3f) -> bool {
  return traceScene(ro, rd).hit;
}

fn skyRadiance(rd: vec3f) -> vec3f {
  // Uniform sky. TODO(match): MagicaVoxel's atmosphere sky (_atm) and its sun disk glow.
  return P.skyColor.rgb;
}

fn sunLight(p: vec3f, n: vec3f) -> vec3f {
  if (P.sunColor.w < 0.5) { return vec3f(0.0); }
  let l = sampleCone(P.sunDir.xyz, P.sunDir.w);
  let ndl = dot(n, l);
  if (ndl <= 0.0) { return vec3f(0.0); }
  if (occluded(p, l)) { return vec3f(0.0); }
  return P.sunColor.rgb * ndl;
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
  let maxBounces = P.misc.z;

  for (var bounce = 0u; bounce <= maxBounces; bounce++) {
    let h = traceScene(ro, rd);
    if (!h.hit) {
      if (bounce == 0u && P.bgColor.w > 0.5) { radiance += throughput * P.bgColor.rgb; }
      else { radiance += throughput * skyRadiance(rd); }
      break;
    }
    let p = ro + rd * h.t + h.n * 1e-3;
    var albedo = P.ground.rgb;
    var mtype = 0.0; var rough = 1.0; var metal = 0.0; var emit = 0.0; var flux = 0.0;
    if (h.id != GROUND_ID) {
      let m = mats[h.id];
      albedo = m.color.rgb; mtype = m.a.x; rough = m.a.y; metal = m.a.z; emit = m.a.w; flux = m.b.y;
    }

    if (mtype == 3.0 && emit > 0.0) {
      // TODO(match): calibrate emission strength against MagicaVoxel (_emit, _flux, _ldr).
      radiance += throughput * albedo * emit * exp2(flux) * 4.0;
    }

    let isMetal = (mtype == 1.0 || mtype == 4.0) && rand() < metal;
    if (isMetal) {
      let refl = reflect(rd, h.n);
      var dir = normalize(refl + randomUnit() * rough * rough);
      if (dot(dir, h.n) <= 0.0) { dir = refl; }
      throughput *= albedo;
      ro = p; rd = dir;
    } else {
      // Diffuse (glass and media are treated as diffuse until they are implemented).
      radiance += throughput * albedo * (1.0 / PI) * sunLight(p, h.n);
      throughput *= albedo;
      ro = p; rd = cosineHemisphere(h.n);
    }

    if (bounce >= 3u) {
      let q = clamp(max(throughput.r, max(throughput.g, throughput.b)), 0.05, 1.0);
      if (rand() > q) { break; }
      throughput /= q;
    }
  }

  // Clamp rare fireflies so progressive frames settle quickly.
  radiance = min(radiance, vec3f(64.0));
  let prev = select(vec4f(0.0), accum[pixel], P.dims.w > 0u);
  accum[pixel] = prev + vec4f(radiance, 1.0);
}
`;
