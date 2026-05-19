'use client';
import * as THREE from 'three';
import { exportGLB, exportOBJ } from '../lib/exporters';

interface Props {
  mesh: THREE.Mesh | null;
}

function formatBytes(n: number): string {
  if (n >= 1_048_576) return `~${(n / 1_048_576).toFixed(1)} MB`;
  return `~${Math.round(n / 1024)} KB`;
}

function estimateSizes(mesh: THREE.Mesh): { glb: number; obj: number } {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const idx = geo.index;

  const geomBytes =
    (pos?.array.byteLength ?? 0) +
    (geo.attributes.normal?.array.byteLength ?? 0) +
    (geo.attributes.uv?.array.byteLength ?? 0) +
    (geo.attributes.color?.array.byteLength ?? 0) +
    (idx?.array.byteLength ?? 0);

  const vertCount = pos?.count ?? 0;
  const indexCount = idx?.count ?? 0;

  // Estimate PNG size per unique canvas (~25% of raw RGBA — sprites compress well)
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  let texBytes = 0;
  const seen = new Set<HTMLCanvasElement>();
  for (const mat of mats) {
    const canvas = (mat as THREE.MeshStandardMaterial)?.map?.image as HTMLCanvasElement | undefined;
    if (canvas && !seen.has(canvas)) {
      seen.add(canvas);
      texBytes += canvas.width * canvas.height * 4 * 0.25;
    }
  }

  // GLB: geometry binary chunks + JSON header (~4 KB) + embedded texture
  const glb = geomBytes + 4096 + texBytes;

  // OBJ text: ~85 bytes per vertex (v/vn/vt lines) + ~20 bytes per tri (f line)
  // ZIP compresses text to ~40%; texture PNG doesn't compress further
  const objText = vertCount * 85 + (indexCount / 3) * 20;
  const obj = objText * 0.4 + texBytes + 1024;

  return { glb, obj };
}

export default function ExportButtons({ mesh }: Props) {
  const sizes = mesh ? estimateSizes(mesh) : null;

  return (
    <div className="export-buttons">
      <div className="export-col">
        <button disabled={!mesh} onClick={() => mesh && exportGLB(mesh)}>
          Export GLB
        </button>
        {sizes && <span className="export-size">{formatBytes(sizes.glb)}</span>}
      </div>
      <div className="export-col">
        <button disabled={!mesh} onClick={() => mesh && exportOBJ(mesh)}>
          Export OBJ
        </button>
        {sizes && <span className="export-size">{formatBytes(sizes.obj)}</span>}
      </div>
    </div>
  );
}
