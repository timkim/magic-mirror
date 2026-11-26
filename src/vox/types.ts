// Data types for a parsed MagicaVoxel .vox file.
// Coordinates follow MagicaVoxel: integer voxels, Z is up.

export type VoxDict = Record<string, string>;

export interface VoxModel {
  size: [number, number, number];
  /** Packed voxels: 4 bytes each (x, y, z, colour index 1-255). */
  voxels: Uint8Array;
}

/** 3x3 rotation matrix stored row-major, entries are -1, 0 or 1. */
export type Rot3 = [number, number, number, number, number, number, number, number, number];

export interface TransformFrame {
  rotation: Rot3;
  translation: [number, number, number];
  /** Keyframe number (undefined for static nodes). */
  frame?: number;
}

export interface TransformNode {
  kind: 'transform';
  id: number;
  attrs: VoxDict;
  childId: number;
  layerId: number;
  frames: TransformFrame[];
}

export interface GroupNode {
  kind: 'group';
  id: number;
  attrs: VoxDict;
  childIds: number[];
}

export interface ShapeNode {
  kind: 'shape';
  id: number;
  attrs: VoxDict;
  models: { modelId: number; frame?: number }[];
}

export type SceneNode = TransformNode | GroupNode | ShapeNode;

export interface VoxLayer {
  id: number;
  attrs: VoxDict;
  hidden: boolean;
}

export interface VoxCamera {
  id: number;
  attrs: VoxDict;
}

export interface VoxFile {
  version: number;
  models: VoxModel[];
  /** 256 RGBA entries; palette[i] is the colour used by voxel colour index i (palette[0] unused). */
  palette: Uint8Array;
  /** MATL dictionaries keyed by palette index. */
  materials: Map<number, VoxDict>;
  nodes: Map<number, SceneNode>;
  layers: Map<number, VoxLayer>;
  /** Render settings (rOBJ), one dict per chunk. Keyed by its `_type` for convenience. */
  renderObjects: VoxDict[];
  cameras: VoxCamera[];
  /** Chunk ids we saw but don't interpret yet (useful when adding features). */
  unknownChunks: string[];
}
