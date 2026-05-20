import * as THREE from 'three';
import earcut from 'earcut';
import type { ContourResult, Contour2D } from './contourExtractor';
import type { SideMode, FaceMode } from '../types';
import { makeNormalMap } from './normalMapGen';

export interface MeshStats {
  triangles: number;
  vertices: number;   // geometry positions (includes side duplicates)
  contourPts: number; // outer + holes combined
  holes: number;
}

export interface MeshOptions {
  depth: number;
  scale: number;
  sideMode: SideMode;
  sideColor: string;
  faceMode?: FaceMode;
  // Procedural normal map (Sobel) — used when no uploadedNormalMap
  normalMapEnabled: boolean;
  normalMapStrength: number;
  backImageData?: ImageData;
  sideImages?: {
    right?: ImageData;
    left?: ImageData;
    top?: ImageData;
    bottom?: ImageData;
  };
  reliefEnabled: boolean;
  reliefStrength: number;
  // Uploaded PBR maps — override procedural when present
  uploadedNormalMap?: ImageData;
  uploadedRoughnessMap?: ImageData;
  uploadedMetallicMap?: ImageData;
}

// ── Relief helpers ────────────────────────────────────────────────────────────

function lumAt(x: number, y: number, data: Uint8ClampedArray, w: number, h: number): number {
  const xi = Math.min(Math.max(Math.round(x), 0), w - 1);
  const yi = Math.min(Math.max(Math.round(y), 0), h - 1);
  const i = (yi * w + xi) * 4;
  return (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
}

function sobelAt(
  px: number, py: number,
  data: Uint8ClampedArray, w: number, h: number,
): { gx: number; gy: number; mag: number } {
  const L = (x: number, y: number) => lumAt(x, y, data, w, h);
  const gx =
    -L(px-1,py-1) - 2*L(px-1,py) - L(px-1,py+1) +
     L(px+1,py-1) + 2*L(px+1,py) + L(px+1,py+1);
  const gy =
    -L(px-1,py-1) - 2*L(px,py-1) - L(px+1,py-1) +
     L(px-1,py+1) + 2*L(px,py+1) + L(px+1,py+1);
  const mag = Math.min(Math.sqrt(gx * gx + gy * gy), 1);
  return { gx, gy, mag };
}

type RV = { norm: [number, number]; px: [number, number] };

function midRV(A: RV, B: RV): RV {
  return {
    norm: [(A.norm[0] + B.norm[0]) / 2, (A.norm[1] + B.norm[1]) / 2],
    px:   [(A.px[0]  + B.px[0])  / 2, (A.px[1]  + B.px[1])  / 2],
  };
}

function subdivide(tris: Array<[RV, RV, RV]>): Array<[RV, RV, RV]> {
  const next: Array<[RV, RV, RV]> = [];
  for (const [A, B, C] of tris) {
    const AB = midRV(A, B), BC = midRV(B, C), CA = midRV(C, A);
    next.push([A, AB, CA], [AB, B, BC], [CA, BC, C], [AB, BC, CA]);
  }
  return next;
}

function makeTexture(imageData: ImageData): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d')!.putImageData(imageData, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false;
  return tex;
}

function normalize(
  contour: Contour2D,
  cx: number,
  cy: number,
  maxDim: number,
  scale: number,
): Array<[number, number]> {
  return contour.map(([x, y]) => [
    ((x - cx) / maxDim) * scale,
    -((y - cy) / maxDim) * scale,
  ]);
}

// Side UVs: U = cumulative perimeter (0→1 around contour), V = 1 at front / 0 at back.
// Fully parametric — no dependency on pixel coords. Unity-compatible.
function addSideQuads(
  contourPx: Contour2D,
  normCoords: Array<[number, number]>,
  halfZ: number,
  currentVertexCount: number,
  positions: number[],
  normals: number[],
  uvs: number[],
  colors: number[],
  indices: number[],
  colorFn?: (px: number, py: number) => [number, number, number],
  edgeFilter?: (nx: number, ny: number) => boolean,
): number {
  const n = normCoords.length;
  let vOffset = currentVertexCount;

  // Precompute normals for each edge so we can filter before cumDist
  type EdgeData = { i: number; j: number; nx: number; ny: number };
  const filteredEdges: EdgeData[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [ax, ay] = normCoords[i];
    const [bx, by] = normCoords[j];
    const ex = bx - ax;
    const ey = by - ay;
    const len = Math.sqrt(ex * ex + ey * ey) || 1;
    const enx = ey / len;
    const eny = -ex / len;
    if (!edgeFilter || edgeFilter(enx, eny)) {
      filteredEdges.push({ i, j, nx: enx, ny: eny });
    }
  }

  // Precompute perimeter-based U coordinates over filtered edges only
  const filteredCumDist: number[] = [0];
  for (const edge of filteredEdges) {
    const [ax, ay] = normCoords[edge.i];
    const [bx, by] = normCoords[edge.j];
    const dx = bx - ax;
    const dy = by - ay;
    filteredCumDist.push(filteredCumDist[filteredCumDist.length - 1] + Math.sqrt(dx * dx + dy * dy));
  }
  const totalDist = filteredCumDist[filteredEdges.length] || 1;

  for (let fi = 0; fi < filteredEdges.length; fi++) {
    const { i, j, nx: enx, ny: eny } = filteredEdges[fi];
    const [ax, ay] = normCoords[i];
    const [bx, by] = normCoords[j];

    const uA = filteredCumDist[fi] / totalDist;
    const uB = filteredCumDist[fi + 1] / totalDist;

    const vb = vOffset;
    // v0=front-A, v1=front-B, v2=back-B, v3=back-A
    positions.push(ax, ay, halfZ, bx, by, halfZ, bx, by, -halfZ, ax, ay, -halfZ);
    for (let k = 0; k < 4; k++) normals.push(enx, eny, 0);
    // V=1 at +halfZ (front face side), V=0 at -halfZ (back face side)
    uvs.push(uA, 1, uB, 1, uB, 0, uA, 0);

    if (colorFn) {
      const ca = colorFn(contourPx[i][0], contourPx[i][1]);
      const cb = colorFn(contourPx[j][0], contourPx[j][1]);
      colors.push(...ca, ...cb, ...cb, ...ca);
    } else {
      colors.push(1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1);
    }

    indices.push(vb, vb + 1, vb + 2, vb, vb + 2, vb + 3);
    vOffset += 4;
  }

  return vOffset;
}

export function buildExtrudedMesh(
  contourResult: ContourResult,
  imageData: ImageData,
  options: MeshOptions,
): { mesh: THREE.Mesh; stats: MeshStats } {
  const {
    depth, scale, sideMode, sideColor,
    faceMode: faceModeOpt,
    normalMapEnabled, normalMapStrength,
    backImageData,
    sideImages,
    reliefEnabled, reliefStrength,
    uploadedNormalMap, uploadedRoughnessMap, uploadedMetallicMap,
  } = options;
  // Default to 'front-back' for backward compat when faceMode is not set
  const faceMode: FaceMode = faceModeOpt ?? (backImageData ? 'front-back' : 'front');
  const { width, height } = imageData;
  const cx = width / 2;
  const cy = height / 2;
  const maxDim = Math.max(width, height);
  const halfZ = depth / 2;

  // Guard against stale module cache returning old array format
  if (!contourResult?.outer || !Array.isArray(contourResult.outer)) {
    throw new Error('Stale data — reload the page and re-upload the image');
  }

  const { outer, holes } = contourResult;

  const outerNorm = normalize(outer, cx, cy, maxDim, scale);
  const holesNorm = holes.map((h) => normalize(h, cx, cy, maxDim, scale));

  // Earcut: outer + holes concatenated, with hole start indices
  const allPx: Contour2D = [...outer, ...holes.flat()];
  const allNorm: Array<[number, number]> = [...outerNorm, ...holesNorm.flat()];
  const flatCoords = allNorm.flatMap((p) => p);

  const holeStarts: number[] = [];
  let hStart = outer.length;
  for (const h of holes) {
    holeStarts.push(hStart);
    hStart += h.length;
  }

  const triIdx = earcut(flatCoords, holeStarts.length ? holeStarts : undefined);
  if (triIdx.length === 0) {
    throw new Error('earcut failed — contour may be self-intersecting or degenerate');
  }

  const totalVerts = allNorm.length;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const uvFn = (px: number, py: number): [number, number] => [
    px / width,
    py / height,
  ];

  // Samples nearest edge pixel for 'edge' side mode
  const edgeColorFn = sideMode === 'edge'
    ? (px: number, py: number): [number, number, number] => {
        const xi = Math.min(Math.max(Math.round(px), 0), width - 1);
        const yi = Math.min(Math.max(Math.round(py), 0), height - 1);
        const idx = (yi * width + xi) * 4;
        return [
          imageData.data[idx] / 255,
          imageData.data[idx + 1] / 255,
          imageData.data[idx + 2] / 255,
        ];
      }
    : undefined;

  // --- Front face (z = +halfZ, optionally displaced for relief) ---
  if (reliefEnabled) {
    // Build initial triangles from earcut, subdivide 2 levels (16× density)
    let rtris: Array<[RV, RV, RV]> = [];
    for (let i = 0; i < triIdx.length; i += 3) {
      const ai = triIdx[i], bi = triIdx[i + 1], ci = triIdx[i + 2];
      rtris.push([
        { norm: allNorm[ai], px: allPx[ai] as [number, number] },
        { norm: allNorm[bi], px: allPx[bi] as [number, number] },
        { norm: allNorm[ci], px: allPx[ci] as [number, number] },
      ]);
    }
    rtris = subdivide(subdivide(rtris)); // 2 levels

    let vi = 0;
    for (const [A, B, C] of rtris) {
      for (const v of [A, B, C]) {
        const { gx, gy, mag } = sobelAt(v.px[0], v.px[1], imageData.data, width, height);
        const dispZ = halfZ + mag * reliefStrength;
        positions.push(v.norm[0], v.norm[1], dispZ);

        // Normal derived from displacement gradient — accurate for gradient-based displacement
        const s = reliefStrength * 4;
        const nx = -gx * s, ny = gy * s, nz = 1;
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
        normals.push(nx / nl, ny / nl, nz / nl);

        uvs.push(v.px[0] / width, v.px[1] / height);
        colors.push(1, 1, 1);
      }
      indices.push(vi, vi + 1, vi + 2);
      vi += 3;
    }
  } else {
    for (let i = 0; i < totalVerts; i++) {
      const [px, py] = allNorm[i];
      positions.push(px, py, halfZ);
      normals.push(0, 0, 1);
      uvs.push(...uvFn(allPx[i][0], allPx[i][1]));
      colors.push(1, 1, 1);
    }
    for (let i = 0; i < triIdx.length; i += 3) {
      indices.push(triIdx[i], triIdx[i + 1], triIdx[i + 2]);
    }
  }

  // --- Back face (z = -halfZ, reversed winding) ---
  const frontIndexCount = indices.length;
  const backBase = positions.length / 3;
  // When a separate back image is provided, mirror UV.x so the image reads correctly from behind
  const backUvFn = backImageData
    ? (px: number, py: number): [number, number] => [1 - px / width, py / height]
    : uvFn;
  for (let i = 0; i < totalVerts; i++) {
    const [px, py] = allNorm[i];
    positions.push(px, py, -halfZ);
    normals.push(0, 0, -1);
    uvs.push(...backUvFn(allPx[i][0], allPx[i][1]));
    colors.push(1, 1, 1);
  }
  const backStart = indices.length;
  for (let i = 0; i < triIdx.length; i += 3) {
    indices.push(
      backBase + triIdx[i + 2],
      backBase + triIdx[i + 1],
      backBase + triIdx[i],
    );
  }

  const backIndexCount = triIdx.length;
  const frontBackIndexCount = frontIndexCount + backIndexCount;

  // --- Side faces ---
  let vCount = positions.length / 3; // actual vertex count after front + back

  // Edge filter definitions for lr / lrtb modes
  const filterRight = (enx: number, _eny: number) => enx >= 0;
  const filterLeft  = (enx: number, _eny: number) => enx < 0;
  const filterLRRight = (enx: number, eny: number) => Math.abs(enx) >= Math.abs(eny) && enx >= 0;
  const filterLRLeft  = (enx: number, eny: number) => Math.abs(enx) >= Math.abs(eny) && enx < 0;
  const filterTop     = (enx: number, eny: number) => Math.abs(eny) > Math.abs(enx) && eny >= 0;
  const filterBottom  = (enx: number, eny: number) => Math.abs(eny) > Math.abs(enx) && eny < 0;

  type GroupEntry = { start: number; count: number; matIndex: number };
  const sideGroups: GroupEntry[] = [];

  const addSideGroup = (
    filter: ((nx: number, ny: number) => boolean) | undefined,
    matIndex: number,
  ) => {
    const idxStart = indices.length;
    vCount = addSideQuads(outer, outerNorm, halfZ, vCount, positions, normals, uvs, colors, indices, edgeColorFn, filter);
    for (let h = 0; h < holes.length; h++) {
      vCount = addSideQuads(holes[h], holesNorm[h], halfZ, vCount, positions, normals, uvs, colors, indices, edgeColorFn, filter);
    }
    const count = indices.length - idxStart;
    if (count > 0) {
      sideGroups.push({ start: idxStart, count, matIndex });
    }
  };

  if (faceMode === 'front') {
    // single side group
    addSideGroup(undefined, 1);
  } else if (faceMode === 'front-back') {
    // single side group — mat index 2 (front=0, back=1, sides=2)
    addSideGroup(undefined, 2);
  } else if (faceMode === 'front-back-lr') {
    // right=2, left=3
    addSideGroup(filterRight, 2);
    addSideGroup(filterLeft, 3);
  } else {
    // front-back-lrtb: right=2, left=3, top=4, bottom=5
    addSideGroup(filterLRRight, 2);
    addSideGroup(filterLRLeft, 3);
    addSideGroup(filterTop, 4);
    addSideGroup(filterBottom, 5);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);

  if (faceMode === 'front') {
    // 2 groups: front+back / sides
    geo.addGroup(0, frontBackIndexCount, 0);
    for (const g of sideGroups) geo.addGroup(g.start, g.count, g.matIndex);
  } else {
    // separate front and back groups
    geo.addGroup(0, frontIndexCount, 0);
    geo.addGroup(backStart, frontIndexCount, 1);
    for (const g of sideGroups) geo.addGroup(g.start, g.count, g.matIndex);
  }

  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  // ── Texture map resolution ────────────────────────────────────────────────
  const frontTex   = makeTexture(imageData);
  // Normal: uploaded map takes priority over procedural Sobel
  const normalTex: THREE.Texture | null =
    uploadedNormalMap  ? makeTexture(uploadedNormalMap)
    : normalMapEnabled ? makeNormalMap(imageData, normalMapStrength)
    : null;
  const roughnessTex: THREE.Texture | null = uploadedRoughnessMap ? makeTexture(uploadedRoughnessMap) : null;
  const metalnessTex: THREE.Texture | null = uploadedMetallicMap  ? makeTexture(uploadedMetallicMap)  : null;

  // ── Material builder ──────────────────────────────────────────────────────
  const buildFaceMat = (
    baseTex: THREE.Texture,
    nTex = normalTex,
    rTex = roughnessTex,
    mTex = metalnessTex,
  ): THREE.MeshStandardMaterial => {
    const p: THREE.MeshStandardMaterialParameters = {
      map: baseTex,
      side: THREE.DoubleSide,
      roughness: rTex ? 1.0 : 0.85,
      metalness: mTex ? 1.0 : 0.05,
    };
    if (nTex) { p.normalMap = nTex; p.normalScale = new THREE.Vector2(1, 1); }
    if (rTex) p.roughnessMap = rTex;
    if (mTex) p.metalnessMap = mTex;
    return new THREE.MeshStandardMaterial(p);
  };

  const faceMat = buildFaceMat(frontTex);

  // Side material — PBR maps not applied to sides (perimeter UVs ≠ image-space)
  const sideMat =
    sideMode === 'image'
      ? buildFaceMat(frontTex, null, null, null) // project front texture, no PBR maps
      : sideMode === 'edge'
        ? new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.85, metalness: 0.05 })
        : new THREE.MeshStandardMaterial({ color: new THREE.Color(sideColor), side: THREE.DoubleSide, roughness: 0.85, metalness: 0.05 });

  // Helper: build a side group material — uses uploaded image if provided, otherwise sideMat
  const buildSideMat = (imgData?: ImageData): THREE.MeshStandardMaterial => {
    if (imgData) return buildFaceMat(makeTexture(imgData), null, null, null);
    return sideMat;
  };

  let materials: THREE.MeshStandardMaterial[];
  if (faceMode === 'front') {
    materials = [faceMat, sideMat];
  } else if (faceMode === 'front-back') {
    const backTex = backImageData ? makeTexture(backImageData) : frontTex;
    const backNormalTex: THREE.Texture | null = backImageData
      ? (uploadedNormalMap ? makeTexture(uploadedNormalMap) : normalMapEnabled ? makeNormalMap(backImageData, normalMapStrength) : null)
      : normalTex;
    const backMat = buildFaceMat(backTex, backNormalTex, roughnessTex, metalnessTex);
    materials = [faceMat, backMat, sideMat];
  } else if (faceMode === 'front-back-lr') {
    const backTex = backImageData ? makeTexture(backImageData) : frontTex;
    const backNormalTex: THREE.Texture | null = backImageData
      ? (uploadedNormalMap ? makeTexture(uploadedNormalMap) : normalMapEnabled ? makeNormalMap(backImageData, normalMapStrength) : null)
      : normalTex;
    const backMat = buildFaceMat(backTex, backNormalTex, roughnessTex, metalnessTex);
    materials = [
      faceMat,                            // 0: front
      backMat,                            // 1: back
      buildSideMat(sideImages?.right),    // 2: right
      buildSideMat(sideImages?.left),     // 3: left
    ];
  } else {
    // front-back-lrtb
    const backTex = backImageData ? makeTexture(backImageData) : frontTex;
    const backNormalTex: THREE.Texture | null = backImageData
      ? (uploadedNormalMap ? makeTexture(uploadedNormalMap) : normalMapEnabled ? makeNormalMap(backImageData, normalMapStrength) : null)
      : normalTex;
    const backMat = buildFaceMat(backTex, backNormalTex, roughnessTex, metalnessTex);
    materials = [
      faceMat,                            // 0: front
      backMat,                            // 1: back
      buildSideMat(sideImages?.right),    // 2: right
      buildSideMat(sideImages?.left),     // 3: left
      buildSideMat(sideImages?.top),      // 4: top
      buildSideMat(sideImages?.bottom),   // 5: bottom
    ];
  }

  const mesh = new THREE.Mesh(geo, materials);
  const stats: MeshStats = {
    triangles: (geo.index?.count ?? 0) / 3,
    vertices: geo.attributes.position.count,
    contourPts: outer.length + holes.reduce((s, h) => s + h.length, 0),
    holes: holes.length,
  };
  return { mesh, stats };
}

export interface LatheOptions {
  scale: number;
  latheSegments: number;
  latheClosed: boolean;
  latheStretchTexture: boolean;
  latheColumnWidth: number;
  normalMapEnabled: boolean;
  normalMapStrength: number;
  uploadedNormalMap?: ImageData;
  uploadedRoughnessMap?: ImageData;
  uploadedMetallicMap?: ImageData;
}

// Revolves the right-side silhouette profile 360° around the Y axis.
// Works best for symmetric sprites (balls, potions, bullets, gems).
export function buildLatheMesh(
  mask: Uint8Array | Uint8ClampedArray,
  imageData: ImageData,
  options: LatheOptions,
): { mesh: THREE.Mesh; stats: MeshStats } {
  const { scale, latheSegments, latheClosed, latheStretchTexture, latheColumnWidth,
          normalMapEnabled, normalMapStrength,
          uploadedNormalMap, uploadedRoughnessMap, uploadedMetallicMap } = options;
  const { width, height } = imageData;
  const cx = width / 2;
  const cy = height / 2;
  const maxDim = Math.max(width, height);

  // Extract right-side profile + content bounding columns in one pass
  const rawProfile: Array<[number, number]> = []; // [radius_px, y_px]
  let leftCol = width;
  let rightCol = 0;
  for (let y = 0; y < height; y++) {
    let rightmost = -1;
    let leftmost = -1;
    for (let x = width - 1; x >= 0; x--) {
      if (mask[y * width + x] > 0) { rightmost = x; break; }
    }
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] > 0) { leftmost = x; break; }
    }
    if (rightmost >= 0) {
      rawProfile.push([Math.max(0, rightmost - cx), y]);
      if (leftmost < leftCol)  leftCol = leftmost;
      if (rightmost > rightCol) rightCol = rightmost;
    }
  }

  if (rawProfile.length < 2) {
    throw new Error('Not enough profile points for lathe — try a different background mode');
  }

  // Pre-compute UV strip bounds (used in both UV fixup and texture setup below)
  const contentCenter = (leftCol + rightCol) / 2; // px
  let stripUMin: number, stripUMax: number;
  if (latheStretchTexture && latheColumnWidth > 0) {
    const halfPx = latheColumnWidth / 2;
    stripUMin = Math.max(0, (contentCenter - halfPx) / width);
    stripUMax = Math.min(1, (contentCenter + halfPx) / width);
  } else {
    stripUMin = leftCol / width;
    stripUMax = (rightCol + 1) / width;
  }
  const stripSpan = Math.max(stripUMax - stripUMin, 0.001);

  // LatheGeometry expects points bottom → top (world Y low → high)
  // image y=0 is top of sprite → positive world Y; image y=height → negative world Y
  const points = rawProfile
    .slice()
    .reverse()
    .map(([r, y]) => new THREE.Vector2(
      (r / maxDim) * scale,
      -((y - cy) / maxDim) * scale,
    ));

  // Close caps: prepend/append zero-radius pole points so top/bottom are solid discs.
  if (latheClosed) {
    const EPS = 1e-4;
    if (points[0].x > EPS) {
      points.unshift(new THREE.Vector2(0, points[0].y));
    }
    if (points[points.length - 1].x > EPS) {
      points.push(new THREE.Vector2(0, points[points.length - 1].y));
    }
  }

  const geo = new THREE.LatheGeometry(points, latheSegments);

  // Fix UV.v + optionally bake mirrored strip UV.u directly into geometry.
  //
  // Strip mode mirror: UV.u from LatheGeometry goes 0→1 across 360°.
  // Naive stretch → visible seam at 0°/360°. Fix: zigzag the U so the
  // strip goes left→right across front 180° then right→left across back 180°.
  // Both poles of the seam hit the same strip pixel → invisible join.
  {
    const posAttr = geo.attributes.position;
    const uvAttr  = geo.attributes.uv;
    const doMirror = latheStretchTexture && latheColumnWidth > 0;
    for (let i = 0; i < posAttr.count; i++) {
      // Fix V: reverse-project worldY → image row
      const worldY = posAttr.getY(i);
      const imgY = cy - (worldY * maxDim / scale);
      uvAttr.setY(i, Math.max(0, Math.min(1, imgY / height)));

      // Fix U: bake mirrored strip mapping so there's no visible seam
      if (doMirror) {
        const rawU = uvAttr.getX(i);                          // 0→1 azimuth
        const mirrorU = rawU <= 0.5 ? rawU * 2 : (1 - rawU) * 2; // 0→1→0 zigzag
        uvAttr.setX(i, stripUMin + mirrorU * stripSpan);
      }
    }
    uvAttr.needsUpdate = true;
  }

  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  // Texture wraps around the revolution (wrapS = repeat)
  const texture = makeTexture(imageData);
  texture.wrapS = THREE.RepeatWrapping;
  if (latheStretchTexture) {
    if (latheColumnWidth > 0) {
      // Strip mode: UVs already baked with mirror above — texture used at natural coords.
      // No offset/repeat tricks needed.
    } else {
      // Auto content-bounds mode: crop to content bounding box, repeat front + back.
      texture.offset.x = stripUMin;
      texture.repeat.x = 2 * stripSpan;
    }
  }

  const normalTex: THREE.Texture | null =
    uploadedNormalMap  ? makeTexture(uploadedNormalMap)
    : normalMapEnabled ? makeNormalMap(imageData, normalMapStrength)
    : null;
  const roughnessTex = uploadedRoughnessMap ? makeTexture(uploadedRoughnessMap) : null;
  const metalnessTex = uploadedMetallicMap  ? makeTexture(uploadedMetallicMap)  : null;

  const matParams: THREE.MeshStandardMaterialParameters = {
    map: texture,
    side: THREE.DoubleSide,
    roughness: roughnessTex ? 1.0 : 0.85,
    metalness: metalnessTex ? 1.0 : 0.05,
  };
  if (normalTex)    { matParams.normalMap = normalTex; matParams.normalScale = new THREE.Vector2(1, 1); }
  if (roughnessTex)   matParams.roughnessMap = roughnessTex;
  if (metalnessTex)   matParams.metalnessMap = metalnessTex;

  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial(matParams));
  const stats: MeshStats = {
    triangles: (geo.index?.count ?? 0) / 3,
    vertices: geo.attributes.position.count,
    contourPts: rawProfile.length,
    holes: 0,
  };
  return { mesh, stats };
}

export interface OutlineOptions {
  depth: number;
  scale: number;
  color: string;
  opacity: number;
}

export function buildOutline(
  contourResult: ContourResult,
  imageData: ImageData,
  options: OutlineOptions,
): THREE.Group {
  const { depth, scale, color, opacity } = options;
  const { width, height } = imageData;
  const cx = width / 2;
  const cy = height / 2;
  const maxDim = Math.max(width, height);
  const halfZ = depth / 2;

  const normContour = (c: Contour2D) =>
    c.map(([x, y]) => new THREE.Vector3(
      ((x - cx) / maxDim) * scale,
      -((y - cy) / maxDim) * scale,
      0,
    ));

  const mat = new THREE.LineBasicMaterial({
    color: new THREE.Color(color),
    opacity,
    transparent: opacity < 1,
    depthTest: false,
    depthWrite: false,
  });

  const group = new THREE.Group();
  group.renderOrder = 999;

  const addLoop = (pts: THREE.Vector3[], z: number) => {
    const shifted = pts.map((p) => new THREE.Vector3(p.x, p.y, z));
    const geo = new THREE.BufferGeometry().setFromPoints(shifted);
    group.add(new THREE.LineLoop(geo, mat));
  };

  const addEdges = (pts: THREE.Vector3[]) => {
    const verts: number[] = [];
    for (const p of pts) {
      verts.push(p.x, p.y, halfZ + 0.001, p.x, p.y, -halfZ - 0.001);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    group.add(new THREE.LineSegments(geo, mat));
  };

  const { outer, holes } = contourResult;
  const allContours = [outer, ...holes];

  for (const c of allContours) {
    const pts = normContour(c);
    addLoop(pts, halfZ + 0.001);
    addLoop(pts, -halfZ - 0.001);
    addEdges(pts);
  }

  return group;
}
