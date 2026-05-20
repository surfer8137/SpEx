export type BackgroundMode = 'alpha' | 'white' | 'auto';
export type SideMode = 'image' | 'flat' | 'edge';
export type FaceMode = 'front' | 'front-back' | 'front-back-lr' | 'front-back-lrtb';

export interface AppSettings {
  extrusionDepth: number;
  simplifyTolerance: number;
  scale: number;
  backgroundMode: BackgroundMode;
  sideMode: SideMode;
  sideColor: string;
  faceMode: FaceMode;
  outlineEnabled: boolean;
  outlineColor: string;
  outlineOpacity: number;
  normalMapEnabled: boolean;
  normalMapStrength: number;
  reliefEnabled: boolean;
  reliefStrength: number;
  latheMode: boolean;
  latheSegments: number;
  latheClosed: boolean;
  latheStretchTexture: boolean;
  latheColumnWidth: number;
}
