//! Turns an app settings snapshot (JSON: key → value, as the app's Settings.snapshot()
//! produces) into renderer inputs. Mirrors src/render/params.ts; the maths is done in f64
//! like JavaScript so both renderers produce the same pixels.

use serde_json::{Map, Value};

pub type Vec3 = [f64; 3];

pub struct Snapshot(pub Map<String, Value>);

impl Snapshot {
    pub fn num(&self, k: &str, d: f64) -> f64 {
        self.0.get(k).and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).unwrap_or(d)
    }
    pub fn boolean(&self, k: &str, d: bool) -> bool {
        self.0.get(k).and_then(|v| v.as_bool()).unwrap_or(d)
    }
    pub fn string(&self, k: &str, d: &str) -> String {
        self.0.get(k).and_then(|v| v.as_str()).unwrap_or(d).to_string()
    }
    pub fn vec(&self, k: &str, d: Vec3) -> Vec3 {
        match self.0.get(k).and_then(|v| v.as_array()) {
            Some(a) if a.len() >= 3 => [0, 1, 2].map(|i| a[i].as_f64().unwrap_or(d[i])),
            _ => d,
        }
    }
    pub fn set(&mut self, k: &str, v: Value) {
        self.0.insert(k.to_string(), v);
    }
}

pub struct Camera {
    pub position: Vec3,
    pub forward: Vec3,
    pub right: Vec3,
    pub up: Vec3,
    pub scale: f64,
    pub orthographic: bool,
    pub aperture: f64,
    pub focus_distance: f64,
}

pub struct Lighting {
    pub sun_direction: Vec3,
    pub sun_cos_radius: f64,
    pub sun_color: Vec3,
    pub sun_enabled: bool,
    pub sun_disk: bool,
    pub sky_mode: u32, // 0 uniform, 1 atmosphere, 2 hdr
    pub sky_color: Vec3,
    pub rayleigh: Vec3,
    pub mie_color: Vec3,
    pub mie_density: f64,
    pub mie_g: f64,
    pub atmosphere_intensity: f64,
    pub hdr_intensity: f64,
    pub hdr_rotation: f64,
    pub background: Option<Vec3>,
    pub ground: Option<Vec3>,
    pub horizon_fade: f64,
    pub fog_color: Vec3,
    pub fog_density: f64,
    pub fog_g: f64,
    pub ground_height: f64,
}

pub struct Frame {
    pub camera: Camera,
    pub lighting: Lighting,
    pub max_bounces: u32,
}

pub struct Post {
    pub exposure: f64,
    pub tonemap: u32,
    pub gamma: f64,
    pub vignette: f64,
    pub bloom_mix: f64,
    pub bloom_scale: f64,
    pub bloom_aspect: f64,
    pub bloom_threshold: f64,
    /// Denoiser strength; 0 = off.
    pub denoise: f64,
}

fn rad(d: f64) -> f64 {
    d * std::f64::consts::PI / 180.0
}
fn norm(v: Vec3) -> Vec3 {
    let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    let l = if l == 0.0 { 1.0 } else { l };
    [v[0] / l, v[1] / l, v[2] / l]
}
fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn scale(v: Vec3, k: f64) -> Vec3 {
    [v[0] * k, v[1] * k, v[2] * k]
}
pub fn orbit_direction(yaw: f64, pitch: f64) -> Vec3 {
    let (y, p) = (rad(yaw), rad(pitch));
    [p.cos() * y.cos(), p.cos() * y.sin(), p.sin()]
}

pub fn frame(s: &Snapshot, ground_height: f64) -> Frame {
    let target = s.vec("cam.target", [0.0; 3]);
    let dist = s.num("cam.distance", 100.0);
    let back = orbit_direction(s.num("cam.yaw", -135.0), s.num("cam.pitch", 30.0));
    let position = [target[0] + back[0] * dist, target[1] + back[1] * dist, target[2] + back[2] * dist];
    let forward = scale(back, -1.0);
    let mut right = cross(forward, [0.0, 0.0, 1.0]);
    if right[0].hypot(right[1]).hypot(right[2]) < 1e-6 {
        right = [1.0, 0.0, 0.0];
    }
    let right = norm(right);
    let up = norm(cross(right, forward));
    let ortho = s.string("cam.projection", "pers") == "orth";
    let focus = s.num("cam.focus", 0.0);
    let bg = s.string("bg.mode", "color");
    let sky = match s.string("sky.mode", "atmosphere").as_str() {
        "uniform" => 0,
        "hdr" => 2,
        _ => 1,
    };
    Frame {
        camera: Camera {
            position,
            forward,
            right,
            up,
            scale: if ortho { s.num("cam.orthoSize", 100.0) / 2.0 } else { (rad(s.num("cam.fov", 45.0)) / 2.0).tan() },
            orthographic: ortho,
            aperture: s.num("cam.aperture", 0.0),
            focus_distance: if focus > 0.0 { focus } else { dist },
        },
        lighting: Lighting {
            sun_direction: orbit_direction(s.num("sun.yaw", 50.0), s.num("sun.pitch", 50.0)),
            sun_cos_radius: (rad(s.num("sun.size", 3.0).max(0.01)) / 2.0).cos(),
            sun_color: scale(s.vec("sun.color", [1.0; 3]), s.num("sun.intensity", 0.7) * std::f64::consts::PI),
            sun_enabled: s.boolean("sun.enabled", true),
            sun_disk: s.boolean("sun.disk", false),
            sky_mode: sky,
            sky_color: scale(s.vec("sky.color", [1.0; 3]), s.num("sky.intensity", 0.6)),
            rayleigh: scale(s.vec("atm.rayleighColor", [0.24, 0.45, 1.0]), s.num("atm.rayleighDensity", 0.2)),
            mie_color: s.vec("atm.mieColor", [1.0; 3]),
            mie_density: s.num("atm.mieDensity", 0.3),
            mie_g: s.num("atm.mieG", 0.8),
            atmosphere_intensity: s.num("atm.intensity", 1.0),
            hdr_intensity: s.num("hdr.intensity", 1.0),
            hdr_rotation: rad(s.num("hdr.rotation", 0.0)),
            background: if bg == "color" { Some(s.vec("bg.color", [0.55; 3])) } else { None },
            ground: if s.boolean("ground.enabled", true) { Some(s.vec("ground.color", [0.8; 3])) } else { None },
            horizon_fade: s.num("ground.horizon", 0.0),
            fog_color: s.vec("fog.color", [1.0; 3]),
            fog_density: s.num("fog.density", 0.0) * 0.05,
            fog_g: s.num("fog.g", 0.0),
            ground_height,
        },
        max_bounces: s.num("rt.bounces", 6.0) as u32,
    }
}

pub fn post(s: &Snapshot) -> Post {
    Post {
        exposure: 2f64.powf(s.num("post.exposure", 0.0)),
        tonemap: match s.string("post.tonemap", "aces").as_str() {
            "none" => 0,
            "reinhard" => 2,
            _ => 1,
        },
        gamma: s.num("post.gamma", 2.2),
        vignette: s.num("post.vignette", 0.0),
        bloom_mix: s.num("bloom.mix", 0.0),
        bloom_scale: s.num("bloom.scale", 0.4),
        bloom_aspect: s.num("bloom.aspect", 0.5),
        bloom_threshold: s.num("bloom.threshold", 0.0),
        denoise: if s.boolean("dn.enabled", true) { s.num("dn.strength", 1.0) } else { 0.0 },
    }
}

/// Output size for the resolution preset (the "viewport" preset falls back to 1920×1080).
pub fn output_size(s: &Snapshot) -> (u32, u32) {
    let preset = s.string("out.resolution", "1080x1920");
    let base = preset
        .split_once('x')
        .and_then(|(a, b)| Some((a.parse::<f64>().ok()?, b.parse::<f64>().ok()?)))
        .unwrap_or((1920.0, 1080.0));
    let k = s.num("out.previewScale", 0.5);
    let r = |v: f64| ((v * k + 0.5).floor()).max(1.0) as u32; // Math.round
    (r(base.0), r(base.1))
}

/// Camera keyframes (the `cam.keys` setting, JSON). Mirrors src/anim/camera.ts: holds before
/// the first and after the last key; between keys position and angles interpolate linearly (or
/// smoothstep when the earlier key's ease is "smooth", the default), distance and ortho size
/// geometrically. Writes the result into the camera settings for `frame`.
pub fn apply_camera_keys(s: &mut Snapshot, frame: f64) {
    let keys: Vec<Value> = match s.0.get("cam.keys").and_then(|v| v.as_str()).and_then(|t| serde_json::from_str::<Value>(t).ok()) {
        Some(Value::Array(a)) => a,
        _ => return,
    };
    let mut keys: Vec<&Value> = keys.iter().filter(|k| k.get("frame").and_then(|f| f.as_f64()).is_some()).collect();
    if keys.is_empty() {
        return;
    }
    keys.sort_by(|a, b| a["frame"].as_f64().unwrap().partial_cmp(&b["frame"].as_f64().unwrap()).unwrap());
    let fr = |k: &Value| k["frame"].as_f64().unwrap();
    let (mut a, mut b) = (keys[0], keys[0]);
    if frame <= fr(keys[0]) {
    } else if frame >= fr(keys[keys.len() - 1]) {
        a = keys[keys.len() - 1];
        b = a;
    } else {
        for i in 0..keys.len() - 1 {
            if frame >= fr(keys[i]) && frame < fr(keys[i + 1]) {
                a = keys[i];
                b = keys[i + 1];
                break;
            }
        }
    }
    let mut t = if std::ptr::eq(a, b) { 0.0 } else { (frame - fr(a)) / (fr(b) - fr(a)) };
    if a.get("ease").and_then(|e| e.as_str()).unwrap_or("smooth") == "smooth" {
        t = t * t * (3.0 - 2.0 * t);
    }
    let n = |k: &Value, f: &str| k.get(f).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let lerp = |x: f64, y: f64| x + (y - x) * t;
    let glerp = |x: f64, y: f64| (x.max(1e-3).ln() + (y.max(1e-3).ln() - x.max(1e-3).ln()) * t).exp();
    let tv = |k: &Value, i: usize| k.get("target").and_then(|v| v.get(i)).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let target: Vec<f64> = (0..3).map(|i| lerp(tv(a, i), tv(b, i))).collect();
    let yaw = lerp(n(a, "yaw"), n(b, "yaw"));
    let wrapped = (((yaw + 180.0) % 360.0) + 360.0) % 360.0 - 180.0;
    s.set("cam.target", serde_json::json!(target));
    s.set("cam.yaw", serde_json::json!(wrapped));
    s.set("cam.pitch", serde_json::json!(lerp(n(a, "pitch"), n(b, "pitch"))));
    s.set("cam.distance", serde_json::json!(glerp(n(a, "distance"), n(b, "distance"))));
    s.set("cam.fov", serde_json::json!(lerp(n(a, "fov"), n(b, "fov"))));
    s.set("cam.orthoSize", serde_json::json!(glerp(n(a, "orthoSize"), n(b, "orthoSize"))));
}
