'use client';
import type { MeshStats } from '../lib/meshBuilder';

interface Props {
  stats: MeshStats;
  activeTol: number | null;   // null = no preset active, sliders rule
  onPreset: (tol: number) => void;
  disabled: boolean;
}

const PRESETS: { label: string; tol: number }[] = [
  { label: 'Ultra', tol: 0.5 },
  { label: 'High',  tol: 1.5 },
  { label: 'Med',   tol: 4   },
  { label: 'Low',   tol: 10  },
];

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export default function MeshStatsPanel({ stats, activeTol, onPreset, disabled }: Props) {
  return (
    <div className="stats-panel">
      <h3>Mesh Stats</h3>

      <div className="stats-grid">
        <span className="stat-label">Triangles</span>
        <span className="stat-value">{fmt(stats.triangles)}</span>

        <span className="stat-label">Vertices</span>
        <span className="stat-value">{fmt(stats.vertices)}</span>

        <span className="stat-label">Contour pts</span>
        <span className="stat-value">{stats.contourPts}</span>

        <span className="stat-label">Holes</span>
        <span className="stat-value">{stats.holes}</span>
      </div>

      <div className="poly-presets">
        <span className="preset-label">
          Quick poly level
          {activeTol !== null && (
            <span className="preset-active-hint"> (override active)</span>
          )}
        </span>
        <div className="preset-buttons">
          {PRESETS.map(({ label, tol }) => (
            <button
              key={label}
              className={`preset-btn ${activeTol === tol ? 'active' : ''}`}
              onClick={() => onPreset(tol)}
              disabled={disabled}
              title={`Simplify tolerance ${tol} — sliders unchanged`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
