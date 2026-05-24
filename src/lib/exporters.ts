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
  const srcMats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[];
  // Clone materials and set deterministic names so usemtl in OBJ always matches model.mtl.
  const namedMats = srcMats.map((m, i) => {
    const c = m.clone() as THREE.MeshStandardMaterial;
    c.name = `material_${i}`;
    return c;
  });

  const tempMesh = new THREE.Mesh(mesh.geometry, namedMats);
  tempMesh.name = mesh.name || 'model';

  const exporter = new OBJExporter();
  const rawObj = exporter.parse(tempMesh);
  const obj = `mtllib model.mtl\n${rawObj}`;

  // Build classic MTL (Mixamo is more reliable with map_Kd than PBR extensions).
  const mtlLines: string[] = [];
  namedMats.forEach((mat, i) => {
    const texFile = `texture_${i}.png`;
    const kd = mat.color ?? new THREE.Color(1, 1, 1);
    mtlLines.push(
      `newmtl material_${i}`,
      `Kd ${kd.r.toFixed(6)} ${kd.g.toFixed(6)} ${kd.b.toFixed(6)}`,
      `d ${mat.opacity !== undefined ? mat.opacity.toFixed(6) : '1.000000'}`,
      ...(mat.map ? [`map_Kd ${texFile}`] : []),
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

  const getCanvas = (tex: THREE.Texture | null | undefined) => tex?.image as HTMLCanvasElement | undefined;

  const bundle = async () => {
    // One base texture per material when present.
    for (let i = 0; i < namedMats.length; i++) {
      const c = getCanvas(namedMats[i].map);
      if (c) files[`texture_${i}.png`] = await canvasToUint8(c);
    }

    zip(files, (err, data) => {
      if (!err) downloadBlob(new Blob([data], { type: 'application/zip' }), 'model.zip');
    });
  };

  bundle();
}

// Mixamo-safe OBJ ZIP — forces a single material + single map_Kd texture.
export function exportOBJMixamoSafe(mesh: THREE.Mesh): void {
  const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[];
  const firstMat = mats[0] as THREE.MeshStandardMaterial | undefined;

  const safeMat = new THREE.MeshStandardMaterial({
    name: 'material_0',
    map: firstMat?.map ?? null,
    color: firstMat?.color ?? new THREE.Color(1, 1, 1),
    transparent: false,
    opacity: 1,
  });

  const tempMesh = new THREE.Mesh(mesh.geometry, safeMat);
  tempMesh.name = mesh.name || 'model';
  // Mixamo often interprets forward axis opposite to our viewport convention.
  // Rotate 180° on Y for upload-facing orientation.
  tempMesh.rotation.y = Math.PI;
  tempMesh.updateMatrixWorld(true);

  const exporter = new OBJExporter();
  const rawObj = exporter.parse(tempMesh);
  const obj = `mtllib model.mtl\n${rawObj}`;

  const kd = safeMat.color ?? new THREE.Color(1, 1, 1);
  const mtl = [
    'newmtl material_0',
    `Kd ${kd.r.toFixed(6)} ${kd.g.toFixed(6)} ${kd.b.toFixed(6)}`,
    'd 1.000000',
    ...(safeMat.map ? ['map_Kd texture.png'] : []),
    '',
  ].join('\n');

  const enc = new TextEncoder();
  const files: Record<string, Uint8Array> = {
    'model.obj': enc.encode(obj),
    'model.mtl': enc.encode(mtl),
  };

  const canvasToUint8 = (canvas: HTMLCanvasElement): Promise<Uint8Array> =>
    new Promise((resolve) =>
      canvas.toBlob((blob) => {
        if (!blob) { resolve(new Uint8Array()); return; }
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)));
      }, 'image/png'),
    );

  const bundle = async () => {
    const canvas = safeMat.map?.image as HTMLCanvasElement | undefined;
    if (canvas) files['texture.png'] = await canvasToUint8(canvas);
    zip(files, (err, data) => {
      if (!err) downloadBlob(new Blob([data], { type: 'application/zip' }), 'model_mixamo_safe.zip');
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
