//! Radiance .hdr reader and sky sampling tables (mirrors src/render/hdr.ts).

pub struct HdrImage {
    pub width: usize,
    pub height: usize,
    pub rgb: Vec<f32>,
}

pub fn parse(bytes: &[u8]) -> Result<HdrImage, String> {
    let mut pos = 0;
    let mut line = || {
        let start = pos;
        while pos < bytes.len() && bytes[pos] != b'\n' {
            pos += 1;
        }
        let s = String::from_utf8_lossy(&bytes[start..pos]).into_owned();
        pos += 1;
        s
    };
    if !line().starts_with("#?") {
        return Err("not a Radiance .hdr file".into());
    }
    loop {
        let l = line();
        if l.is_empty() {
            break;
        }
        if let Some(f) = l.strip_prefix("FORMAT=") {
            if f != "32-bit_rle_rgbe" {
                return Err(format!("unsupported .hdr format {f}"));
            }
        }
    }
    let res = line();
    let parts: Vec<&str> = res.split_whitespace().collect();
    if parts.len() != 4 || parts[0] != "-Y" || parts[2] != "+X" {
        return Err(format!("unsupported .hdr orientation \"{res}\""));
    }
    let height: usize = parts[1].parse().map_err(|_| "bad height")?;
    let width: usize = parts[3].parse().map_err(|_| "bad width")?;
    let mut rgbe = vec![0u8; width * height * 4];
    let mut scan = vec![0u8; width * 4];
    let get = |i: usize| bytes.get(i).copied().ok_or_else(|| "truncated .hdr".to_string());
    for y in 0..height {
        let rle = (8..32768).contains(&width) && get(pos)? == 2 && get(pos + 1)? == 2 && get(pos + 2)? & 0x80 == 0;
        if !rle {
            let n = width * 4;
            if pos + n > bytes.len() {
                return Err("truncated .hdr".into());
            }
            rgbe[y * n..(y + 1) * n].copy_from_slice(&bytes[pos..pos + n]);
            pos += n;
            continue;
        }
        if ((get(pos + 2)? as usize) << 8 | get(pos + 3)? as usize) != width {
            return Err("bad .hdr scanline width".into());
        }
        pos += 4;
        for c in 0..4 {
            let mut x = 0;
            while x < width {
                let mut n = get(pos)? as usize;
                pos += 1;
                if n > 128 {
                    n -= 128;
                    let v = get(pos)?;
                    pos += 1;
                    for _ in 0..n.min(width - x) {
                        scan[x * 4 + c] = v;
                        x += 1;
                    }
                } else {
                    for _ in 0..n.min(width - x) {
                        scan[x * 4 + c] = get(pos)?;
                        pos += 1;
                        x += 1;
                    }
                }
            }
        }
        rgbe[y * width * 4..(y + 1) * width * 4].copy_from_slice(&scan);
    }
    let mut rgb = vec![0f32; width * height * 3];
    for i in 0..width * height {
        let e = rgbe[i * 4 + 3];
        let f = if e == 0 { 0.0 } else { 2f32.powi(e as i32 - 136) };
        for c in 0..3 {
            rgb[i * 3 + c] = rgbe[i * 4 + c] as f32 * f;
        }
    }
    Ok(HdrImage { width, height, rgb })
}

pub fn downsample(img: &HdrImage, max_width: usize) -> HdrImage {
    let k = img.width.div_ceil(max_width);
    if k <= 1 {
        return HdrImage { width: img.width, height: img.height, rgb: img.rgb.clone() };
    }
    let (w, h) = (img.width / k, img.height / k);
    let mut rgb = vec![0f32; w * h * 3];
    for y in 0..h {
        for x in 0..w {
            for c in 0..3 {
                let mut sum = 0.0;
                for j in 0..k {
                    for i in 0..k {
                        sum += img.rgb[((y * k + j) * img.width + (x * k + i)) * 3 + c];
                    }
                }
                rgb[(y * w + x) * 3 + c] = sum / (k * k) as f32;
            }
        }
    }
    HdrImage { width: w, height: h, rgb }
}

/// Importance-sampling tables, same layout as the TypeScript version.
pub fn sampling_table(img: &HdrImage, max_width: usize) -> (usize, usize, Vec<f32>) {
    let s = downsample(img, max_width);
    let (w, h) = (s.width, s.height);
    let mut weight = vec![0f32; w * h];
    let mut total = 0f64;
    for y in 0..h {
        let sin_t = (((y as f64 + 0.5) / h as f64) * std::f64::consts::PI).sin() as f32;
        for x in 0..w {
            let i = y * w + x;
            let lum = 0.2126 * s.rgb[i * 3] + 0.7152 * s.rgb[i * 3 + 1] + 0.0722 * s.rgb[i * 3 + 2];
            weight[i] = lum.max(1e-6) * sin_t;
            total += weight[i] as f64;
        }
    }
    let cond = h + 1;
    let pdf = h + 1 + h * (w + 1);
    let mut table = vec![0f32; pdf + w * h];
    let mut acc = 0f64;
    for y in 0..h {
        let row_sum: f64 = (0..w).map(|x| weight[y * w + x] as f64).sum();
        let mut r = 0f64;
        for x in 0..w {
            r += weight[y * w + x] as f64;
            table[cond + y * (w + 1) + x + 1] = if row_sum > 0.0 { (r / row_sum) as f32 } else { (x + 1) as f32 / w as f32 };
        }
        acc += row_sum;
        table[y + 1] = (acc / total) as f32;
    }
    for i in 0..w * h {
        table[pdf + i] = (weight[i] as f64 / total * (w * h) as f64) as f32;
    }
    (w, h, table)
}

pub struct Environment {
    pub width: u32,
    pub height: u32,
    /// RGBA half floats.
    pub data: Vec<u16>,
    pub sample_w: u32,
    pub sample_h: u32,
    pub table: Vec<f32>,
}

pub fn load_environment(bytes: &[u8]) -> Result<Environment, String> {
    let img = downsample(&parse(bytes)?, 2048);
    let mut data = vec![0u16; img.width * img.height * 4];
    for i in 0..img.width * img.height {
        for c in 0..3 {
            data[i * 4 + c] = half::f16::from_f32(img.rgb[i * 3 + c].min(65000.0)).to_bits();
        }
        data[i * 4 + 3] = half::f16::from_f32(1.0).to_bits();
    }
    let (sw, sh, table) = sampling_table(&img, 256);
    Ok(Environment { width: img.width as u32, height: img.height as u32, data, sample_w: sw as u32, sample_h: sh as u32, table })
}
