export type BackgroundMode = 'alpha' | 'white' | 'auto';
export type SideMode = 'image' | 'flat' | 'edge';

export interface AppSettings {
  extrusionDepth: number;
  simplifyTolerance: number;
  scale: number;
  backgroundMode: BackgroundMode;
  sideMode: SideMode;
  sideColor: string;
  outlineEnabled: boolean;
  outlineColor: string;
  outlineOpacity: number;
  normalMapEnabled: boolean;
  normalMapStrength: number;
  reliefEnabled: boolean;
  reliefStrength: number;
}
