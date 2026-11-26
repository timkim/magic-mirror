// Radiance .hdr (RGBE) reader, plus conversion to the half-float RGBA the renderer uploads.
// Handles flat and run-length-encoded scanlines, and the usual "-Y h +X w" orientation.

export interface HdrImage {
  width: number;
  height: number;
  /** RGB floats, row-major from the top. */
  rgb: Float32Array;
}

export function parseHdr(bytes: Uint8Array): HdrImage {
  let pos = 0;
  const line = () => {
    let s = '';
    while (pos < bytes.length && bytes[pos] !== 0x0a) s += String.fromCharCode(bytes[pos++]);
    pos++;
    return s;
  };
  const magic = line();
  if (!magic.startsWith('#?')) throw new Error('Not a Radiance .hdr file');
  let format = '';
  for (let l = line(); l !== ''; l = line()) {
    if (pos >= bytes.length) throw new Error('Truncated .hdr header');
    if (l.startsWith('FORMAT=')) format = l.slice(7);
  }
  if (format && format !== '32-bit_rle_rgbe') throw new Error(`Unsupported .hdr format ${format} (only RGBE)`);
  const res = line().trim().split(/\s+/);
  if (res.length !== 4 || res[0] !== '-Y' || res[2] !== '+X') throw new Error(`Unsupported .hdr orientation "${res.join(' ')}"`);
  const height = Number(res[1]), width = Number(res[3]);

  const rgbe = new Uint8Array(width * height * 4);
  const scan = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    const rle = width >= 8 && width < 32768 && bytes[pos] === 2 && bytes[pos + 1] === 2 && !(bytes[pos + 2] & 0x80);
    if (!rle) {
      // Flat scanline.
      rgbe.set(bytes.subarray(pos, pos + width * 4), y * width * 4);
      pos += width * 4;
      continue;
    }
    if (((bytes[pos + 2] << 8) | bytes[pos + 3]) !== width) throw new Error('Bad .hdr scanline width');
    pos += 4;
    for (let c = 0; c < 4; c++) {
      let x = 0;
      while (x < width) {
        let n = bytes[pos++];
        if (n > 128) {
          n -= 128;
          const v = bytes[pos++];
          for (let i = 0; i < n; i++) scan[(x++) * 4 + c] = v;
        } else {
          for (let i = 0; i < n; i++) scan[(x++) * 4 + c] = bytes[pos++];
        }
      }
    }
    rgbe.set(scan, y * width * 4);
  }

  const rgb = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const e = rgbe[i * 4 + 3];
    const f = e ? Math.pow(2, e - 136) : 0; // 2^(e-128) / 256
    rgb[i * 3] = rgbe[i * 4] * f;
    rgb[i * 3 + 1] = rgbe[i * 4 + 1] * f;
    rgb[i * 3 + 2] = rgbe[i * 4 + 2] * f;
  }
  return { width, height, rgb };
}

/** Box-downsample so the longest side is at most maxWidth (lighting doesn't need 8K). */
export function downsample(img: HdrImage, maxWidth: number): HdrImage {
  const k = Math.ceil(img.width / maxWidth);
  if (k <= 1) return img;
  const w = Math.floor(img.width / k), h = Math.floor(img.height / k);
  const rgb = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) sum += img.rgb[((y * k + j) * img.width + (x * k + i)) * 3 + c];
        rgb[(y * w + x) * 3 + c] = sum / (k * k);
      }
  return { width: w, height: h, rgb };
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
export function toHalf(v: number): number {
  f32[0] = Math.min(v, 65000);
  const x = u32[0];
  const sign = (x >> 16) & 0x8000;
  const exp = ((x >> 23) & 0xff) - 127 + 15;
  const mant = x & 0x7fffff;
  if (exp <= 0) return sign; // tiny values flush to zero
  if (exp >= 31) return sign | 0x7bff;
  return sign | (exp << 10) | (mant >> 13);
}

export function toHalfRGBA(img: HdrImage): { width: number; height: number; data: Uint16Array } {
  const n = img.width * img.height;
  const data = new Uint16Array(n * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4] = toHalf(img.rgb[i * 3]);
    data[i * 4 + 1] = toHalf(img.rgb[i * 3 + 1]);
    data[i * 4 + 2] = toHalf(img.rgb[i * 3 + 2]);
    data[i * 4 + 3] = 0x3c00; // 1.0
  }
  return { width: img.width, height: img.height, data };
}

/** Read an .hdr file into the form Renderer.setEnvironment takes. */
export function loadHdrEnvironment(bytes: Uint8Array, maxWidth = 2048) {
  const img = downsample(parseHdr(bytes), maxWidth);
  return { ...toHalfRGBA(img), sampling: buildEnvSampling(img) };
}

/** Write an RGBE .hdr (run-length encoded scanlines). Used for test images. */
export function writeHdr(img: HdrImage): Uint8Array {
  const head = new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${img.height} +X ${img.width}\n`);
  const out: number[] = Array.from(head);
  const ch = [new Uint8Array(img.width), new Uint8Array(img.width), new Uint8Array(img.width), new Uint8Array(img.width)];
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 3;
      const m = Math.max(img.rgb[i], img.rgb[i + 1], img.rgb[i + 2]);
      if (m < 1e-32) { ch[0][x] = ch[1][x] = ch[2][x] = ch[3][x] = 0; continue; }
      const e = Math.ceil(Math.log2(m) + 1e-9);
      const s = 256 / Math.pow(2, e);
      ch[0][x] = Math.min(255, Math.floor(img.rgb[i] * s));
      ch[1][x] = Math.min(255, Math.floor(img.rgb[i + 1] * s));
      ch[2][x] = Math.min(255, Math.floor(img.rgb[i + 2] * s));
      ch[3][x] = e + 128;
    }
    out.push(2, 2, (img.width >> 8) & 255, img.width & 255);
    for (const c of ch) {
      let x = 0;
      while (x < img.width) {
        let run = 1;
        while (x + run < img.width && run < 127 && c[x + run] === c[x]) run++;
        if (run >= 3) { out.push(128 + run, c[x]); x += run; continue; }
        const start = x;
        while (x < img.width && x - start < 128 && !(x + 2 < img.width && c[x] === c[x + 1] && c[x] === c[x + 2])) x++;
        out.push(x - start, ...c.subarray(start, x));
      }
    }
  }
  return new Uint8Array(out);
}

/**
 * Tables for importance-sampling the sky image, so bright areas (the sun) are aimed at
 * directly instead of found by chance. Built on a small copy of the image.
 * Layout: marginal CDF over rows (h+1), then per-row CDFs (h × (w+1)), then the
 * per-pixel probability (w × h, normalised so it averages 1).
 */
export function buildEnvSampling(img: HdrImage, maxWidth = 256): { width: number; height: number; table: Float32Array } {
  const s = downsample(img, maxWidth);
  const w = s.width, h = s.height;
  const weight = new Float32Array(w * h);
  let total = 0;
  for (let y = 0; y < h; y++) {
    const sinT = Math.sin(((y + 0.5) / h) * Math.PI);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const lum = 0.2126 * s.rgb[i * 3] + 0.7152 * s.rgb[i * 3 + 1] + 0.0722 * s.rgb[i * 3 + 2];
      weight[i] = Math.max(lum, 1e-6) * sinT;
      total += weight[i];
    }
  }
  const table = new Float32Array(h + 1 + h * (w + 1) + w * h);
  const cond = h + 1, pdf = h + 1 + h * (w + 1);
  let acc = 0;
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) rowSum += weight[y * w + x];
    let r = 0;
    table[cond + y * (w + 1)] = 0;
    for (let x = 0; x < w; x++) {
      r += weight[y * w + x];
      table[cond + y * (w + 1) + x + 1] = rowSum > 0 ? r / rowSum : (x + 1) / w;
    }
    acc += rowSum;
    table[y + 1] = acc / total;
  }
  table[0] = 0;
  for (let i = 0; i < w * h; i++) table[pdf + i] = (weight[i] / total) * w * h;
  return { width: w, height: h, table };
}
