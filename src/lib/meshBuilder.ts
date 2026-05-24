import * as THREE from 'three';
import earcut from 'earcut';
import type { ContourResult, Contour2D } from './contourExtractor';
import type { SideMode, FaceMode, FaceOffsets, BackgroundMode } from '../types';
import { makeNormalMap } from './normalMapGen';
import type { BoxFillMode } from '../types';

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
  boxFillColor?: string;
  boxFillMode?: BoxFillMode;
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
  // Per-face position offsets (world units, from Face Editor Panel)
  faceOffsets?: FaceOffsets;
  // When true, depth offsets define face planes → closed watertight box (no gaps)
  weldFaces?: boolean;
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

/**
 * Adjusts texture repeat/offset so the image covers the panel while preserving
 * aspect ratio (CSS background-size: cover behaviour — centered, may crop).
 */
function coverTexture(
  tex: THREE.Texture,
  panelW: number, panelH: number,
  imgW: number,   imgH: number,
): void {
  const pa = panelW / Math.max(panelH, 1e-6);
  const ia = imgW   / Math.max(imgH,   1e-6);
  if (pa > ia) {
    const s = pa / ia;
    tex.repeat.set(1, 1 / s);
    tex.offset.set(0, (1 - 1 / s) / 2);
  } else {
    const s = ia / pa;
    tex.repeat.set(1 / s, 1);
    tex.offset.set((1 - 1 / s) / 2, 0);
  }
}

/**
 * Detects the bounding box of non-background pixels.
 * Auto-selects alpha vs white-threshold detection based on image content.
 */
function contentBounds(img: ImageData): { x0: number; y0: number; x1: number; y1: number } {
  const { data, width, height } = img;

  // Detect if image uses transparency
  let hasTransparency = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 200) { hasTransparency = true; break; }
  }

  const isFg = hasTransparency
    ? (_r: number, _g: number, _b: number, a: number) => a >= 128
    : (r: number,  g: number,  b: number, _a: number) => !(r > 235 && g > 235 && b > 235);

  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      if (isFg(data[p], data[p + 1], data[p + 2], data[p + 3])) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }

  if (x1 < 0) return { x0: 0, y0: 0, x1: width, y1: height }; // no content — use full image
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/**
 * BFS flood-fill from all 4 edges: any white-ish pixel reachable from the border
 * is considered background and made transparent (alpha = 0).
 * Skips images that already have transparency — those are assumed pre-keyed.
 */
function removeWhiteBackground(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  const id = ctx.getImageData(0, 0, width, height);
  const d  = id.data;

  // If image already carries transparency, assume it is pre-keyed — leave it alone
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] < 200) return;
  }

  const isWhitish = (p: number) =>
    d[p] > 225 && d[p + 1] > 225 && d[p + 2] > 225;

  const seen = new Uint8Array(width * height);
  // BFS queue (indices into the pixel grid)
  const q: number[] = [];

  // Seed: all pixels on the 4 edges
  for (let x = 0; x < width; x++) {
    q.push(x);                          // top row
    q.push((height - 1) * width + x);  // bottom row
  }
  for (let y = 1; y < height - 1; y++) {
    q.push(y * width);                  // left col
    q.push(y * width + width - 1);     // right col
  }

  let head = 0;
  while (head < q.length) {
    const idx = q[head++];
    if (seen[idx]) continue;
    seen[idx] = 1;
    if (!isWhitish(idx * 4)) continue;
    d[idx * 4 + 3] = 0;                // make transparent

    const x = idx % width;
    const y = (idx / width) | 0;
    if (x > 0)        q.push(idx - 1);
    if (x < width - 1) q.push(idx + 1);
    if (y > 0)        q.push(idx - width);
    if (y < height - 1) q.push(idx + width);
  }

  ctx.putImageData(id, 0, 0);
}

/** Crops ImageData to its content bounding box, optionally removes white background. */
function cropContent(img: ImageData, removeWhiteBg = true): { canvas: HTMLCanvasElement; w: number; h: number } {
  const { x0, y0, x1, y1 } = contentBounds(img);
  const w = x1 - x0, h = y1 - y0;
  const src = document.createElement('canvas');
  src.width = img.width; src.height = img.height;
  src.getContext('2d')!.putImageData(img, 0, 0);
  const dst = document.createElement('canvas');
  dst.width = w; dst.height = h;
  dst.getContext('2d')!.drawImage(src, x0, y0, w, h, 0, 0, w, h);
  if (removeWhiteBg) removeWhiteBackground(dst);
  return { canvas: dst, w, h };
}

function canvasTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false;
  return tex;
}

function fillTransparentWithColor(canvas: HTMLCanvasElement, colorHex: string): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  const id = ctx.getImageData(0, 0, width, height);
  const d = id.data;
  const c = new THREE.Color(colorHex);
  const fr = Math.round(c.r * 255);
  const fg = Math.round(c.g * 255);
  const fb = Math.round(c.b * 255);

  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    if (a >= 1) continue;
    // Composite source over fill color, then force opaque.
    d[i]     = Math.round(d[i] * a + fr * (1 - a));
    d[i + 1] = Math.round(d[i + 1] * a + fg * (1 - a));
    d[i + 2] = Math.round(d[i + 2] * a + fb * (1 - a));
    d[i + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
}

// Extend nearest opaque texels into transparent regions (multi-source BFS).
function fillTransparentByEdgeStretch(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  const id = ctx.getImageData(0, 0, width, height);
  const d = id.data;
  const n = width * height;

  const src = new Int32Array(n);
  src.fill(-1);
  const q: number[] = [];

  for (let i = 0; i < n; i++) {
    if (d[i * 4 + 3] > 0) {
      src[i] = i;
      q.push(i);
    }
  }
  if (q.length === 0) return;

  let head = 0;
  while (head < q.length) {
    const p = q[head++];
    const s = src[p];
    const x = p % width;
    const y = (p / width) | 0;

    const tryPush = (ni: number) => {
      if (src[ni] !== -1) return;
      src[ni] = s;
      q.push(ni);
    };

    if (x > 0) tryPush(p - 1);
    if (x < width - 1) tryPush(p + 1);
    if (y > 0) tryPush(p - width);
    if (y < height - 1) tryPush(p + width);
  }

  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3];
    if (a >= 255) continue;
    const s = src[i];
    if (s < 0) continue;
    d[i * 4] = d[s * 4];
    d[i * 4 + 1] = d[s * 4 + 1];
    d[i * 4 + 2] = d[s * 4 + 2];
    d[i * 4 + 3] = 255;
  }

  ctx.putImageData(id, 0, 0);
}

function fillTransparentPixels(
  canvas: HTMLCanvasElement,
  mode: BoxFillMode,
  colorHex: string,
): void {
  if (mode === 'keep-transparent') return;
  if (mode === 'flat-color') {
    fillTransparentWithColor(canvas, colorHex);
    return;
  }
  fillTransparentByEdgeStretch(canvas);
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

// Planar UV bounds for world-space projection (used when a dedicated side image is supplied).
interface PlanarBounds {
  yMin: number; yMax: number;
  xMin: number; xMax: number;
  dir: 'lr' | 'tb'; // lr = left/right face, tb = top/bottom face
}

// Side UVs: U = cumulative perimeter (0→1 around contour), V = 1 at front / 0 at back.
// When planarBounds is given, world-space UV is used instead so a dedicated side image
// projects correctly as a flat panel (depth → U, height → V for lr; width → U, depth → V for tb).
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
  planarBounds?: PlanarBounds,
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

    if (planarBounds) {
      // World-space planar UV — side image projected as a flat panel.
      const { yMin, yMax, xMin, xMax, dir } = planarBounds;
      const yRange = Math.max(yMax - yMin, 0.001);
      const xRange = Math.max(xMax - xMin, 0.001);
      const depthRange = 2 * halfZ || 0.001;
      const planeUV = (vx: number, vy: number, vz: number): [number, number] => {
        if (dir === 'lr') {
          // U: front(1)→back(0), V: top(0)→bottom(1) — matches side-view image orientation
          return [(vz + halfZ) / depthRange, (yMax - vy) / yRange];
        } else {
          // top/bottom: U: left(0)→right(1), V: front(1)→back(0)
          return [(vx - xMin) / xRange, (vz + halfZ) / depthRange];
        }
      };
      const [u0, v0] = planeUV(ax, ay, halfZ);
      const [u1, v1] = planeUV(bx, by, halfZ);
      const [u2, v2] = planeUV(bx, by, -halfZ);
      const [u3, v3] = planeUV(ax, ay, -halfZ);
      uvs.push(u0, v0, u1, v1, u2, v2, u3, v3);
    } else {
      // Perimeter-based UV — good for edge-stretch / no dedicated image
      // V=1 at +halfZ (front face side), V=0 at -halfZ (back face side)
      uvs.push(uA, 1, uB, 1, uB, 0, uA, 0);
    }

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

// ── Box mesh: 6 flat rectangular panels, one per face direction ───────────────
// Best for buildings / props where each side is a distinct flat image.
// The box is sized to match the front image aspect ratio × depth setting.
export function buildBoxMesh(
  imageData: ImageData,
  options: MeshOptions,
): { mesh: THREE.Mesh; stats: MeshStats } {
  const {
    depth, scale,
    sideMode, sideColor, boxFillColor, boxFillMode = 'edge-stretch',
    backImageData, sideImages,
    normalMapEnabled, normalMapStrength,
    uploadedNormalMap, uploadedRoughnessMap, uploadedMetallicMap,
    faceOffsets,
    weldFaces,
  } = options;

  // Crop every face image to its content bounding box (removes white/alpha background).
  // Use cropped dimensions for geometry so the box fits the actual artwork, not the canvas.
  // For box-face tiles, keep border pixels intact (no white-background removal),
  // otherwise textured walls can get accidental transparent slits on edges.
  const frontCrop = cropContent(imageData, false);
  const backCrop   = backImageData      ? cropContent(backImageData, false)      : null;
  const rightCrop  = sideImages?.right  ? cropContent(sideImages.right, false)   : null;
  const leftCrop   = sideImages?.left   ? cropContent(sideImages.left, false)    : null;
  const topCrop    = sideImages?.top    ? cropContent(sideImages.top, false)     : null;
  const bottomCrop = sideImages?.bottom ? cropContent(sideImages.bottom, false)  : null;

  const fillColor = boxFillColor ?? sideColor;
  fillTransparentPixels(frontCrop.canvas, boxFillMode, fillColor);
  if (backCrop) fillTransparentPixels(backCrop.canvas, boxFillMode, fillColor);
  if (rightCrop) fillTransparentPixels(rightCrop.canvas, boxFillMode, fillColor);
  if (leftCrop) fillTransparentPixels(leftCrop.canvas, boxFillMode, fillColor);
  if (topCrop) fillTransparentPixels(topCrop.canvas, boxFillMode, fillColor);
  if (bottomCrop) fillTransparentPixels(bottomCrop.canvas, boxFillMode, fillColor);

  // Base coordinate system from the front content bounds
  const maxDim = Math.max(frontCrop.w, frontCrop.h);
  const halfW  = (frontCrop.w / 2 / maxDim) * scale;
  const halfH  = (frontCrop.h / 2 / maxDim) * scale;

  // Depth from the side content width (same pixel scale as front width)
  const sideCrop = rightCrop ?? leftCrop;
  const halfZ    = sideCrop
    ? (sideCrop.w / 2 / maxDim) * scale
    : depth / 2;

  const positions: number[] = [];
  const normals:   number[] = [];
  const uvs:       number[] = [];
  const indices:   number[] = [];
  let vi = 0;
  const groups: { start: number; count: number; matIndex: number }[] = [];

  /**
   * Adds one quad (2 tris) with CCW winding viewed from outside.
   * p0=top-left, p1=top-right, p2=bottom-right, p3=bottom-left (image coords).
   * Vertices are taken as-is — callers pre-apply any offsets.
   */
  const addFace = (
    p0: [number,number,number], p1: [number,number,number],
    p2: [number,number,number], p3: [number,number,number],
    n: [number,number,number],
    matIndex: number,
    faceUvs?: readonly number[], // 8 values: u0,v0, u1,v1, u2,v2, u3,v3
  ) => {
    const start = indices.length;
    for (const p of [p0, p1, p2, p3]) positions.push(...p);
    for (let k = 0; k < 4; k++) normals.push(...n);
    if (faceUvs) uvs.push(...faceUvs);
    else uvs.push(0,0, 1,0, 1,1, 0,1);
    indices.push(vi, vi+1, vi+2,  vi, vi+2, vi+3);
    vi += 4;
    groups.push({ start, count: 6, matIndex });
  };

  /** Apply per-face XYZ offset to a vertex. */
  const applyOff = (
    face: 'front'|'back'|'right'|'left'|'top'|'bottom',
    p: [number,number,number],
  ): [number,number,number] => {
    if (!faceOffsets) return p;
    const off = faceOffsets[face];
    if (!off) return p;
    return [p[0] + off.x, p[1] + off.y, p[2] + off.z];
  };

  if (weldFaces) {
    // ── Weld mode: 8 shared corners, depth offsets define face planes ──────
    // Each face plane position:
    const fo = faceOffsets ?? {};
    const pZp = halfZ + (fo.front?.z  ?? 0);   // front  plane (z = +)
    const pZn = halfZ + (fo.back?.z   ?? 0);   // back   plane (z = -)
    const pXp = halfW + (fo.right?.x  ?? 0);   // right  plane (x = +)
    const pXn = halfW + (fo.left?.x   ?? 0);   // left   plane (x = -)
    const pYp = halfH + (fo.top?.y    ?? 0);   // top    plane (y = +)
    const pYn = halfH + (fo.bottom?.y ?? 0);   // bottom plane (y = -)

    // 8 corners (fr=front, bk=back, t=top, b=bottom, r=right, l=left)
    const ftr: [number,number,number] = [+pXp, +pYp, +pZp];
    const ftl: [number,number,number] = [-pXn, +pYp, +pZp];
    const fbr: [number,number,number] = [+pXp, -pYn, +pZp];
    const fbl: [number,number,number] = [-pXn, -pYn, +pZp];
    const btr: [number,number,number] = [+pXp, +pYp, -pZn];
    const btl: [number,number,number] = [-pXn, +pYp, -pZn];
    const bbr: [number,number,number] = [+pXp, -pYn, -pZn];
    const bbl: [number,number,number] = [-pXn, -pYn, -pZn];

    // Front  (+Z)
    addFace(ftl, ftr, fbr, fbl, [0,0,1], 0);
    // Back   (-Z) — mirror X for correct winding
    addFace(btr, btl, bbl, bbr, [0,0,-1], 1);
    // Right  (+X) — u=1 at front so right-walk sprite (face on right) aligns correctly
    addFace(ftr, btr, bbr, fbr, [1,0,0], 2, [1,0, 0,0, 0,1, 1,1]);
    // Left   (-X) — u=0 at front so left-walk sprite (face on left) aligns correctly
    addFace(btl, ftl, fbl, bbl, [-1,0,0], 3, [1,0, 0,0, 0,1, 1,1]);
    // Top    (+Y)
    addFace(btl, btr, ftr, ftl, [0,1,0], 4);
    // Bottom (-Y)
    addFace(fbl, fbr, bbr, bbl, [0,-1,0], 5);
  } else {
    // ── Free mode: independent quads, each shifted by its own XYZ offset ──
    const ao = applyOff;

    // Front  (z = +halfZ)
    addFace(
      ao('front', [-halfW,+halfH,+halfZ]), ao('front', [+halfW,+halfH,+halfZ]),
      ao('front', [+halfW,-halfH,+halfZ]), ao('front', [-halfW,-halfH,+halfZ]),
      [0,0,1], 0,
    );
    // Back   (z = -halfZ)
    addFace(
      ao('back',  [+halfW,+halfH,-halfZ]), ao('back',  [-halfW,+halfH,-halfZ]),
      ao('back',  [-halfW,-halfH,-halfZ]), ao('back',  [+halfW,-halfH,-halfZ]),
      [0,0,-1], 1,
    );
    // Right  (x = +halfW) — u=1 at front (+halfZ) so right-walk sprite aligns correctly
    addFace(
      ao('right', [+halfW,+halfH,+halfZ]), ao('right', [+halfW,+halfH,-halfZ]),
      ao('right', [+halfW,-halfH,-halfZ]), ao('right', [+halfW,-halfH,+halfZ]),
      [1,0,0], 2, [1,0, 0,0, 0,1, 1,1],
    );
    // Left   (x = -halfW) — u=0 at front (+halfZ) so left-walk sprite aligns correctly
    addFace(
      ao('left',  [-halfW,+halfH,-halfZ]), ao('left',  [-halfW,+halfH,+halfZ]),
      ao('left',  [-halfW,-halfH,+halfZ]), ao('left',  [-halfW,-halfH,-halfZ]),
      [-1,0,0], 3, [1,0, 0,0, 0,1, 1,1],
    );
    // Top    (y = +halfH)
    addFace(
      ao('top',    [-halfW,+halfH,-halfZ]), ao('top',    [+halfW,+halfH,-halfZ]),
      ao('top',    [+halfW,+halfH,+halfZ]), ao('top',    [-halfW,+halfH,+halfZ]),
      [0,1,0], 4,
    );
    // Bottom (y = -halfH)
    addFace(
      ao('bottom', [-halfW,-halfH,+halfZ]), ao('bottom', [+halfW,-halfH,+halfZ]),
      ao('bottom', [+halfW,-halfH,-halfZ]), ao('bottom', [-halfW,-halfH,-halfZ]),
      [0,-1,0], 5,
    );
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(normals,   3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs,       2));
  geo.setIndex(indices);
  for (const g of groups) geo.addGroup(g.start, g.count, g.matIndex);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  // ── Materials ──────────────────────────────────────────────────────────────
  // All textures are built from already-cropped canvases — no white border, correct proportions.
  const frontTex = canvasTexture(frontCrop.canvas);
  const normalTex: THREE.Texture | null =
    uploadedNormalMap  ? makeTexture(uploadedNormalMap)
    : normalMapEnabled ? makeNormalMap(imageData, normalMapStrength)
    : null;
  const roughnessTex = uploadedRoughnessMap ? makeTexture(uploadedRoughnessMap) : null;
  const metalnessTex = uploadedMetallicMap  ? makeTexture(uploadedMetallicMap)  : null;

  const buildMat = (tex: THREE.Texture, withPBR = false): THREE.MeshStandardMaterial => {
    const p: THREE.MeshStandardMaterialParameters = {
      map: tex,
      side: THREE.DoubleSide,
      roughness: roughnessTex ? 1.0 : 0.85,
      metalness: metalnessTex ? 1.0 : 0.05,
      transparent: true,
      alphaTest: 0.05,
    };
    if (withPBR) {
      if (normalTex) { p.normalMap = normalTex; p.normalScale = new THREE.Vector2(1, 1); }
      if (roughnessTex) p.roughnessMap = roughnessTex;
      if (metalnessTex) p.metalnessMap = metalnessTex;
    }
    return new THREE.MeshStandardMaterial(p);
  };

  // Fallback for missing side-face textures: honor user sideColor by default.
  const fallbackSideMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(boxFillColor ?? sideColor),
    side: THREE.DoubleSide,
    roughness: 0.9,
    metalness: 0,
  });

  // Panel w/h in world units — used for cover UV when crop aspect ≠ panel aspect
  const lrH = 2 * halfH, lrW = 2 * halfZ;
  const tbW = 2 * halfW, tbH = 2 * halfZ;
  const fbW = 2 * halfW, fbH = 2 * halfH;

  const cropTex = (crop: { canvas: HTMLCanvasElement; w: number; h: number } | null,
                   panelW: number, panelH: number): THREE.Texture | null => {
    if (!crop) return null;
    const tex = canvasTexture(crop.canvas);
    // Apply cover only if aspect ratio isn't already matched by the crop
    coverTexture(tex, panelW, panelH, crop.w, crop.h);
    return tex;
  };

  // In box mode, Side Texture selector must always drive side faces:
  // - image: use per-face side textures when available
  // - edge: approximate with front texture projection
  // - flat: force sideColor
  const sideMatFor = (
    crop: { canvas: HTMLCanvasElement; w: number; h: number } | null,
    panelW: number,
    panelH: number,
  ): THREE.MeshStandardMaterial => {
    if (sideMode === 'flat') {
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(sideColor),
        side: THREE.DoubleSide,
        roughness: 0.9,
        metalness: 0,
      });
    }
    if (sideMode === 'edge') {
      const tex = frontTex.clone();
      tex.needsUpdate = true;
      coverTexture(tex, panelW, panelH, frontCrop.w, frontCrop.h);
      return buildMat(tex);
    }
    // sideMode === 'image'
    const t = cropTex(crop, panelW, panelH);
    return t ? buildMat(t) : fallbackSideMat;
  };

  const materials: THREE.MeshStandardMaterial[] = [
    buildMat(frontTex, true),                                                             // 0 front
    buildMat(cropTex(backCrop,   fbW, fbH) ?? frontTex),                                 // 1 back
    sideMatFor(rightCrop,  lrW, lrH), // 2 right
    sideMatFor(leftCrop,   lrW, lrH), // 3 left
    sideMatFor(topCrop,    tbW, tbH), // 4 top
    sideMatFor(bottomCrop, tbW, tbH), // 5 bottom
  ];

  const mesh = new THREE.Mesh(geo, materials);
  const stats: MeshStats = { triangles: 12, vertices: 24, contourPts: 0, holes: 0 };
  return { mesh, stats };
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

  // Bounding box for world-space planar UV projection
  const yMin = outerNorm.reduce((m, [, y]) => Math.min(m, y), Infinity);
  const yMax = outerNorm.reduce((m, [, y]) => Math.max(m, y), -Infinity);
  const xMin = outerNorm.reduce((m, [x]) => Math.min(m, x), Infinity);
  const xMax = outerNorm.reduce((m, [x]) => Math.max(m, x), -Infinity);

  type GroupEntry = { start: number; count: number; matIndex: number };
  const sideGroups: GroupEntry[] = [];

  const addSideGroup = (
    filter: ((nx: number, ny: number) => boolean) | undefined,
    matIndex: number,
    planarBounds?: PlanarBounds,
  ) => {
    const idxStart = indices.length;
    vCount = addSideQuads(outer, outerNorm, halfZ, vCount, positions, normals, uvs, colors, indices, edgeColorFn, filter, planarBounds);
    for (let h = 0; h < holes.length; h++) {
      vCount = addSideQuads(holes[h], holesNorm[h], halfZ, vCount, positions, normals, uvs, colors, indices, edgeColorFn, filter, planarBounds);
    }
    const count = indices.length - idxStart;
    if (count > 0) {
      sideGroups.push({ start: idxStart, count, matIndex });
    }
  };

  const lrBounds: PlanarBounds = { yMin, yMax, xMin, xMax, dir: 'lr' };
  const tbBounds: PlanarBounds = { yMin, yMax, xMin, xMax, dir: 'tb' };

  if (faceMode === 'front') {
    addSideGroup(undefined, 1);
  } else if (faceMode === 'front-back') {
    addSideGroup(undefined, 2);
  } else if (faceMode === 'front-back-lr') {
    // Use planar UV for each side direction that has a dedicated image
    addSideGroup(filterRight, 2, sideImages?.right ? lrBounds : undefined);
    addSideGroup(filterLeft,  3, sideImages?.left  ? lrBounds : undefined);
  } else {
    // front-back-lrtb
    addSideGroup(filterLRRight,  2, sideImages?.right  ? lrBounds : undefined);
    addSideGroup(filterLRLeft,   3, sideImages?.left   ? lrBounds : undefined);
    addSideGroup(filterTop,      4, sideImages?.top    ? tbBounds : undefined);
    addSideGroup(filterBottom,   5, sideImages?.bottom ? tbBounds : undefined);
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

  // Panel dimensions for cover UV (world-space normalised coords)
  const lrPanelW = 2 * halfZ;          // depth (L/R face width in world)
  const lrPanelH = yMax - yMin;        // building height
  const tbPanelW = xMax - xMin;        // building width (T/B face width)
  const tbPanelH = 2 * halfZ;          // depth (T/B face height)

  // Helper: build a side group material — uses uploaded image if provided, otherwise sideMat
  const buildSideMat = (
    imgData?: ImageData,
    panelW?: number,
    panelH?: number,
  ): THREE.MeshStandardMaterial => {
    if (imgData) {
      const tex = makeTexture(imgData);
      if (panelW !== undefined && panelH !== undefined) {
        coverTexture(tex, panelW, panelH, imgData.width, imgData.height);
      }
      return buildFaceMat(tex, null, null, null);
    }
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
      faceMat,                                              // 0: front
      backMat,                                              // 1: back
      buildSideMat(sideImages?.right, lrPanelW, lrPanelH), // 2: right
      buildSideMat(sideImages?.left,  lrPanelW, lrPanelH), // 3: left
    ];
  } else {
    // front-back-lrtb
    const backTex = backImageData ? makeTexture(backImageData) : frontTex;
    const backNormalTex: THREE.Texture | null = backImageData
      ? (uploadedNormalMap ? makeTexture(uploadedNormalMap) : normalMapEnabled ? makeNormalMap(backImageData, normalMapStrength) : null)
      : normalTex;
    const backMat = buildFaceMat(backTex, backNormalTex, roughnessTex, metalnessTex);
    materials = [
      faceMat,                                               // 0: front
      backMat,                                               // 1: back
      buildSideMat(sideImages?.right,  lrPanelW, lrPanelH), // 2: right
      buildSideMat(sideImages?.left,   lrPanelW, lrPanelH), // 3: left
      buildSideMat(sideImages?.top,    tbPanelW, tbPanelH),  // 4: top
      buildSideMat(sideImages?.bottom, tbPanelW, tbPanelH),  // 5: bottom
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
