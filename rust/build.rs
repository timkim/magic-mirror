// The WGSL shaders live in the TypeScript app (src/render/shaders/*.wgsl.ts) as template
// strings. Extract them at build time so the browser, Node and Rust renderers all run
// exactly the same shader code.

use std::{env, fs, path::Path};

fn main() {
    let out = env::var("OUT_DIR").unwrap();
    let dir = Path::new("../src/render/shaders");
    for name in ["pathtrace", "present", "bloom", "denoise"] {
        let path = dir.join(format!("{name}.wgsl.ts"));
        println!("cargo:rerun-if-changed={}", path.display());
        let src = fs::read_to_string(&path).unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
        let start = src.find("/* wgsl */ `").expect("shader start marker") + "/* wgsl */ `".len();
        let end = src.rfind("`;").expect("shader end marker");
        let body = &src[start..end];
        assert!(!body.contains("${"), "{name}: template interpolation is not supported");
        fs::write(Path::new(&out).join(format!("{name}.wgsl")), body.replace("\\`", "`")).unwrap();
    }
}
