import * as THREE from 'three';
import earcut from 'earcut';
import type { ContourResult, Contour2D } from './contourExtractor';
import type { SideMode } from '../types';
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
  normalMapEnabled: boolean;
  normalMapStrength: number;
  backImageData?: ImageData;
  reliefEnabled: boolean;
  reliefStrength: number;
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

function addSideQuads(
  contourPx: Contour2D,
  normCoords: Array<[number, number]>,
  halfZ: number,
  width: number,
  height: number,
  sideBase: number,
  currentVertexCount: number,
  positions: number[],
  normals: number[],
  uvs: number[],
  colors: number[],
  indices: number[],
  uvFn: (px: number, py: number) => [number, number],
  colorFn?: (px: number, py: number) => [number, number, number],
): number {
  const n = normCoords.length;
  let vOffset = currentVertexCount;

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [ax, ay] = normCoords[i];
    const [bx, by] = normCoords[j];

    const ex = bx - ax;
    const ey = by - ay;
    const len = Math.sqrt(ex * ex + ey * ey) || 1;
    const nx = ey / len;
    const ny = -ex / len;

    const vb = vOffset;
    positions.push(ax, ay, halfZ, bx, by, halfZ, bx, by, -halfZ, ax, ay, -halfZ);
    for (let k = 0; k < 4; k++) normals.push(nx, ny, 0);

    const [ua, va] = uvFn(contourPx[i][0], contourPx[i][1]);
    const [ub, vb2] = uvFn(contourPx[j][0], contourPx[j][1]);
    uvs.push(ua, va, ub, vb2, ub, vb2, ua, va);

    if (colorFn) {
      const ca = colorFn(contourPx[i][0], contourPx[i][1]);
      const cb = colorFn(contourPx[j][0], contourPx[j][1]);
      // v0(ax top), v1(bx top), v2(bx bot), v3(ax bot)
      colors.push(...ca, ...cb, ...cb, ...ca);
    } else {
      colors.push(1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1);
    }

    indices.push(vb, vb + 1, vb + 2, vb, vb + 2, vb + 3);
    vOffset += 4;
  }

  return vOffset; // new currentVertexCount
}

export function buildExtrudedMesh(
  contourResult: ContourResult,
  imageData: ImageData,
  options: MeshOptions,
): { mesh: THREE.Mesh; stats: MeshStats } {
  const { depth, scale, sideMode, sideColor, normalMapEnabled, normalMapStrength, backImageData, reliefEnabled, reliefStrength } = options;
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
  let vCount = totalVerts * 2;

  // Outer sides
  vCount = addSideQuads(
    outer, outerNorm, halfZ, width, height, vCount, vCount,
    positions, normals, uvs, colors, indices, uvFn, edgeColorFn,
  );

  // Hole sides — same formula, winding naturally reversed because holes are CW
  for (let h = 0; h < holes.length; h++) {
    vCount = addSideQuads(
      holes[h], holesNorm[h], halfZ, width, height, vCount, vCount,
      positions, normals, uvs, colors, indices, uvFn, edgeColorFn,
    );
  }

  const sideIndexCount = indices.length - frontBackIndexCount;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);

  const sideStart = frontBackIndexCount;
  if (backImageData) {
    // 3 groups: front / back / sides
    geo.addGroup(0, frontIndexCount, 0);
    geo.addGroup(backStart, frontIndexCount, 1);
    geo.addGroup(sideStart, sideIndexCount, 2);
  } else {
    geo.addGroup(0, frontBackIndexCount, 0);
    geo.addGroup(sideStart, sideIndexCount, 1);
  }

  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  const texture = makeTexture(imageData);
  const normalTex = normalMapEnabled
    ? makeNormalMap(imageData, normalMapStrength)
    : null;

  const faceMatProps: THREE.MeshStandardMaterialParameters = {
    map: texture,
    side: THREE.DoubleSide,
    roughness: 0.85,
    metalness: 0.05,
  };
  if (normalTex) {
    faceMatProps.normalMap = normalTex;
    faceMatProps.normalScale = new THREE.Vector2(1, 1);
  }
  const faceMat = new THREE.MeshStandardMaterial(faceMatProps);

  const sideMat =
    sideMode === 'image'
      ? new THREE.MeshStandardMaterial({ ...faceMatProps })
      : sideMode === 'edge'
        ? new THREE.MeshStandardMaterial({
            vertexColors: true,
            side: THREE.DoubleSide,
            roughness: 0.85,
            metalness: 0.05,
          })
        : new THREE.MeshStandardMaterial({
            color: new THREE.Color(sideColor),
            side: THREE.DoubleSide,
            roughness: 0.85,
            metalness: 0.05,
          });

  let materials: THREE.MeshStandardMaterial[];
  if (backImageData) {
    const backTexture = makeTexture(backImageData);
    const backNormalTex = normalMapEnabled
      ? makeNormalMap(backImageData, normalMapStrength)
      : null;
    const backMatProps: THREE.MeshStandardMaterialParameters = {
      map: backTexture,
      side: THREE.DoubleSide,
      roughness: 0.85,
      metalness: 0.05,
    };
    if (backNormalTex) {
      backMatProps.normalMap = backNormalTex;
      backMatProps.normalScale = new THREE.Vector2(1, 1);
    }
    const backMat = new THREE.MeshStandardMaterial(backMatProps);
    materials = [faceMat, backMat, sideMat];
  } else {
    materials = [faceMat, sideMat];
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
