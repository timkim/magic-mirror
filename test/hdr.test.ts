import { describe, expect, it } from 'vitest';
import { downsample, parseHdr, toHalf, writeHdr } from '../src/render/hdr';

describe('hdr', () => {
  it('round-trips RLE-encoded RGBE within 1%', () => {
    const w = 64, h = 8;
    const rgb = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { rgb[i * 3] = (i % w) / 8; rgb[i * 3 + 1] = 0.5; rgb[i * 3 + 2] = i < 20 ? 40 : 0.01; }
    const back = parseHdr(writeHdr({ width: w, height: h, rgb }));
    expect([back.width, back.height]).toEqual([w, h]);
    for (let i = 0; i < rgb.length; i++) {
      const max = Math.max(rgb[i - (i % 3)], rgb[i - (i % 3) + 1], rgb[i - (i % 3) + 2]);
      expect(Math.abs(back.rgb[i] - rgb[i])).toBeLessThanOrEqual(max * 0.01 + 1e-6);
    }
  });
  it('downsamples by averaging', () => {
    const img = { width: 4, height: 2, rgb: new Float32Array([1, 1, 1, 3, 3, 3, 0, 0, 0, 0, 0, 0, 1, 1, 1, 3, 3, 3, 0, 0, 0, 0, 0, 0]) };
    const d = downsample(img, 2);
    expect([d.width, d.height]).toEqual([2, 1]);
    expect(Array.from(d.rgb)).toEqual([2, 2, 2, 0, 0, 0]);
  });
  it('converts to half floats', () => {
    expect(toHalf(1)).toBe(0x3c00);
    expect(toHalf(0.5)).toBe(0x3800);
    expect(toHalf(2)).toBe(0x4000);
  });
});
