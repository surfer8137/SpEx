import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { zip } from 'fflate';

// GLB — all textures embedded (base, normal, roughness, metalness). Unity-ready via GLTFast.
export function exportGLB(mesh: THREE.Mesh): void {
  const exporter = new GLTFExporter();
  exporter.parse(
    mesh,
    (result) => {
      downloadBlob(new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' }), 'model.glb');
    },
    (error) => console.error('GLB export error:', error),
    { binary: true },
  );
}

// OBJ ZIP — bundles OBJ + PBR MTL + all texture PNGs into model.zip.
export function exportOBJ(mesh: THREE.Mesh): void {
  const exporter = new OBJExporter();
  const rawObj = exporter.parse(mesh);
  const obj = `mtllib model.mtl\n${rawObj}`;

  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const hasBackMat = mats.length >= 3;

  // Collect PBR maps from first material (shared across sub-meshes)
  const firstMat = mats[0] as THREE.MeshStandardMaterial;
  const hasMaps = {
    normal:    !!firstMat?.normalMap,
    roughness: !!firstMat?.roughnessMap,
    metalness: !!firstMat?.metalnessMap,
  };

  // Build PBR-compatible MTL
  const mtlLines: string[] = [];
  mats.forEach((mat, i) => {
    const isBack = hasBackMat && i === 1;
    const baseTex = isBack ? 'back_texture.png' : 'texture.png';
    mtlLines.push(
      `newmtl material_${i}`,
      `map_Kd ${baseTex}`,
      ...(hasMaps.normal    ? [`norm normal_map.png`, `map_Bump normal_map.png`] : []),
      ...(hasMaps.roughness ? [`map_Pr roughness_map.png`] : []),
      ...(hasMaps.metalness ? [`map_Pm metallic_map.png`]  : []),
      '',
    );
  });

  const enc = new TextEncoder();
  const files: Record<string, Uint8Array> = {
    'model.obj': enc.encode(obj),
    'model.mtl': enc.encode(mtlLines.join('\n')),
  };

  const canvasToUint8 = (canvas: HTMLCanvasElement): Promise<Uint8Array> =>
    new Promise((resolve) =>
      canvas.toBlob((blob) => {
        if (!blob) { resolve(new Uint8Array()); return; }
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)));
      }, 'image/png'),
    );

  const getCanvas = (tex: THREE.Texture | null | undefined) =>
    tex?.image as HTMLCanvasElement | undefined;

  const bundle = async () => {
    // Base textures
    const frontCanvas = getCanvas(firstMat?.map);
    if (frontCanvas) files['texture.png'] = await canvasToUint8(frontCanvas);

    if (hasBackMat) {
      const backCanvas = getCanvas((mats[1] as THREE.MeshStandardMaterial)?.map);
      if (backCanvas) files['back_texture.png'] = await canvasToUint8(backCanvas);
    }

    // PBR maps (from first material — shared)
    if (hasMaps.normal) {
      const c = getCanvas(firstMat.normalMap);
      if (c) files['normal_map.png'] = await canvasToUint8(c);
    }
    if (hasMaps.roughness) {
      const c = getCanvas(firstMat.roughnessMap);
      if (c) files['roughness_map.png'] = await canvasToUint8(c);
    }
    if (hasMaps.metalness) {
      const c = getCanvas(firstMat.metalnessMap);
      if (c) files['metallic_map.png'] = await canvasToUint8(c);
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
