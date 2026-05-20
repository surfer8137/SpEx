'use client';

import { useRef, useCallback } from 'react';
import type { FaceName, FaceOffset, FaceOffsets, FaceMode } from '../types';

// ── Face meta ─────────────────────────────────────────────────────────────────
const FACE_META: Record<FaceName, {
  label: string;
  emoji: string;
  padX: 'x' | 'y' | 'z';
  padY: 'x' | 'y' | 'z';
  depth: 'x' | 'y' | 'z';
  depthPositive: boolean;
}> = {
  front:  { label: 'Front',  emoji: '🔵', padX: 'x', padY: 'y', depth: 'z', depthPositive: true  },
  back:   { label: 'Back',   emoji: '🟢', padX: 'x', padY: 'y', depth: 'z', depthPositive: false },
  left:   { label: 'Left',   emoji: '🟠', padX: 'z', padY: 'y', depth: 'x', depthPositive: false },
  right:  { label: 'Right',  emoji: '🔴', padX: 'z', padY: 'y', depth: 'x', depthPositive: true  },
  top:    { label: 'Top',    emoji: '🟣', padX: 'x', padY: 'z', depth: 'y', depthPositive: true  },
  bottom: { label: 'Bottom', emoji: '🟡', padX: 'x', padY: 'z', depth: 'y', depthPositive: false },
};

function getFaces(faceMode: FaceMode): FaceName[] {
  if (faceMode === 'front')            return ['front'];
  if (faceMode === 'front-back')       return ['front', 'back'];
  if (faceMode === 'front-back-lr')    return ['front', 'back', 'left', 'right'];
  return ['front', 'back', 'left', 'right', 'top', 'bottom'];
}

const ZERO: FaceOffset = { x: 0, y: 0, z: 0 };

// ── Drag pad: 2-axis XY offset ────────────────────────────────────────────────
function DragPad({
  axisH, axisV,
  offset, onChange, disabled,
}: {
  axisH: 'x' | 'y' | 'z';
  axisV: 'x' | 'y' | 'z';
  offset: FaceOffset;
  onChange: (o: FaceOffset) => void;
  disabled: boolean;
}) {
  const padRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const SIZE = 80;
  const RANGE = 0.5;

  const toScreen = (v: number) => (v / RANGE) * (SIZE / 2) + SIZE / 2;
  const fromDelta = (px: number) => (px / (SIZE / 2)) * RANGE;

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (disabled) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = true;
  }, [disabled]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current || !padRef.current) return;
    const rect = padRef.current.getBoundingClientRect();
    const cx = rect.left + SIZE / 2;
    const cy = rect.top  + SIZE / 2;
    const dx = Math.max(-RANGE, Math.min(RANGE, fromDelta(e.clientX - cx)));
    const dy = Math.max(-RANGE, Math.min(RANGE, fromDelta(-(e.clientY - cy))));
    onChange({ ...offset, [axisH]: +dx.toFixed(3), [axisV]: +dy.toFixed(3) });
  }, [offset, onChange, axisH, axisV]);

  const onPointerUp = useCallback(() => { dragging.current = false; }, []);

  const dotX = toScreen(offset[axisH]);
  const dotY = toScreen(-offset[axisV]);

  return (
    <div
      ref={padRef}
      className="fe-pad"
      style={{ width: SIZE, height: SIZE, opacity: disabled ? 0.4 : 1 }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      <div className="fe-pad-h" />
      <div className="fe-pad-v" />
      <div className="fe-pad-dot" style={{ left: dotX - 6, top: dotY - 6 }} />
      <span className="fe-pad-label fe-pad-right">{axisH.toUpperCase()}</span>
      <span className="fe-pad-label fe-pad-top">{axisV.toUpperCase()}</span>
    </div>
  );
}

// ── Number input for a single axis ───────────────────────────────────────────
function AxisInput({
  axis, label, value, onChange, disabled,
}: {
  axis: 'x' | 'y' | 'z';
  label: string;
  value: number;
  onChange: (v: number) => void;
  disabled: boolean;
}) {
  return (
    <label className="fe-axis-row">
      <span className="fe-axis-label">{label}</span>
      <input
        className="fe-axis-input"
        type="number"
        min={-2} max={2} step={0.001}
        value={value.toFixed(3)}
        disabled={disabled}
        onChange={e => {
          const v = parseFloat(e.target.value);
          if (!isNaN(v)) onChange(+v.toFixed(3));
        }}
      />
    </label>
  );
}

// ── Single face card ──────────────────────────────────────────────────────────
function FaceCard({
  face, offset, onChange, disabled, thumbnail, weldFaces,
}: {
  face: FaceName;
  offset: FaceOffset;
  onChange: (o: FaceOffset) => void;
  disabled: boolean;
  thumbnail?: string;
  weldFaces: boolean;
}) {
  const meta = FACE_META[face];
  const depth = offset[meta.depth] ?? 0;

  const setAxis = useCallback((axis: 'x' | 'y' | 'z', v: number) => {
    onChange({ ...offset, [axis]: v });
  }, [offset, onChange]);

  const setDepth = useCallback((v: number) => {
    onChange({ ...offset, [meta.depth]: +v.toFixed(3) });
  }, [offset, onChange, meta.depth]);

  const reset = useCallback(() => onChange(ZERO), [onChange]);

  const hasOffset = offset.x !== 0 || offset.y !== 0 || offset.z !== 0;

  return (
    <div className={`fe-card ${hasOffset ? 'fe-card-active' : ''}`}>
      <div className="fe-card-header">
        <span>{meta.emoji} {meta.label}</span>
        {hasOffset && (
          <button className="fe-reset-btn" onClick={reset} title="Reset offsets">↺</button>
        )}
      </div>

      {thumbnail && (
        <img className="fe-thumb" src={thumbnail} alt={face} draggable={false} />
      )}

      {/* In-plane drag pad — hidden in weld mode (only depth matters for closed box) */}
      {!weldFaces && (
        <div className="fe-controls">
          <DragPad
            axisH={meta.padX}
            axisV={meta.padY}
            offset={offset}
            onChange={onChange}
            disabled={disabled}
          />

          <div className="fe-depth">
            <span className="fe-depth-label">↕ {meta.depth.toUpperCase()} (depth)</span>
            <input
              type="range"
              min={-0.5} max={0.5} step={0.005}
              value={depth}
              disabled={disabled}
              onChange={e => setDepth(parseFloat(e.target.value))}
            />
            <span className="fe-depth-val">{depth >= 0 ? '+' : ''}{depth.toFixed(3)}</span>
          </div>
        </div>
      )}

      {/* Numeric inputs — always show */}
      {weldFaces ? (
        /* Weld mode: only the depth axis matters */
        <div className="fe-num-row">
          <AxisInput
            axis={meta.depth}
            label={`${meta.depth.toUpperCase()} (depth)`}
            value={offset[meta.depth]}
            onChange={v => setAxis(meta.depth, v)}
            disabled={disabled}
          />
        </div>
      ) : (
        /* Free mode: X/Y/Z all editable */
        <div className="fe-num-row">
          <AxisInput axis="x" label="X" value={offset.x} onChange={v => setAxis('x', v)} disabled={disabled} />
          <AxisInput axis="y" label="Y" value={offset.y} onChange={v => setAxis('y', v)} disabled={disabled} />
          <AxisInput axis="z" label="Z" value={offset.z} onChange={v => setAxis('z', v)} disabled={disabled} />
        </div>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────
interface Props {
  faceMode: FaceMode;
  offsets: FaceOffsets;
  thumbnails?: Partial<Record<FaceName, string>>;
  onChange: (offsets: FaceOffsets) => void;
  disabled: boolean;
  weldFaces: boolean;
  onWeldChange: (v: boolean) => void;
}

export default function FaceEditorPanel({
  faceMode, offsets, thumbnails, onChange, disabled, weldFaces, onWeldChange,
}: Props) {
  const faces = getFaces(faceMode);

  const setFaceOffset = useCallback((face: FaceName, o: FaceOffset) => {
    onChange({ ...offsets, [face]: o });
  }, [offsets, onChange]);

  const resetAll = useCallback(() => onChange({}), [onChange]);

  const anyOffset = Object.values(offsets).some(
    o => o && (o.x !== 0 || o.y !== 0 || o.z !== 0),
  );

  return (
    <aside className="face-editor-panel">
      <div className="fe-header">
        <h3>Face Editor</h3>
        {anyOffset && (
          <button className="fe-reset-all-btn" onClick={resetAll}>Reset all</button>
        )}
      </div>

      {/* Weld toggle */}
      <label className="fe-weld-toggle">
        <input
          type="checkbox"
          checked={weldFaces}
          onChange={e => onWeldChange(e.target.checked)}
        />
        <span>🔗 Weld faces (close gaps)</span>
      </label>

      <p className="fe-hint">
        {weldFaces
          ? 'Weld ON — depth offset pushes/pulls each face plane; edges stay connected.'
          : 'Drag pad → move face in its plane.\nSlider / numbers → push/pull along normal.'}
      </p>

      <div className="fe-cards">
        {faces.map(face => (
          <FaceCard
            key={face}
            face={face}
            offset={offsets[face] ?? ZERO}
            onChange={o => setFaceOffset(face, o)}
            disabled={disabled}
            thumbnail={thumbnails?.[face]}
            weldFaces={weldFaces}
          />
        ))}
      </div>
    </aside>
  );
}
