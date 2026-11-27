//! Scene graph evaluation and the animation-wide voxel grid (mirrors src/vox/scene.ts).

use crate::vox::{Node, Rot3, VoxFile, IDENTITY};

#[derive(Clone, PartialEq)]
pub struct Placed {
    pub model: usize,
    pub rotation: Rot3,
    pub translation: [i32; 3],
}

pub struct Grid {
    pub origin: [i32; 3],
    pub dims: [usize; 3],
    /// Palette index per cell, x fastest.
    pub cells: Vec<u8>,
    pub voxel_count: usize,
}

/// Inclusive box in grid cells.
#[derive(Clone, Copy, Debug)]
pub struct GridBox {
    pub min: [usize; 3],
    pub max: [usize; 3],
}

fn mul_rot(a: &Rot3, b: &Rot3) -> Rot3 {
    let mut o = [0; 9];
    for i in 0..3 {
        for j in 0..3 {
            o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
        }
    }
    o
}

fn apply(m: &Rot3, v: [i32; 3]) -> [i32; 3] {
    [0, 1, 2].map(|i| m[i * 3] * v[0] + m[i * 3 + 1] * v[1] + m[i * 3 + 2] * v[2])
}

/// Highest keyframe number in the scene.
pub fn animation_length(file: &VoxFile) -> i32 {
    let mut max = 0;
    for n in file.nodes.values() {
        match n {
            Node::Transform { frames, .. } => frames.iter().for_each(|f| max = max.max(f.frame.unwrap_or(0))),
            Node::Shape { models, .. } => models.iter().for_each(|m| max = max.max(m.1.unwrap_or(0))),
            _ => {}
        }
    }
    max
}

fn pose_at(frames: &[crate::vox::TransformFrame], time: i32) -> (Rot3, [i32; 3]) {
    if frames.len() == 1 || frames[0].frame.is_none() {
        return (frames[0].rotation, frames[0].translation);
    }
    let mut sorted: Vec<_> = frames.to_vec();
    sorted.sort_by_key(|f| f.frame.unwrap_or(0));
    if time <= sorted[0].frame.unwrap_or(0) {
        return (sorted[0].rotation, sorted[0].translation);
    }
    for w in sorted.windows(2) {
        let (a, b) = (&w[0], &w[1]);
        let (fa, fb) = (a.frame.unwrap_or(0), b.frame.unwrap_or(0));
        if time >= fa && time < fb {
            let k = (time - fa) as f64 / (fb - fa) as f64;
            // Round like JavaScript's Math.round (halves go up).
            let t = [0, 1, 2].map(|j| (a.translation[j] as f64 + (b.translation[j] - a.translation[j]) as f64 * k + 0.5).floor() as i32);
            return (a.rotation, t);
        }
    }
    let last = sorted.last().unwrap();
    (last.rotation, last.translation)
}

fn shape_model_at(attrs: &crate::vox::Dict, models: &[(i32, Option<i32>)], time: i32) -> Option<i32> {
    if models.is_empty() {
        return None;
    }
    if models.len() == 1 || models[0].1.is_none() {
        return Some(models[0].0);
    }
    let mut sorted = models.to_vec();
    sorted.sort_by_key(|m| m.1.unwrap_or(0));
    let mut t = time;
    if attrs.get("_loop").map(|v| v == "1").unwrap_or(false) {
        let span = sorted.last().unwrap().1.unwrap_or(0) + 1;
        t = ((time % span) + span) % span;
    }
    let mut pick = sorted[0].0;
    for m in &sorted {
        if m.1.unwrap_or(0) <= t {
            pick = m.0;
        }
    }
    Some(pick)
}

/// Every visible model with its world transform at `time`, in scene order.
pub fn place_models(file: &VoxFile, time: i32) -> Vec<Placed> {
    let mut out = vec![];
    if file.nodes.is_empty() {
        for i in 0..file.models.len() {
            out.push(Placed { model: i, rotation: IDENTITY, translation: [0; 3] });
        }
        return out;
    }
    fn visit(file: &VoxFile, id: i32, rot: Rot3, tr: [i32; 3], depth: u32, time: i32, out: &mut Vec<Placed>) {
        let Some(node) = file.nodes.get(&id) else { return };
        if depth > 256 || node.attrs().get("_hidden").map(|v| v == "1").unwrap_or(false) {
            return;
        }
        match node {
            Node::Transform { child, layer, frames, .. } => {
                if file.hidden_layers.contains(layer) {
                    return;
                }
                let (r, t) = pose_at(frames, time);
                let tt = apply(&rot, t);
                visit(file, *child, mul_rot(&rot, &r), [tr[0] + tt[0], tr[1] + tt[1], tr[2] + tt[2]], depth + 1, time, out);
            }
            Node::Group { children, .. } => {
                for c in children {
                    visit(file, *c, rot, tr, depth + 1, time, out);
                }
            }
            Node::Shape { attrs, models } => {
                if let Some(m) = shape_model_at(attrs, models, time) {
                    if (m as usize) < file.models.len() && m >= 0 {
                        out.push(Placed { model: m as usize, rotation: rot, translation: tr });
                    }
                }
            }
        }
    }
    visit(file, 0, IDENTITY, [0; 3], 0, time, &mut out);
    out
}

fn transform_voxel(file: &VoxFile, p: &Placed, x: i32, y: i32, z: i32) -> [i32; 3] {
    let s = file.models[p.model].size;
    let w = apply(&p.rotation, [x - s[0] / 2, y - s[1] / 2, z - s[2] / 2]);
    [w[0] + p.translation[0], w[1] + p.translation[1], w[2] + p.translation[2]]
}

fn bounds(file: &VoxFile, p: &Placed) -> ([i32; 3], [i32; 3]) {
    let s = file.models[p.model].size;
    let (mut lo, mut hi) = ([i32::MAX; 3], [i32::MIN; 3]);
    for cx in [0, s[0] - 1] {
        for cy in [0, s[1] - 1] {
            for cz in [0, s[2] - 1] {
                let w = transform_voxel(file, p, cx, cy, cz);
                for i in 0..3 {
                    lo[i] = lo[i].min(w[i]);
                    hi[i] = hi[i].max(w[i]);
                }
            }
        }
    }
    (lo, hi)
}

/// One grid for the whole animation; moving between frames only rewrites what moved.
pub struct SceneBaker {
    pub file: VoxFile,
    pub grid: Grid,
    placed: Vec<Placed>,
    pub time: i32,
}

impl SceneBaker {
    pub fn new(file: VoxFile, time: i32) -> Result<Self, String> {
        let len = animation_length(&file);
        let (mut lo, mut hi) = ([i32::MAX; 3], [i32::MIN; 3]);
        for t in 0..=len {
            for p in place_models(&file, t) {
                let (a, b) = bounds(&file, &p);
                for i in 0..3 {
                    lo[i] = lo[i].min(a[i]);
                    hi[i] = hi[i].max(b[i]);
                }
            }
        }
        if lo[0] == i32::MAX {
            lo = [0; 3];
            hi = [0; 3];
        }
        let dims = [0, 1, 2].map(|i| (hi[i] - lo[i] + 1) as usize);
        let total = dims[0] * dims[1] * dims[2];
        if total > 1 << 30 {
            return Err(format!("scene bounds {}×{}×{} are too large", dims[0], dims[1], dims[2]));
        }
        let placed = place_models(&file, time);
        let mut baker = SceneBaker { file, grid: Grid { origin: lo, dims, cells: vec![0; total], voxel_count: 0 }, placed, time };
        let all = baker.full_box();
        baker.rebuild(&[all]);
        Ok(baker)
    }

    fn full_box(&self) -> GridBox {
        let d = self.grid.dims;
        GridBox { min: [0; 3], max: [d[0] - 1, d[1] - 1, d[2] - 1] }
    }

    /// Move to `time`; returns the regions that changed.
    pub fn set_time(&mut self, time: i32) -> Vec<GridBox> {
        if time == self.time {
            return vec![];
        }
        let next = place_models(&self.file, time);
        let g = &self.grid;
        let to_grid = |(lo, hi): ([i32; 3], [i32; 3])| GridBox {
            min: [0, 1, 2].map(|i| (lo[i] - g.origin[i]).max(0) as usize),
            max: [0, 1, 2].map(|i| ((hi[i] - g.origin[i]) as usize).min(g.dims[i] - 1)),
        };
        let mut boxes = vec![];
        if next.len() != self.placed.len() {
            boxes.push(self.full_box());
        } else {
            for (a, b) in self.placed.iter().zip(&next) {
                if a != b {
                    boxes.push(to_grid(bounds(&self.file, a)));
                    boxes.push(to_grid(bounds(&self.file, b)));
                }
            }
        }
        self.placed = next;
        self.time = time;
        let vol: usize = boxes.iter().map(|b| (0..3).map(|i| b.max[i] - b.min[i] + 1).product::<usize>()).sum();
        if vol > self.grid.cells.len() / 3 {
            boxes = vec![self.full_box()];
        }
        self.rebuild(&boxes);
        boxes
    }

    fn rebuild(&mut self, boxes: &[GridBox]) {
        let [dx, dy, _] = self.grid.dims;
        let o = self.grid.origin;
        for b in boxes {
            for z in b.min[2]..=b.max[2] {
                for y in b.min[1]..=b.max[1] {
                    let row = dx * (y + dy * z);
                    for x in b.min[0]..=b.max[0] {
                        if self.grid.cells[row + x] != 0 {
                            self.grid.voxel_count -= 1;
                        }
                        self.grid.cells[row + x] = 0;
                    }
                }
            }
            for p in &self.placed {
                let (lo, hi) = bounds(&self.file, p);
                if (0..3).any(|i| hi[i] - o[i] < b.min[i] as i32 || lo[i] - o[i] > b.max[i] as i32) {
                    continue;
                }
                for v in &self.file.models[p.model].voxels {
                    let w = transform_voxel(&self.file, p, v[0] as i32, v[1] as i32, v[2] as i32);
                    let (x, y, z) = (w[0] - o[0], w[1] - o[1], w[2] - o[2]);
                    if x < b.min[0] as i32 || x > b.max[0] as i32 || y < b.min[1] as i32 || y > b.max[1] as i32 || z < b.min[2] as i32 || z > b.max[2] as i32 {
                        continue;
                    }
                    let idx = x as usize + dx * (y as usize + dy * z as usize);
                    if self.grid.cells[idx] == 0 {
                        self.grid.voxel_count += 1;
                    }
                    self.grid.cells[idx] = v[3];
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load(name: &str) -> VoxFile {
        crate::vox::parse(&std::fs::read(format!("../test-scenes/{name}")).unwrap()).unwrap()
    }

    #[test]
    fn voxel_counts_match_the_typescript_renderer() {
        // Counts printed by `npm run render` for the same files.
        for (name, count) in [("01-diffuse.vox", 15264), ("02-materials.vox", 9040), ("03-rotations.vox", 2884), ("04-glass.vox", 10392), ("05-fog-media.vox", 12201)] {
            let b = SceneBaker::new(load(name), 0).unwrap();
            assert_eq!(b.grid.voxel_count, count, "{name}");
        }
    }

    #[test]
    fn stepping_frames_matches_a_fresh_build() {
        let path = "/home/claude/vox-in/simcity_v2.vox";
        let Ok(bytes) = std::fs::read(path) else { return };
        let mut b = SceneBaker::new(crate::vox::parse(&bytes).unwrap(), 0).unwrap();
        for t in [3, 15, 29, 0] {
            b.set_time(t);
            let fresh = SceneBaker::new(crate::vox::parse(&bytes).unwrap(), t).unwrap();
            assert!(b.grid.cells == fresh.grid.cells, "frame {t}");
            assert_eq!(b.grid.voxel_count, fresh.grid.voxel_count);
        }
    }
}
