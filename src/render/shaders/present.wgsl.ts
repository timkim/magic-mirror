// Turns the accumulated radiance into display pixels: average, exposure, tone map, sRGB.
// Post effects (bloom, vignette) slot in here.

export const PRESENT_WGSL = /* wgsl */ `
struct Post {
  size: vec2u,
  samples: f32,
  exposure: f32,   // linear multiplier (2^EV)
  tonemap: u32,    // 0 none, 1 ACES, 2 Reinhard
  gamma: f32,
  vignette: f32,
  pad: f32,
};
@group(0) @binding(0) var<uniform> post: Post;
@group(0) @binding(1) var<storage, read> accum: array<vec4f>;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

fn aces(x: vec3f) -> vec3f {
  // Narkowicz fit. TODO(match): compare with MagicaVoxel's tone curve.
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let px = vec2u(pos.xy);
  let i = min(px.y, post.size.y - 1u) * post.size.x + min(px.x, post.size.x - 1u);
  var c = accum[i].rgb / max(post.samples, 1.0) * post.exposure;
  if (post.vignette > 0.0) {
    let uv = pos.xy / vec2f(post.size) - 0.5;
    c *= mix(1.0, smoothstep(0.85, 0.2, length(uv)), post.vignette);
  }
  if (post.tonemap == 1u) { c = aces(c); }
  else if (post.tonemap == 2u) { c = c / (1.0 + c); }
  c = pow(clamp(c, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / post.gamma));
  return vec4f(c, 1.0);
}
`;
