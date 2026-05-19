import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { zip } from 'fflate';

// GLB embeds textures + normal maps as binary blobs — fully self-contained
export function exportGLB(mesh: THREE.Mesh): void {
  const exporter = new GLTFExporter();
  exporter.parse(
    mesh,
    (result) => {
      const blob = new Blob([result as ArrayBuffer], {
        type: 'model/gltf-binary',
      });
      downloadBlob(blob, 'model.glb');
    },
    (error) => console.error('GLB export error:', error),
    { binary: true },
  );
}

// OBJ bundles all files into model.zip — handles 2-material (shared tex) and 3-material (separate back tex)
export function exportOBJ(mesh: THREE.Mesh): void {
  const exporter = new OBJExporter();
  const rawObj = exporter.parse(mesh);
  const obj = `mtllib model.mtl\n${rawObj}`;

  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const hasBackMat = mats.length >= 3;

  const mtlLines: string[] = [];
  mats.forEach((_, i) => {
    const texName = hasBackMat && i === 1 ? 'back_texture.png' : 'texture.png';
    mtlLines.push(`newmtl material_${i}`, `map_Kd ${texName}`, '');
  });

  const enc = new TextEncoder();
  const files: Record<string, Uint8Array> = {
    'model.obj': enc.encode(obj),
    'model.mtl': enc.encode(mtlLines.join('\n')),
  };

  const getCanvas = (mat: THREE.Material) =>
    (mat as THREE.MeshStandardMaterial)?.map?.image as HTMLCanvasElement | undefined;

  const canvasToUint8 = (canvas: HTMLCanvasElement): Promise<Uint8Array> =>
    new Promise((resolve) =>
      canvas.toBlob((blob) => {
        if (!blob) { resolve(new Uint8Array()); return; }
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)));
      }, 'image/png'),
    );

  const bundle = async () => {
    const frontCanvas = getCanvas(mats[0]);
    if (frontCanvas) files['texture.png'] = await canvasToUint8(frontCanvas);

    if (hasBackMat) {
      const backCanvas = getCanvas(mats[1]);
      if (backCanvas) files['back_texture.png'] = await canvasToUint8(backCanvas);
    }

    zip(files, (err, data) => {
      if (!err) downloadBlob(new Blob([data], { type: 'application/zip' }), 'model.zip');
    });
  };

  bundle();
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
