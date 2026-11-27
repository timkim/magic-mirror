//! GPU material table (mirrors src/render/materials.ts): 256 materials × 16 floats.

use crate::vox::{Dict, VoxFile};

fn srgb_to_linear(c: u8) -> f32 {
    let v = c as f32 / 255.0;
    if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
}

fn num(d: Option<&Dict>, key: &str, fallback: f32) -> f32 {
    d.and_then(|d| d.get(key)).and_then(|v| v.trim().parse::<f32>().ok()).filter(|v| v.is_finite()).unwrap_or(fallback)
}

pub fn build_material_table(file: &VoxFile) -> Vec<f32> {
    let mut out = vec![0f32; 256 * 16];
    for i in 0..256 {
        let o = i * 16;
        let m = file.materials.get(&(i as i32));
        let c = file.palette[i];
        out[o] = srgb_to_linear(c[0]);
        out[o + 1] = srgb_to_linear(c[1]);
        out[o + 2] = srgb_to_linear(c[2]);
        out[o + 3] = c[3] as f32 / 255.0;
        let ty = match m.and_then(|d| d.get("_type")).map(|s| s.as_str()).unwrap_or("_diffuse") {
            "_metal" => 1,
            "_glass" => 2,
            "_emit" => 3,
            "_blend" => 4,
            "_media" | "_cloud" => 5,
            _ => 0,
        };
        out[o + 4] = ty as f32;
        out[o + 5] = num(m, "_rough", 0.1);
        out[o + 6] = if ty == 1 { num(m, "_metal", num(m, "_weight", 1.0)) } else { num(m, "_metal", 0.0) };
        out[o + 7] = if ty == 3 { num(m, "_emit", num(m, "_weight", 1.0)) } else { 0.0 };
        out[o + 8] = num(m, "_ri", num(m, "_ior", 0.3) + 1.0);
        out[o + 9] = num(m, "_flux", 0.0);
        out[o + 10] = num(m, "_sp", num(m, "_spec", 0.5));
        out[o + 11] = match ty {
            2 => num(m, "_trans", num(m, "_alpha", 1.0)),
            5 => 1.0,
            4 => num(m, "_trans", num(m, "_alpha", 0.0)),
            _ => 0.0,
        };
        out[o + 12] = num(m, "_d", 0.0);
        let media_type = m.map(|d| d.contains_key("_media_type")).unwrap_or(false);
        out[o + 13] = if ty == 5 || (ty == 4 && media_type) { 1.0 } else { 0.0 };
        out[o + 14] = num(m, "_g", 0.0);
    }
    out
}
