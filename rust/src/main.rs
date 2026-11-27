//! Magic Mirror native worker.
//!
//!   mm-worker http://192.168.1.20:8080 [--name office-pc] [--once]
//!       Join a render farm: take frames from the coordinator, render, send PNGs back.
//!
//!   mm-worker render scene.vox out.png --settings snapshot.json [--frame N | --frames A-B]
//!             [--samples N] [--hdr sky.hdr] [--set key=value ...]
//!       Render frames locally. `snapshot.json` is the app's settings (Render farm panel →
//!       "Save settings"). With --frames, `####` in the output name becomes the frame number.

mod farm;
mod hdr;
mod materials;
mod renderer;
mod scene;
mod settings;
mod vox;

use renderer::{encode_png, Renderer};
use scene::SceneBaker;
use serde_json::Value;
use settings::Snapshot;
use std::time::Instant;

/// Everything needed to render frames of one scene with one set of settings.
pub struct Session {
    pub renderer: Renderer,
    pub baker: SceneBaker,
    pub settings: Snapshot,
}

impl Session {
    pub fn new(renderer: Renderer, vox_bytes: &[u8], settings: Snapshot, hdr: Option<&[u8]>, first_frame: i32) -> Result<Self, String> {
        let file = vox::parse(vox_bytes)?;
        let baker = SceneBaker::new(file, first_frame)?;
        let mut r = renderer;
        if let Some(h) = hdr {
            r.set_environment(&hdr::load_environment(h)?);
        }
        r.set_scene(&baker.grid, &materials::build_material_table(&baker.file))?;
        let (w, h) = settings::output_size(&settings);
        r.resize(w, h);
        Ok(Session { renderer: r, baker, settings })
    }

    /// Render one frame to PNG bytes.
    pub fn render_frame(&mut self, frame: i32, samples: u32) -> Result<Vec<u8>, String> {
        let boxes = self.baker.set_time(frame);
        self.renderer.update_regions(&self.baker.grid, &boxes);
        self.renderer.samples = 0;
        let f = settings::frame(&self.settings, self.baker.grid.origin[2] as f64);
        let mut done = 0;
        while done < samples {
            let n = (samples - done).min(8);
            self.renderer.trace(&f, n);
            self.renderer.wait();
            done += n;
        }
        let px = self.renderer.read_pixels(&settings::post(&self.settings));
        encode_png(self.renderer.width, self.renderer.height, &px)
    }
}

fn parse_value(v: &str) -> Value {
    if let Ok(n) = v.parse::<f64>() {
        return serde_json::json!(n);
    }
    if v == "true" || v == "false" {
        return Value::Bool(v == "true");
    }
    if v.contains(',') {
        let parts: Option<Vec<f64>> = v.split(',').map(|p| p.trim().parse().ok()).collect();
        if let Some(p) = parts {
            return serde_json::json!(p);
        }
    }
    Value::String(v.to_string())
}

fn render_cmd(args: &[String]) -> Result<(), String> {
    let mut pos = vec![];
    let (mut samples, mut frame, mut frames) = (128u32, 0i32, None::<(i32, i32)>);
    let (mut settings_path, mut hdr_path) = (None::<String>, None::<String>);
    let mut sets = vec![];
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        let mut next = || {
            i += 1;
            args.get(i).cloned().ok_or(format!("{a} needs a value"))
        };
        match a.as_str() {
            "--samples" => samples = next()?.parse().map_err(|_| "bad --samples")?,
            "--frame" => frame = next()?.parse().map_err(|_| "bad --frame")?,
            "--frames" => {
                let v = next()?;
                let (x, y) = v.split_once('-').unwrap_or((&v, &v));
                frames = Some((x.parse().map_err(|_| "bad --frames")?, y.parse().map_err(|_| "bad --frames")?));
            }
            "--settings" => settings_path = Some(next()?),
            "--hdr" => hdr_path = Some(next()?),
            "--set" => sets.push(next()?),
            _ => pos.push(a.clone()),
        }
        i += 1;
    }
    if pos.len() < 2 {
        return Err("usage: mm-worker render <scene.vox> <out.png> --settings snapshot.json [--frame N | --frames A-B] [--samples N] [--hdr sky.hdr] [--set key=value]".into());
    }
    let mut snap = match &settings_path {
        Some(p) => {
            let text = std::fs::read_to_string(p).map_err(|e| format!("{p}: {e}"))?;
            match serde_json::from_str::<Value>(&text).map_err(|e| format!("{p}: {e}"))? {
                Value::Object(m) => Snapshot(m),
                _ => return Err(format!("{p}: expected a JSON object")),
            }
        }
        None => Snapshot(Default::default()),
    };
    // Like the Node renderer: an HDR on the command line switches the sky to it unless --set says otherwise.
    if hdr_path.is_some() && !sets.iter().any(|s| s.starts_with("sky.mode=")) {
        snap.set("sky.mode", Value::String("hdr".into()));
    }
    for s in &sets {
        let (k, v) = s.split_once('=').ok_or(format!("--set {s}: expected key=value"))?;
        snap.set(k, parse_value(v));
    }
    let vox_bytes = std::fs::read(&pos[0]).map_err(|e| format!("{}: {e}", pos[0]))?;
    let hdr_bytes = hdr_path.as_ref().map(std::fs::read).transpose().map_err(|e| e.to_string())?;
    let (first, last) = frames.unwrap_or((frame, frame));
    let t0 = Instant::now();
    let renderer = Renderer::new()?;
    eprintln!("GPU: {}", renderer.adapter_name);
    let mut session = Session::new(renderer, &vox_bytes, snap, hdr_bytes.as_deref(), first)?;
    eprintln!("loaded in {:.2}s: {}×{}, {} voxels", t0.elapsed().as_secs_f64(), session.renderer.width, session.renderer.height, session.baker.grid.voxel_count);
    for f in first..=last {
        let t = Instant::now();
        let png = session.render_frame(f, samples)?;
        let out = if frames.is_some() {
            let n = format!("{f:04}");
            if pos[1].contains("####") { pos[1].replace("####", &n) } else { pos[1].trim_end_matches(".png").to_string() + "_" + &n + ".png" }
        } else {
            pos[1].clone()
        };
        if let Some(dir) = std::path::Path::new(&out).parent() {
            if !dir.as_os_str().is_empty() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
        }
        std::fs::write(&out, png).map_err(|e| format!("{out}: {e}"))?;
        println!("{out}: {} samples in {:.2}s", samples, t.elapsed().as_secs_f64());
    }
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(|s| s.as_str()) {
        Some("render") => render_cmd(&args[1..]),
        Some(url) if url.starts_with("http://") || url.starts_with("https://") => farm::run(url, &args[1..]),
        _ => Err("usage:\n  mm-worker <coordinator-url> [--name NAME] [--once]\n  mm-worker render <scene.vox> <out.png> --settings snapshot.json [options]".into()),
    };
    if let Err(e) = result {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
