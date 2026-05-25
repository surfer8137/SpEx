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

// Mixamo-safe OBJ ZIP — bakes all face materials into one horizontal atlas texture,
// remaps UVs per group, flips V for OBJ convention. Single material = Mixamo compatible.
export function exportOBJMixamoSafe(mesh: THREE.Mesh): void {
  const srcMats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[];
  const N = srcMats.length;

  // 1. Build atlas: one horizontal slot per material (texture or flat color).
  const firstCanvas = srcMats[0]?.map?.image as HTMLCanvasElement | undefined;
  const slotW = firstCanvas?.width ?? 512;
  const atlasH = firstCanvas?.height ?? 512;
  const atlasCanvas = document.createElement('canvas');
  atlasCanvas.width = slotW * N;
  atlasCanvas.height = atlasH;
  const ctx = atlasCanvas.getContext('2d')!;

  for (let i = 0; i < N; i++) {
    const mat = srcMats[i];
    const img = mat.map?.image as HTMLCanvasElement | undefined;
    if (img) {
      ctx.drawImage(img, i * slotW, 0, slotW, atlasH);
    } else {
      const c = mat.color ?? new THREE.Color(1, 1, 1);
      ctx.fillStyle = `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
      ctx.fillRect(i * slotW, 0, slotW, atlasH);
    }
  }

  // 2. toNonIndexed so each group has independent verts — no UV aliasing on shared edges.
  const geoForExport = mesh.geometry.toNonIndexed();

  // 3. Remap UVs: each group → its atlas slot; flip V for OBJ convention.
  const uvAttr = geoForExport.attributes.uv as THREE.BufferAttribute;
  const uvArr = uvAttr.array as Float32Array;
  const uScale = 1 / N;

  for (const group of geoForExport.groups) {
    const mi = group.materialIndex ?? 0;
    const u0 = mi * uScale;
    for (let j = group.start; j < group.start + group.count; j++) {
      uvArr[j * 2]     = u0 + uvArr[j * 2] * uScale;  // remap to atlas slot
      uvArr[j * 2 + 1] = 1 - uvArr[j * 2 + 1];        // V-flip (OBJ convention)
    }
  }
  uvAttr.needsUpdate = true;

  // 4. Single material with atlas texture.
  const safeMat = new THREE.MeshStandardMaterial({
    name: 'material_0',
    map: new THREE.CanvasTexture(atlasCanvas),
    color: new THREE.Color(1, 1, 1),
    transparent: false,
    opacity: 1,
  });

  const tempMesh = new THREE.Mesh(geoForExport, safeMat);
  tempMesh.name = mesh.name || 'model';

  const exporter = new OBJExporter();
  const rawObj = exporter.parse(tempMesh);
  const obj = `mtllib model.mtl\n${rawObj}`;

  const mtl = [
    'newmtl material_0',
    'Kd 1.000000 1.000000 1.000000',
    'd 1.000000',
    'map_Kd texture.png',
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
    files['texture.png'] = await canvasToUint8(atlasCanvas);
    zip(files, (err, data) => {
      if (!err) downloadBlob(new Blob([data], { type: 'application/zip' }), 'model_mixamo_safe.zip');
    });
  };

  bundle();
}


// Cut-out GLB — each material group becomes its own named Mesh node (no skinning).
// Pivot is the centroid of each panel. Flat scene hierarchy under a root Group.
// Animate each node's position/rotation independently in your engine.
export function exportGLBCutout(mesh: THREE.Mesh): void {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const geo  = mesh.geometry;
  const idxAttr  = geo.index;
  const posAttr  = geo.attributes.position as THREE.BufferAttribute;
  const normAttr = geo.attributes.normal   as THREE.BufferAttribute | undefined;
  const uvAttr   = geo.attributes.uv       as THREE.BufferAttribute | undefined;

  const FACE_NAMES = ['front', 'back', 'right', 'left', 'top', 'bottom'];

  const root = new THREE.Group();
  root.name  = 'cutout_root';

  for (const group of geo.groups) {
    if (group.count === 0) continue;
    const mi       = group.materialIndex ?? 0;
    const faceName = FACE_NAMES[mi] ?? `face_${mi}`;

    // Collect unique old→new vertex index mapping for this group.
    const remap  = new Map<number, number>();
    const newIdx: number[] = [];
    for (let i = group.start; i < group.start + group.count; i++) {
      const vi = idxAttr ? idxAttr.getX(i) : i;
      if (!remap.has(vi)) remap.set(vi, remap.size);
      newIdx.push(remap.get(vi)!);
    }

    const n = remap.size;
    const pos  = new Float32Array(n * 3);
    const norm = normAttr ? new Float32Array(n * 3) : null;
    const uv   = uvAttr   ? new Float32Array(n * 2) : null;

    for (const [oldVi, newVi] of remap) {
      pos[newVi*3]   = posAttr.getX(oldVi);
      pos[newVi*3+1] = posAttr.getY(oldVi);
      pos[newVi*3+2] = posAttr.getZ(oldVi);
      if (norm && normAttr) {
        norm[newVi*3]   = normAttr.getX(oldVi);
        norm[newVi*3+1] = normAttr.getY(oldVi);
        norm[newVi*3+2] = normAttr.getZ(oldVi);
      }
      if (uv && uvAttr) {
        uv[newVi*2]   = uvAttr.getX(oldVi);
        uv[newVi*2+1] = uvAttr.getY(oldVi);
      }
    }

    // Centroid = pivot point of this panel.
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += pos[i*3]; cy += pos[i*3+1]; cz += pos[i*3+2]; }
    cx /= n; cy /= n; cz /= n;

    // Shift vertices so pivot is at local origin.
    for (let i = 0; i < n; i++) { pos[i*3] -= cx; pos[i*3+1] -= cy; pos[i*3+2] -= cz; }

    const panelGeo = new THREE.BufferGeometry();
    panelGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (norm) panelGeo.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
    if (uv)   panelGeo.setAttribute('uv',     new THREE.BufferAttribute(uv, 2));
    panelGeo.setIndex(newIdx);

    const panelMesh = new THREE.Mesh(panelGeo, mats[mi] ?? mats[0]);
    panelMesh.name = faceName;
    panelMesh.position.set(cx, cy, cz); // node sits at centroid in world space

    root.add(panelMesh);
  }

  const exporter = new GLTFExporter();
  exporter.parse(
    root,
    (result) => downloadBlob(new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' }), 'model_cutout.glb'),
    (err) => console.error('GLB cutout export error:', err),
    { binary: true },
  );
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
