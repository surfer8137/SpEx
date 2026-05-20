'use client';

import { useMemo, useState, useCallback } from 'react';
import type { FaceMode } from '../types';

type FaceName = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

const FACE_LABELS: Record<FaceName, string> = {
  front:  '🔵 Front',
  back:   '🟢 Back',
  left:   '🟠 Left',
  right:  '🔴 Right',
  top:    '🟣 Top',
  bottom: '🟡 Bottom',
};

function getFaces(faceMode: FaceMode): FaceName[] {
  if (faceMode === 'front')            return ['front'];
  if (faceMode === 'front-back')       return ['front', 'back'];
  if (faceMode === 'front-back-lr')    return ['front', 'back', 'left', 'right'];
  return ['front', 'back', 'left', 'right', 'top', 'bottom'];
}

/** Default grid that fits the face count nicely */
function defaultGrid(n: number): { cols: number; rows: number } {
  if (n <= 1)  return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n <= 4)  return { cols: 2, rows: 2 };
  return { cols: 3, rows: 2 };
}

function sliceTileUrl(src: HTMLCanvasElement, sx: number, sy: number, sw: number, sh: number): string {
  const c = document.createElement('canvas');
  c.width = sw; c.height = sh;
  c.getContext('2d')!.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
  return c.toDataURL();
}

function sliceTileData(src: HTMLCanvasElement, sx: number, sy: number, sw: number, sh: number): ImageData {
  const c = document.createElement('canvas');
  c.width = sw; c.height = sh;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
  return ctx.getImageData(0, 0, sw, sh);
}

interface Props {
  imageData: ImageData;
  faceMode: FaceMode;
  onConfirm: (faces: Partial<Record<FaceName, ImageData>>) => void;
  onClose: () => void;
}

export default function AtlasMapperModal({ imageData, faceMode, onConfirm, onClose }: Props) {
  const faces = useMemo(() => getFaces(faceMode), [faceMode]);
  const n = faces.length;

  const def = useMemo(() => defaultGrid(n), [n]);
  const [cols, setCols] = useState(def.cols);
  const [rows, setRows] = useState(def.rows);
  const [assignments, setAssignments] = useState<Partial<Record<FaceName, number>>>({});
  const [dragTile, setDragTile]       = useState<number | null>(null);

  const srcCanvas = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = imageData.width; c.height = imageData.height;
    c.getContext('2d')!.putImageData(imageData, 0, 0);
    return c;
  }, [imageData]);

  const tiles = useMemo(() => {
    const { width, height } = imageData;
    const tW = Math.max(1, Math.floor(width  / cols));
    const tH = Math.max(1, Math.floor(height / rows));
    return Array.from({ length: cols * rows }, (_, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const sx  = col * tW;
      const sy  = row * tH;
      return { sx, sy, sw: tW, sh: tH, url: sliceTileUrl(srcCanvas, sx, sy, tW, tH) };
    });
  }, [imageData, cols, rows, srcCanvas]);

  // Reset assignments when grid changes (tile indices no longer valid)
  const setGrid = useCallback((c: number, r: number) => {
    setCols(c); setRows(r);
    setAssignments({});
  }, []);

  const assign = useCallback((face: FaceName, idx: number) => {
    setAssignments(prev => ({ ...prev, [face]: idx }));
  }, []);

  const clearFace = useCallback((face: FaceName) => {
    setAssignments(prev => { const n = { ...prev }; delete n[face]; return n; });
  }, []);

  const autoAssign = useCallback(() => {
    const auto: Partial<Record<FaceName, number>> = {};
    faces.forEach((f, i) => { if (i < tiles.length) auto[f] = i; });
    setAssignments(auto);
  }, [faces, tiles]);

  const allAssigned = faces.every(f => assignments[f] !== undefined);

  const handleConfirm = useCallback(() => {
    const result: Partial<Record<FaceName, ImageData>> = {};
    for (const face of faces) {
      const idx = assignments[face];
      if (idx !== undefined) {
        const t = tiles[idx];
        if (t) result[face] = sliceTileData(srcCanvas, t.sx, t.sy, t.sw, t.sh);
      }
    }
    onConfirm(result);
  }, [faces, assignments, tiles, srcCanvas, onConfirm]);

  const assignedCount = faces.filter(f => assignments[f] !== undefined).length;

  return (
    <div className="atlas-overlay" onClick={onClose}>
      <div className="atlas-modal" onClick={e => e.stopPropagation()}>

        {/* ── Header ── */}
        <div className="atlas-header">
          <h3>Assign Atlas Tiles</h3>

          <div className="atlas-grid-controls">
            <span>Grid:</span>
            <div className="atlas-grid-input-group">
              <input
                type="number"
                className="atlas-grid-input"
                value={cols}
                min={1} max={16}
                onChange={e => setGrid(Math.max(1, Math.min(16, parseInt(e.target.value) || 1)), rows)}
                title="Columns"
              />
              <span className="atlas-grid-sep">×</span>
              <input
                type="number"
                className="atlas-grid-input"
                value={rows}
                min={1} max={16}
                onChange={e => setGrid(cols, Math.max(1, Math.min(16, parseInt(e.target.value) || 1)))}
                title="Rows"
              />
            </div>
            <span className="atlas-grid-count">{cols * rows} tiles</span>
          </div>

          <button className="atlas-close-btn" onClick={onClose}>✕</button>
        </div>

        {/* ── Body ── */}
        <div className="atlas-body">

          {/* Tiles */}
          <div className="atlas-tiles-panel">
            <p className="atlas-hint">Drag tiles → face slots on the right</p>

            <div
              className="atlas-tiles-grid"
              style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
            >
              {tiles.map((tile, i) => (
                <div
                  key={i}
                  className="atlas-tile"
                  draggable
                  data-active={dragTile === i}
                  onDragStart={e => { setDragTile(i); e.dataTransfer.effectAllowed = 'copy'; }}
                  onDragEnd={() => setDragTile(null)}
                >
                  <img src={tile.url} alt={`${i}`} draggable={false} />
                  <span className="atlas-tile-idx">{i}</span>
                </div>
              ))}
            </div>

            <button className="atlas-auto-btn" onClick={autoAssign}>
              Auto-assign first {Math.min(n, tiles.length)} tiles → ({faces.slice(0, tiles.length).join(' · ')})
            </button>
          </div>

          {/* Face slots */}
          <div className="atlas-faces-panel">
            {faces.map(face => {
              const idx = assignments[face];
              const hasTile = idx !== undefined;
              return (
                <div
                  key={face}
                  className={`atlas-face-slot ${hasTile ? 'assigned' : 'empty'}`}
                  onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
                  onDrop={e => { e.preventDefault(); if (dragTile !== null) assign(face, dragTile); setDragTile(null); }}
                >
                  <span className="atlas-face-label">{FACE_LABELS[face]}</span>
                  {hasTile ? (
                    <div className="atlas-face-preview">
                      <img src={tiles[idx!]?.url} alt="" draggable={false} />
                      <button className="atlas-face-clear" onClick={() => clearFace(face)}>×</button>
                    </div>
                  ) : (
                    <div className="atlas-drop-zone">Drop here</div>
                  )}
                </div>
              );
            })}
          </div>

        </div>

        {/* ── Footer ── */}
        <div className="atlas-footer">
          <button className="atlas-cancel-btn" onClick={onClose}>Cancel</button>
          <button
            className="atlas-confirm-btn"
            onClick={handleConfirm}
            disabled={!allAssigned}
            title={!allAssigned ? `${assignedCount}/${n} faces assigned` : ''}
          >
            Confirm {allAssigned ? '✓' : `(${assignedCount}/${n})`}
          </button>
        </div>

      </div>
    </div>
  );
}
