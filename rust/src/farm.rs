//! Magic Prism render farm client: the same protocol as tools/worker.ts, but the GPU and the scene stay
//! loaded between frames, so only the first frame of a job pays for loading.

use crate::renderer::Renderer;
use crate::settings::Snapshot;
use crate::Session;
use serde_json::{json, Value};
use std::io::Read;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn read_all(r: ureq::Response) -> Result<Vec<u8>, String> {
    let mut buf = vec![];
    r.into_reader().take(1 << 30).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

fn host_name() -> String {
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok().map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "rust-worker".into())
}

pub fn run(base: &str, args: &[String]) -> Result<(), String> {
    let base = base.trim_end_matches('/');
    let once = args.iter().any(|a| a == "--once");
    let name = args.iter().position(|a| a == "--name").and_then(|i| args.get(i + 1)).cloned().unwrap_or_else(host_name);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let id = format!("rust-{:x}-{}", nanos, std::process::id());
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(10)).timeout_read(Duration::from_secs(600)).build();

    let mut renderer = Some(Renderer::new()?);
    println!("[worker {name}] GPU: {}; connected to {base}", renderer.as_ref().unwrap().adapter_name);
    let mut session: Option<(String, Session)> = None;

    loop {
        let work = match agent.post(&format!("{base}/api/work")).send_json(json!({ "worker": id, "name": name })) {
            Ok(r) if r.status() == 200 => Some(r.into_json::<Value>().map_err(|e| e.to_string())?),
            Ok(_) => None,
            Err(e) => {
                println!("[worker {name}] can't reach coordinator ({e}); retrying");
                std::thread::sleep(Duration::from_secs(5));
                continue;
            }
        };
        let Some(work) = work else {
            if once {
                return Ok(());
            }
            std::thread::sleep(Duration::from_secs(2));
            continue;
        };
        let job_id = work["jobId"].as_str().unwrap_or_default().to_string();
        let frame = work["frame"].as_i64().unwrap_or(0) as i32;
        let samples = work["samples"].as_u64().unwrap_or(64) as u32;
        let scale = work["scale"].as_f64().unwrap_or(1.0);

        let result = (|| -> Result<(), String> {
            if session.as_ref().map(|(j, _)| j != &job_id).unwrap_or(true) {
                let t = Instant::now();
                let job: Value = agent.get(&format!("{base}/api/jobs/{job_id}")).call().map_err(|e| e.to_string())?.into_json().map_err(|e| e.to_string())?;
                let scene = read_all(agent.get(&format!("{base}/api/jobs/{job_id}/scene")).call().map_err(|e| e.to_string())?)?;
                let hdr = if job["hasHdr"].as_bool().unwrap_or(false) {
                    Some(read_all(agent.get(&format!("{base}/api/jobs/{job_id}/hdr")).call().map_err(|e| e.to_string())?)?)
                } else {
                    None
                };
                let mut snap = Snapshot(job["settings"].as_object().cloned().unwrap_or_default());
                snap.set("out.previewScale", json!(scale));
                // Reuse the GPU device from the previous job.
                let r = match session.take() {
                    Some((_, s)) => s.renderer,
                    None => renderer.take().ok_or("GPU renderer unavailable")?,
                };
                let s = Session::new(r, &scene, snap, hdr.as_deref(), frame)?;
                println!(
                    "[worker {name}] job {}: {}×{}, {} voxels, loaded in {:.1}s",
                    job["name"].as_str().unwrap_or("?"), s.renderer.width, s.renderer.height, s.baker.grid.voxel_count, t.elapsed().as_secs_f64()
                );
                session = Some((job_id.clone(), s));
            }
            let (_, s) = session.as_mut().unwrap();
            let t = Instant::now();
            let png = s.render_frame(frame, samples)?;
            let r = agent
                .put(&format!("{base}/api/jobs/{job_id}/frames/{frame}?worker={id}"))
                .set("Content-Type", "image/png")
                .send_bytes(&png)
                .map_err(|e| format!("upload failed: {e}"))?;
            if r.status() >= 300 {
                return Err(format!("upload failed: HTTP {}", r.status()));
            }
            println!("[worker {name}] frame {frame} in {:.2}s", t.elapsed().as_secs_f64());
            Ok(())
        })();

        if let Err(e) = result {
            println!("[worker {name}] frame {frame} failed: {e}");
            let _ = agent.post(&format!("{base}/api/jobs/{job_id}/frames/{frame}/fail?worker={id}")).call();
            // Keep the GPU device but drop the job so it's reloaded next time.
            if let Some((_, s)) = session.take() {
                renderer = Some(s.renderer);
            }
            if renderer.is_none() {
                renderer = Some(Renderer::new()?);
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    }
}
