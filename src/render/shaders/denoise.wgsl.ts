// Denoiser: an edge-avoiding à-trous wavelet filter guided by what each pixel's camera ray
// first hit (albedo, normal, depth), in the spirit of SVGF without the temporal part.
//
//   prep    radiance ÷ albedo → "illumination" (so voxel colours stay crisp) + its noise variance
//   atrous  ×5, step 1, 2, 4, 8, 16: a 5×5 blur whose weights drop across normal, depth and
//           brightness edges; brightness edges count less where the pixel is noisier
//   finish  × albedo again
//
// The variance comes from the samples themselves, so the filter fades out as a frame converges.

export const DENOISE_WGSL = /* wgsl */ `
struct D {
  size: vec2u,
  samples: f32,
  step: f32,       // à-trous step in pixels
  strength: f32,   // multiplies the brightness tolerance
  pad0: f32, pad1: f32, pad2: f32,
};
@group(0) @binding(0) var<uniform> U: D;
@group(0) @binding(1) var<storage, read> accum: array<vec4f>;
@group(0) @binding(2) var<storage, read> feat: array<vec4f>;      // per pixel: [albedo, depth], [normal, Σ lum²]
@group(0) @binding(3) var<storage, read> src: array<vec4f>;       // illumination + variance
@group(0) @binding(4) var<storage, read_write> dst: array<vec4f>;

fn lum(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn idx(p: vec2i) -> u32 { return u32(p.y) * U.size.x + u32(p.x); }
fn inside(p: vec2i) -> bool { return p.x >= 0 && p.y >= 0 && p.x < i32(U.size.x) && p.y < i32(U.size.y); }
fn n_inv() -> f32 { return 1.0 / max(U.samples, 1.0); }
fn albedoAt(i: u32) -> vec3f { return max(feat[2u * i].rgb * n_inv(), vec3f(0.02)); }
fn depthAt(i: u32) -> f32 { return feat[2u * i].w * n_inv(); }
fn normalAt(i: u32) -> vec3f { return feat[2u * i + 1u].xyz * n_inv(); }
fn illumAt(i: u32) -> vec3f { return accum[i].rgb * n_inv() / albedoAt(i); }

@compute @workgroup_size(8, 8)
fn prep(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= U.size.x || gid.y >= U.size.y) { return; }
  let p = vec2i(gid.xy);
  let i = idx(p);
  let c = illumAt(i);
  // Variance of this pixel's mean, from its own samples...
  let m1 = lum(c);
  let m2 = feat[2u * i + 1u].w * n_inv();
  let temporal = max(m2 - m1 * m1, 0.0) * n_inv();
  // ...and, while there are few samples, from its neighbours on the same surface.
  var s1 = 0.0; var s2 = 0.0; var sw = 0.0;
  let n = normalAt(i);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let q = p + vec2i(x, y);
      if (!inside(q)) { continue; }
      let j = idx(q);
      let w = select(0.0, 1.0, dot(normalAt(j), n) > 0.5 || (x == 0 && y == 0));
      let l = lum(illumAt(j));
      s1 += l * w; s2 += l * l * w; sw += w;
    }
  }
  let mean = s1 / max(sw, 1.0);
  let spatial = max(s2 / max(sw, 1.0) - mean * mean, 0.0);
  let k = clamp((U.samples - 1.0) / 15.0, 0.0, 1.0);
  dst[i] = vec4f(c, mix(spatial, temporal, k));
}

@compute @workgroup_size(8, 8)
fn atrous(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= U.size.x || gid.y >= U.size.y) { return; }
  let p = vec2i(gid.xy);
  let i = idx(p);
  let cp = src[i];
  let np = normalAt(i);
  let zp = depthAt(i);
  let lp = lum(cp.rgb);
  let sky = dot(np, np) < 0.25;
  let tolL = U.strength * 4.0 * sqrt(max(cp.w, 0.0)) + 1e-4;
  let tolZ = max(zp, 1.0) * 0.02 * U.step + 0.5;
  let kern = array<f32, 3>(0.375, 0.25, 0.0625);
  var sum = vec3f(0.0);
  var vsum = 0.0;
  var wsum = 0.0;
  for (var y = -2; y <= 2; y++) {
    for (var x = -2; x <= 2; x++) {
      let q = p + vec2i(x, y) * i32(U.step);
      if (!inside(q)) { continue; }
      let j = idx(q);
      let cq = src[j];
      let nq = normalAt(j);
      var w = kern[abs(x)] * kern[abs(y)];
      if (x != 0 || y != 0) {
        let skyQ = dot(nq, nq) < 0.25;
        if (sky != skyQ) { continue; }
        if (!sky) { w *= pow(max(dot(np, nq), 0.0), 64.0); }
        w *= exp(-abs(zp - depthAt(j)) / tolZ);
        w *= exp(-abs(lp - lum(cq.rgb)) / tolL);
      }
      sum += cq.rgb * w;
      vsum += cq.w * w * w;
      wsum += w;
    }
  }
  dst[i] = vec4f(sum / wsum, vsum / (wsum * wsum));
}

@compute @workgroup_size(8, 8)
fn finish(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= U.size.x || gid.y >= U.size.y) { return; }
  let i = idx(vec2i(gid.xy));
  dst[i] = vec4f(src[i].rgb * albedoAt(i), 1.0);
}
`;
