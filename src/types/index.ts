export type BackgroundMode = 'alpha' | 'white' | 'auto';
export type SideMode = 'image' | 'flat' | 'edge';
export type BoxFillMode = 'edge-stretch' | 'flat-color' | 'keep-transparent';
export type FaceMode = 'front' | 'front-back' | 'front-back-lr' | 'front-back-lrtb';
export type FaceName = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

/** Per-face translation offset in normalised model units (0.1 = 10% of scale). */
export interface FaceOffset { x: number; y: number; z: number; }
export type FaceOffsets = Partial<Record<FaceName, FaceOffset>>;

export interface AppSettings {
  extrusionDepth: number;
  simplifyTolerance: number;
  scale: number;
  backgroundMode: BackgroundMode;
  sideMode: SideMode;
  sideColor: string;
  // Used in box mode when a face texture is missing (gap fill)
  boxFillColor: string;
  // Used in box mode to fill transparent texels inside face textures
  boxFillMode: BoxFillMode;
  faceMode: FaceMode;
  outlineEnabled: boolean;
  outlineColor: string;
  outlineOpacity: number;
  normalMapEnabled: boolean;
  normalMapStrength: number;
  reliefEnabled: boolean;
  reliefStrength: number;
  boxMode: boolean;
  latheMode: boolean;
  latheSegments: number;
  latheClosed: boolean;
  latheStretchTexture: boolean;
  latheColumnWidth: number;
}
