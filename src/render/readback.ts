// Read the current render back as RGBA8 pixels (for PNG export, headless renders and,
// later, sending finished frames over the network).

import type { PostParams, Renderer } from './renderer';

export async function readPixels(renderer: Renderer, post: PostParams): Promise<{ width: number; height: number; data: Uint8Array }> {
  const device = renderer.device;
  const w = renderer.width, h = renderer.height;
  const target = device.createTexture({ size: [w, h], format: renderer.outputFormat, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const rowBytes = Math.ceil((w * 4) / 256) * 256;
  const buf = device.createBuffer({ size: rowBytes * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  renderer.present(enc, target.createView(), post);
  enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: rowBytes }, [w, h]);
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const src = new Uint8Array(buf.getMappedRange());
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) data.set(src.subarray(y * rowBytes, y * rowBytes + w * 4), y * w * 4);
  buf.unmap();
  buf.destroy();
  target.destroy();
  // BGRA targets come back with red and blue swapped.
  if (renderer.outputFormat.startsWith('bgra')) for (let i = 0; i < data.length; i += 4) { const r = data[i]; data[i] = data[i + 2]; data[i + 2] = r; }
  return { width: w, height: h, data };
}
