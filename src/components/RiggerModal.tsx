'use client';
import { useRef, useMemo } from 'react';
import type { MixamoMarkers, MixamoJointId } from '../types/rig';
import {
  MIXAMO_META,
  MIXAMO_SIDEBAR_ORDER,
  DEFAULT_MIXAMO_MARKERS,
  deriveFullMarkers,
} from '../types/rig';

interface Props {
  imageData: ImageData;
  markers: MixamoMarkers;
  onMarkersChange: (m: MixamoMarkers) => void;
  useSymmetry: boolean;
  onSymmetryChange: (v: boolean) => void;
  onBuild: () => void;
  onClose: () => void;
}

// Simple T-pose humanoid silhouette as SVG path data (normalised 0-1 viewBox)
const SILHOUETTE = `
  M .44 .04 A .06 .06 0 1 1 .56 .04 A .06 .06 0 1 1 .44 .04
  M .35 .15 Q .50 .11 .65 .15 L .68 .30 L .90 .28 L .92 .50
  L .68 .50 L .66 .58 L .62 .95 L .55 .95 L .52 .65
  L .50 .60 L .48 .65 L .45 .95 L .38 .95 L .34 .58
  L .32 .50 L .08 .50 L .10 .28 L .32 .30 Z
`;

export default function RiggerModal({
  imageData, markers, onMarkersChange,
  useSymmetry, onSymmetryChange, onBuild, onClose,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const draggingRef = useRef<MixamoJointId | null>(null);

  const imageUrl = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = imageData.width; c.height = imageData.height;
    c.getContext('2d')!.putImageData(imageData, 0, 0);
    return c.toDataURL();
  }, [imageData]);

  // Derive the full skeleton for drawing bone lines
  const derived = useMemo(() => deriveFullMarkers(markers), [markers]);

  // ── Skeleton lines to preview (between derived joints, in SVG %) ──────────
  const boneLines: Array<[string, string]> = [
    ['hips', 'spine_mid'], ['spine_mid', 'chin'],
    ['spine_mid', 'l_shoulder'], ['l_shoulder', 'l_elbow'], ['l_elbow', 'l_wrist'],
    ['spine_mid', 'r_shoulder'], ['r_shoulder', 'r_elbow'], ['r_elbow', 'r_wrist'],
    ['hips', 'l_knee'], ['l_knee', 'l_ankle'],
    ['hips', 'r_knee'], ['r_knee', 'r_ankle'],
  ];

  const handlePointerDown = (jointId: MixamoJointId) => (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = jointId;
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const jointId = draggingRef.current;
    if (!jointId || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

    const updated = { ...markers, [jointId]: { x, y } };

    if (useSymmetry) {
      if (jointId.startsWith('l_')) {
        const rId = ('r_' + jointId.slice(2)) as MixamoJointId;
        if (rId in updated) updated[rId] = { x: 1 - x, y };
      } else if (jointId.startsWith('r_')) {
        const lId = ('l_' + jointId.slice(2)) as MixamoJointId;
        if (lId in updated) updated[lId] = { x: 1 - x, y };
      }
    }
    onMarkersChange(updated);
  };

  const handlePointerUp = () => { draggingRef.current = null; };
  const handleReset = () => onMarkersChange({ ...DEFAULT_MIXAMO_MARKERS });

  return (
    <div className="rigger-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rigger-modal">

        {/* ── Header ── */}
        <div className="rigger-header">
          <span>AUTO-RIGGER</span>
          <button className="rigger-close" title="Close rigger without changing current model rig state." onClick={onClose}>✕</button>
        </div>

        {/* ── Body ── */}
        <div className="rigger-body">

          {/* ── Left: silhouette guide ── */}
          <div className="rigger-guide">
            <svg viewBox="0 0 1 1" preserveAspectRatio="xMidYMid meet" className="rigger-silhouette-svg">
              {/* Human silhouette */}
              <path d={SILHOUETTE} fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.15)" strokeWidth="0.008" fillRule="evenodd" />
              {/* Vertical centerline */}
              <line x1="0.5" y1="0" x2="0.5" y2="1" stroke="rgba(255,255,255,0.2)" strokeWidth="0.004" strokeDasharray="0.025 0.015" />
            </svg>
          </div>

          {/* ── Divider ── */}
          <div className="rigger-divider-v" />

          {/* ── Center: character + draggable markers ── */}
          <div className="rigger-canvas-wrap">
            <div className="rigger-sprite-container">
              <img src={imageUrl} alt="Sprite" draggable={false} />
              <svg
                ref={svgRef}
                className="rigger-svg"
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerLeave={handlePointerUp}
              >
                {/* Vertical centerline */}
                <line x1="50%" y1="0" x2="50%" y2="100%"
                  stroke="rgba(255,255,255,0.25)" strokeWidth="1"
                  strokeDasharray="6 4" style={{ pointerEvents: 'none' }} />

                {/* Skeleton bone preview lines */}
                {boneLines.map(([a, b]) => {
                  const ja = derived[a as keyof typeof derived];
                  const jb = derived[b as keyof typeof derived];
                  return (
                    <line
                      key={`${a}-${b}`}
                      x1={`${ja.x * 100}%`} y1={`${ja.y * 100}%`}
                      x2={`${jb.x * 100}%`} y2={`${jb.y * 100}%`}
                      stroke="rgba(255,255,255,0.18)" strokeWidth="1.5"
                      style={{ pointerEvents: 'none' }}
                    />
                  );
                })}

                {/* Marker circles */}
                {(Object.keys(markers) as MixamoJointId[]).map(jointId => {
                  const m = markers[jointId];
                  const meta = MIXAMO_META[jointId];
                  return (
                    <g key={jointId}>
                      <title>{meta.label || jointId.replace('_', ' ')}</title>
                      <circle
                        cx={`${m.x * 100}%`} cy={`${m.y * 100}%`}
                        r={11}
                        fill="rgba(0,0,0,0.4)"
                        stroke={meta.color}
                        strokeWidth={2.5}
                        style={{ cursor: 'grab' }}
                        onPointerDown={handlePointerDown(jointId)}
                      />
                      <circle
                        cx={`${m.x * 100}%`} cy={`${m.y * 100}%`}
                        r={3.5}
                        fill={meta.color}
                        style={{ pointerEvents: 'none' }}
                      />
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>

          {/* ── Right sidebar ── */}
          <div className="rigger-sidebar">
            <h4>Place markers</h4>
            <p className="rigger-hint">
              Drag the circles onto the corresponding body parts of your character.
            </p>

            <div className="rigger-divider" />

            {/* Marker list — paired circles side by side */}
            <div className="rigger-joint-list">
              {MIXAMO_SIDEBAR_ORDER.map(jointId => {
                const meta = MIXAMO_META[jointId];
                const pairId = meta.pair;
                return (
                  <div key={jointId} className="joint-row">
                    <span className="joint-label">{meta.label}</span>
                    <div className="joint-circles">
                      {pairId && (
                        <div
                          className="joint-circle"
                          style={{ borderColor: meta.color }}
                          title={`${pairId.replace('_', ' ')} marker; affects that limb deformation.`}
                        />
                      )}
                      <div
                        className="joint-circle"
                        style={{ borderColor: meta.color, background: meta.color + '33' }}
                        title={`${jointId.replace('_', ' ')} marker; affects local rig bending.`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="rigger-divider" />

            <label className="rigger-symmetry">
              <input
                type="checkbox"
                title="Mirror left/right marker moves to keep symmetric rig deformation."
                checked={useSymmetry}
                onChange={e => onSymmetryChange(e.target.checked)}
              />
              Use Symmetry
            </label>

            <div className="rigger-actions">
              <button className="rigger-build-btn" title="Build skeleton and skin weights from current markers; enables model animation." onClick={onBuild}>Build Rig</button>
              <button className="rigger-reset-btn" title="Reset markers to default positions; restores default rig layout." onClick={handleReset}>Reset Markers</button>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
