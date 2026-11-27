import { describe, expect, it } from 'vitest';
import { cameraAt, keysFromVox, keysToVox, type CameraKey } from '../src/anim/camera';
import { parseVox } from '../src/vox/parser';
import { serializeVox } from '../src/vox/serialize';
import { writeVox } from '../src/vox/writer';

const key = (frame: number, yaw: number, extra: Partial<CameraKey> = {}): CameraKey => ({ frame, target: [0, 0, 0], yaw, pitch: 30, distance: 100, fov: 45, orthoSize: 50, ...extra });

describe('camera keyframes', () => {
  it('holds, eases and interpolates', () => {
    const keys = [key(10, 0), key(20, 100, { distance: 400, ease: 'linear' }), key(30, 200, { distance: 100 })];
    expect(cameraAt(keys, 0)!.yaw).toBe(0);
    expect(cameraAt(keys, 15)!.yaw).toBeCloseTo(50); // smoothstep midpoint
    expect(cameraAt(keys, 12)!.yaw).toBeLessThan(20); // eased: slow start
    expect(cameraAt(keys, 25)!.yaw).toBeCloseTo(150); // linear
    expect(cameraAt(keys, 15)!.distance).toBeCloseTo(200); // geometric between 100 and 400
    expect(cameraAt(keys, 99)!.yaw).toBe(200);
    expect(cameraAt([], 5)).toBeNull();
  });

  it('saves in the .vox and reads back', () => {
    const file = parseVox(writeVox({ objects: [{ size: [1, 1, 1], voxels: [[0, 0, 0, 1]] }] }));
    keysToVox(file, JSON.stringify([key(0, 0), key(59, 360)]), 59);
    const back = keysFromVox(parseVox(serializeVox(file)));
    expect(JSON.parse(back.keys)).toHaveLength(2);
    expect(back.end).toBe(59);
    keysToVox(file, '[]', 0);
    expect(file.renderObjects.some((r) => r._type === '_magic_mirror')).toBe(false);
  });
});
