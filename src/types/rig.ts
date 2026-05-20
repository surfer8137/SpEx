// ── Full internal joint set (used by rigBuilder.ts) ───────────────────────────
export type JointId =
  | 'chin'
  | 'hips'
  | 'spine_mid'
  | 'l_shoulder' | 'r_shoulder'
  | 'l_elbow'    | 'r_elbow'
  | 'l_wrist'    | 'r_wrist'
  | 'l_knee'     | 'r_knee'
  | 'l_ankle'    | 'r_ankle';

export type RigMarkers = Record<JointId, { x: number; y: number }>;

// ── Mixamo-style minimal markers (what the user places) ───────────────────────
export type MixamoJointId =
  | 'chin'
  | 'groin'
  | 'l_elbow' | 'r_elbow'
  | 'l_wrist' | 'r_wrist'
  | 'l_knee'  | 'r_knee';

export type MixamoMarkers = Record<MixamoJointId, { x: number; y: number }>;

export interface MixamoJointMeta {
  label: string;       // group label (e.g. "WRISTS")
  color: string;
  pair?: MixamoJointId;    // the symmetric counterpart (r_ of this l_)
  hideLabel?: boolean;     // r_ entries — shown via pair
}

export const MIXAMO_META: Record<MixamoJointId, MixamoJointMeta> = {
  chin:    { label: 'CHIN',   color: '#00bcd4' },
  groin:   { label: 'GROIN',  color: '#e91e63' },
  l_wrist: { label: 'WRISTS', color: '#4caf50', pair: 'r_wrist' },
  r_wrist: { label: '',       color: '#4caf50', hideLabel: true  },
  l_elbow: { label: 'ELBOWS', color: '#ffeb3b', pair: 'r_elbow' },
  r_elbow: { label: '',       color: '#ffeb3b', hideLabel: true  },
  l_knee:  { label: 'KNEES',  color: '#ff9800', pair: 'r_knee'  },
  r_knee:  { label: '',       color: '#ff9800', hideLabel: true  },
};

// Display order for sidebar (skip hidden)
export const MIXAMO_SIDEBAR_ORDER: MixamoJointId[] = [
  'chin', 'l_wrist', 'l_elbow', 'l_knee', 'groin',
];

export const DEFAULT_MIXAMO_MARKERS: MixamoMarkers = {
  chin:    { x: 0.50, y: 0.10 },
  groin:   { x: 0.50, y: 0.55 },
  l_elbow: { x: 0.17, y: 0.38 },
  r_elbow: { x: 0.83, y: 0.38 },
  l_wrist: { x: 0.03, y: 0.52 },
  r_wrist: { x: 0.97, y: 0.52 },
  l_knee:  { x: 0.41, y: 0.73 },
  r_knee:  { x: 0.59, y: 0.73 },
};

/**
 * Derive the full 13-joint RigMarkers from 8 Mixamo control points.
 * Missing joints (shoulders, ankles, spine) are computed analytically.
 */
export function deriveFullMarkers(m: MixamoMarkers): RigMarkers {
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  // Spine mid: 40% down from chin to groin
  const spineMid = {
    x: lerp(m.chin.x, m.groin.x, 0.5),
    y: lerp(m.chin.y, m.groin.y, 0.40),
  };

  // Shoulders: at shoulder-height (18% chin→groin), x = midpoint of center→elbow
  const shoulderY = lerp(m.chin.y, m.groin.y, 0.18);
  const lShoulder = { x: lerp(m.groin.x, m.l_elbow.x, 0.55), y: shoulderY };
  const rShoulder = { x: lerp(m.groin.x, m.r_elbow.x, 0.55), y: shoulderY };

  // Ankles: continue knee→groin vector below knee by 75%
  const lAnkle = {
    x: m.l_knee.x,
    y: Math.min(m.l_knee.y + (m.l_knee.y - m.groin.y) * 0.75, 0.97),
  };
  const rAnkle = {
    x: m.r_knee.x,
    y: Math.min(m.r_knee.y + (m.r_knee.y - m.groin.y) * 0.75, 0.97),
  };

  return {
    hips:       m.groin,
    spine_mid:  spineMid,
    chin:       m.chin,
    l_shoulder: lShoulder,
    r_shoulder: rShoulder,
    l_elbow:    m.l_elbow,
    r_elbow:    m.r_elbow,
    l_wrist:    m.l_wrist,
    r_wrist:    m.r_wrist,
    l_knee:     m.l_knee,
    r_knee:     m.r_knee,
    l_ankle:    lAnkle,
    r_ankle:    rAnkle,
  };
}

// ── Legacy types kept for rigBuilder.ts ───────────────────────────────────────

export interface JointMeta {
  label: string;
  color: string;
  symmetricOf?: JointId;
  hideLabel?: boolean;
}

export const JOINT_META: Record<JointId, JointMeta> = {
  chin:       { label: 'CHIN',      color: '#00bcd4' },
  hips:       { label: 'HIPS',      color: '#e91e63' },
  spine_mid:  { label: 'SPINE',     color: '#9c27b0' },
  l_shoulder: { label: 'SHOULDERS', color: '#8bc34a' },
  r_shoulder: { label: '',          color: '#8bc34a', symmetricOf: 'l_shoulder', hideLabel: true },
  l_elbow:    { label: 'ELBOWS',    color: '#ffeb3b' },
  r_elbow:    { label: '',          color: '#ffeb3b', symmetricOf: 'l_elbow',    hideLabel: true },
  l_wrist:    { label: 'WRISTS',    color: '#4caf50' },
  r_wrist:    { label: '',          color: '#4caf50', symmetricOf: 'l_wrist',    hideLabel: true },
  l_knee:     { label: 'KNEES',     color: '#ff9800' },
  r_knee:     { label: '',          color: '#ff9800', symmetricOf: 'l_knee',     hideLabel: true },
  l_ankle:    { label: 'ANKLES',    color: '#795548' },
  r_ankle:    { label: '',          color: '#795548', symmetricOf: 'l_ankle',    hideLabel: true },
};

// Default full markers (not used in UI anymore — kept for rigBuilder compat)
export const DEFAULT_MARKERS: RigMarkers = deriveFullMarkers(DEFAULT_MIXAMO_MARKERS);

export const BONE_PARENT: Partial<Record<JointId, JointId>> = {
  spine_mid:  'hips',
  chin:       'spine_mid',
  l_shoulder: 'spine_mid',
  l_elbow:    'l_shoulder',
  l_wrist:    'l_elbow',
  r_shoulder: 'spine_mid',
  r_elbow:    'r_shoulder',
  r_wrist:    'r_elbow',
  l_knee:     'hips',
  l_ankle:    'l_knee',
  r_knee:     'hips',
  r_ankle:    'r_knee',
};

export const BONE_SEGMENTS: Array<[JointId, JointId]> = [
  ['hips',       'spine_mid'],
  ['spine_mid',  'chin'],
  ['spine_mid',  'l_shoulder'],
  ['l_shoulder', 'l_elbow'],
  ['l_elbow',    'l_wrist'],
  ['spine_mid',  'r_shoulder'],
  ['r_shoulder', 'r_elbow'],
  ['r_elbow',    'r_wrist'],
  ['hips',       'l_knee'],
  ['l_knee',     'l_ankle'],
  ['hips',       'r_knee'],
  ['r_knee',     'r_ankle'],
];

export const BONE_NAMES: string[] = [
  'hips', 'spine', 'l_clavicle', 'l_upper_arm', 'l_forearm',
  'r_clavicle', 'r_upper_arm', 'r_forearm',
  'l_upper_leg', 'l_lower_leg', 'r_upper_leg', 'r_lower_leg',
];

export const JOINT_BONE_INDEX: Record<JointId, number> = {
  hips:       0,
  spine_mid:  1,
  l_shoulder: 2,
  l_elbow:    3,
  l_wrist:    4,
  r_shoulder: 5,
  r_elbow:    6,
  r_wrist:    7,
  l_knee:     8,
  l_ankle:    9,
  r_knee:     10,
  r_ankle:    11,
  chin:       1,
};
