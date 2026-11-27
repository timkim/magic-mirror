//! MagicaVoxel .vox reader (mirrors src/vox/parser.ts). Reads models, palette, materials,
//! scene graph and layers; render settings come from the app's settings snapshot instead.

use std::collections::HashMap;

pub type Dict = HashMap<String, String>;
/// Row-major 3×3 rotation with entries -1, 0, 1.
pub type Rot3 = [i32; 9];
pub const IDENTITY: Rot3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

pub struct Model {
    pub size: [i32; 3],
    /// Packed voxels: x, y, z, colour index.
    pub voxels: Vec<[u8; 4]>,
}

#[derive(Clone)]
pub struct TransformFrame {
    pub rotation: Rot3,
    pub translation: [i32; 3],
    pub frame: Option<i32>,
}

pub enum Node {
    Transform { attrs: Dict, child: i32, layer: i32, frames: Vec<TransformFrame> },
    Group { attrs: Dict, children: Vec<i32> },
    Shape { attrs: Dict, models: Vec<(i32, Option<i32>)> },
}

impl Node {
    pub fn attrs(&self) -> &Dict {
        match self {
            Node::Transform { attrs, .. } | Node::Group { attrs, .. } | Node::Shape { attrs, .. } => attrs,
        }
    }
}

pub struct VoxFile {
    pub models: Vec<Model>,
    /// palette[i] is the RGBA colour used by voxel colour index i (entry 0 unused).
    pub palette: [[u8; 4]; 256],
    pub materials: HashMap<i32, Dict>,
    pub nodes: HashMap<i32, Node>,
    pub hidden_layers: Vec<i32>,
}

struct Reader<'a> {
    b: &'a [u8],
    pos: usize,
    end: usize,
}

impl<'a> Reader<'a> {
    fn need(&self, n: usize) -> Result<(), String> {
        if self.pos + n > self.end { Err(format!("unexpected end of .vox data at byte {}", self.pos)) } else { Ok(()) }
    }
    fn i32(&mut self) -> Result<i32, String> {
        self.need(4)?;
        let v = i32::from_le_bytes(self.b[self.pos..self.pos + 4].try_into().unwrap());
        self.pos += 4;
        Ok(v)
    }
    fn id(&mut self) -> Result<[u8; 4], String> {
        self.need(4)?;
        let v = self.b[self.pos..self.pos + 4].try_into().unwrap();
        self.pos += 4;
        Ok(v)
    }
    fn string(&mut self) -> Result<String, String> {
        let n = self.i32()?.max(0) as usize;
        self.need(n)?;
        let s = String::from_utf8_lossy(&self.b[self.pos..self.pos + n]).into_owned();
        self.pos += n;
        Ok(s)
    }
    fn dict(&mut self) -> Result<Dict, String> {
        let n = self.i32()?;
        let mut d = Dict::new();
        for _ in 0..n.max(0) {
            let k = self.string()?;
            let v = self.string()?;
            d.insert(k, v);
        }
        Ok(d)
    }
}

/// Decode the nTRN `_r` byte (bits 0-1 and 2-3: columns of rows 0 and 1; bits 4-6: signs).
pub fn decode_rotation(r: u8) -> Rot3 {
    let c0 = (r & 3) as usize;
    let c1 = ((r >> 2) & 3) as usize;
    let c2 = (3 - c0 as i32 - c1 as i32).clamp(0, 2) as usize;
    let mut m = [0; 9];
    m[c0] = if r & 16 != 0 { -1 } else { 1 };
    m[3 + c1] = if r & 32 != 0 { -1 } else { 1 };
    m[6 + c2] = if r & 64 != 0 { -1 } else { 1 };
    m
}

fn vec3(s: Option<&String>) -> [i32; 3] {
    let mut out = [0; 3];
    if let Some(s) = s {
        for (i, p) in s.split_whitespace().take(3).enumerate() {
            out[i] = p.parse::<f64>().map(|v| v as i32).unwrap_or(0);
        }
    }
    out
}

pub fn parse(bytes: &[u8]) -> Result<VoxFile, String> {
    let mut r = Reader { b: bytes, pos: 0, end: bytes.len() };
    if &r.id()? != b"VOX " {
        return Err("not a MagicaVoxel .vox file".into());
    }
    r.i32()?; // version
    let mut file = VoxFile {
        models: vec![],
        palette: default_palette(),
        materials: HashMap::new(),
        nodes: HashMap::new(),
        hidden_layers: vec![],
    };
    let mut pending_size = [0; 3];

    // Chunks nest (MAIN holds everything); walk linearly and step into children.
    while r.pos + 12 <= r.end {
        let id = r.id()?;
        let content = r.i32()?.max(0) as usize;
        let _children = r.i32()?;
        let start = r.pos;
        let end = (start + content).min(bytes.len());
        let mut c = Reader { b: bytes, pos: start, end };
        match &id {
            b"SIZE" => pending_size = [c.i32()?, c.i32()?, c.i32()?],
            b"XYZI" => {
                let n = c.i32()?.max(0) as usize;
                c.need(n * 4)?;
                let voxels = bytes[c.pos..c.pos + n * 4].chunks_exact(4).map(|v| [v[0], v[1], v[2], v[3]]).collect();
                file.models.push(Model { size: pending_size, voxels });
            }
            b"RGBA" => {
                let raw = &bytes[start..end];
                let mut pal = [[0u8; 4]; 256];
                for k in 0..255.min(raw.len() / 4) {
                    pal[k + 1] = [raw[k * 4], raw[k * 4 + 1], raw[k * 4 + 2], raw[k * 4 + 3]];
                }
                file.palette = pal;
            }
            b"MATL" => {
                let mid = c.i32()?;
                file.materials.insert(mid, c.dict()?);
            }
            b"nTRN" => {
                let nid = c.i32()?;
                let attrs = c.dict()?;
                let child = c.i32()?;
                c.i32()?;
                let layer = c.i32()?;
                let n = c.i32()?;
                let mut frames = vec![];
                for _ in 0..n.max(0) {
                    let f = c.dict()?;
                    frames.push(TransformFrame {
                        rotation: f.get("_r").and_then(|v| v.parse::<u8>().ok()).map(decode_rotation).unwrap_or(IDENTITY),
                        translation: vec3(f.get("_t")),
                        frame: f.get("_f").and_then(|v| v.parse().ok()),
                    });
                }
                if frames.is_empty() {
                    frames.push(TransformFrame { rotation: IDENTITY, translation: [0; 3], frame: None });
                }
                file.nodes.insert(nid, Node::Transform { attrs, child, layer, frames });
            }
            b"nGRP" => {
                let nid = c.i32()?;
                let attrs = c.dict()?;
                let n = c.i32()?;
                let mut children = vec![];
                for _ in 0..n.max(0) {
                    children.push(c.i32()?);
                }
                file.nodes.insert(nid, Node::Group { attrs, children });
            }
            b"nSHP" => {
                let nid = c.i32()?;
                let attrs = c.dict()?;
                let n = c.i32()?;
                let mut models = vec![];
                for _ in 0..n.max(0) {
                    let m = c.i32()?;
                    let d = c.dict()?;
                    models.push((m, d.get("_f").and_then(|v| v.parse().ok())));
                }
                file.nodes.insert(nid, Node::Shape { attrs, models });
            }
            b"LAYR" => {
                let lid = c.i32()?;
                let attrs = c.dict()?;
                if attrs.get("_hidden").map(|v| v == "1").unwrap_or(false) {
                    file.hidden_layers.push(lid);
                }
            }
            _ => {}
        }
        // MAIN's content is empty and its children follow directly, so just continue after content.
        r.pos = end;
    }
    Ok(file)
}

fn default_palette() -> [[u8; 4]; 256] {
    let mut p = [[0u8; 4]; 256];
    for (i, c) in p.iter_mut().enumerate().skip(1) {
        let v = (255 - ((i - 1) as f32 / 254.0 * 200.0).round() as i32) as u8;
        *c = [v, v, v, 255];
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(r: u8, v: [i32; 3]) -> [i32; 3] {
        let m = decode_rotation(r);
        [0, 1, 2].map(|i| m[i * 3] * v[0] + m[i * 3 + 1] * v[1] + m[i * 3 + 2] * v[2])
    }

    #[test]
    fn rotation_bytes() {
        assert_eq!(apply(4, [1, 0, 0]), [1, 0, 0]);
        assert_eq!(apply(17, [1, 0, 0]), [0, 1, 0]);
        assert_eq!(apply(52, [1, 0, 0]), [-1, 0, 0]);
        assert_eq!(apply(33, [1, 0, 0]), [0, -1, 0]);
    }
}
