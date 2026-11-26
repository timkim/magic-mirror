// Bloom: downsample the averaged image to quarter resolution (keeping only light above the
// threshold), then blur it horizontally and vertically. The present pass mixes it back in.

export const BLOOM_WGSL = /* wgsl */ `
struct Bloom {
  srcSize: vec2u,
  dstSize: vec2u,
  samples: f32,
  exposure: f32,
  threshold: f32,
  radius: f32,     // blur radius in quarter-res pixels for this pass
  dir: vec2f,      // (1,0) horizontal, (0,1) vertical
  pad: vec2f,
};
@group(0) @binding(0) var<uniform> B: Bloom;
@group(0) @binding(1) var<storage, read> accum: array<vec4f>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var src: texture_2d<f32>;

@compute @workgroup_size(8, 8)
fn prep(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= B.dstSize.x || gid.y >= B.dstSize.y) { return; }
  let scale = vec2f(B.srcSize) / vec2f(B.dstSize);
  let x0 = u32(f32(gid.x) * scale.x);
  let y0 = u32(f32(gid.y) * scale.y);
  let nx = max(1u, u32(ceil(scale.x)));
  let ny = max(1u, u32(ceil(scale.y)));
  var c = vec3f(0.0);
  var n = 0.0;
  for (var y = 0u; y < ny; y++) {
    for (var x = 0u; x < nx; x++) {
      let px = min(vec2u(x0 + x, y0 + y), B.srcSize - vec2u(1u));
      c += accum[px.y * B.srcSize.x + px.x].rgb;
      n += 1.0;
    }
  }
  c = c / (n * max(B.samples, 1.0)) * B.exposure;
  c = max(c - vec3f(B.threshold), vec3f(0.0));
  textureStore(dst, gid.xy, vec4f(min(c, vec3f(64.0)), 1.0));
}

@compute @workgroup_size(8, 8)
fn blur(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= B.dstSize.x || gid.y >= B.dstSize.y) { return; }
  let r = max(B.radius, 0.5);
  let taps = i32(min(ceil(r), 48.0));
  let sigma = max(r / 2.0, 0.5);
  var c = vec3f(0.0);
  var wsum = 0.0;
  for (var i = -taps; i <= taps; i++) {
    let p = clamp(vec2i(gid.xy) + vec2i(B.dir * f32(i)), vec2i(0), vec2i(B.dstSize) - vec2i(1));
    let w = exp(-f32(i * i) / (2.0 * sigma * sigma));
    c += textureLoad(src, p, 0).rgb * w;
    wsum += w;
  }
  textureStore(dst, gid.xy, vec4f(c / wsum, 1.0));
}
`;
