export type Contour2D = Array<[number, number]>;

export interface ContourResult {
  outer: Contour2D;
  holes: Contour2D[];
}

let cvReady: Promise<void> | null = null;

function waitForCV(): Promise<void> {
  if (cvReady) return cvReady;
  cvReady = new Promise((resolve) => {
    if (typeof window !== 'undefined' && window.cv?.Mat) {
      resolve();
      return;
    }
    const id = setInterval(() => {
      if (typeof window !== 'undefined' && window.cv?.Mat) {
        clearInterval(id);
        resolve();
      }
    }, 100);
  });
  return cvReady;
}

function approxContour(cv: any, mat: any, tol: number): Contour2D {
  const approx = new cv.Mat();
  cv.approxPolyDP(mat, approx, tol, true);
  const pts: Contour2D = [];
  for (let i = 0; i < approx.rows; i++) {
    pts.push([approx.data32S[i * 2], approx.data32S[i * 2 + 1]]);
  }
  approx.delete();
  return pts;
}

export async function extractContour(
  mask: Uint8ClampedArray,
  width: number,
  height: number,
  simplifyTolerance: number,
): Promise<ContourResult | null> {
  await waitForCV();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cv: any = window.cv;

  const mat = cv.matFromArray(height, width, cv.CV_8UC1, mask);

  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  const anchor = new cv.Point(-1, -1);
  cv.morphologyEx(mat, mat, cv.MORPH_CLOSE, kernel, anchor, 1);
  cv.morphologyEx(mat, mat, cv.MORPH_OPEN, kernel, anchor, 1);
  kernel.delete();

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  // RETR_CCOMP: 2-level hierarchy → level-0 = outer, level-1 = holes
  // hierarchy per contour: [next, prev, firstChild, parent]
  cv.findContours(
    mat,
    contours,
    hierarchy,
    cv.RETR_CCOMP,
    cv.CHAIN_APPROX_NONE,
  );

  // Find largest outer contour (parent == -1)
  let largestIdx = -1;
  let maxArea = 0;
  for (let i = 0; i < contours.size(); i++) {
    const parent = hierarchy.data32S[i * 4 + 3];
    if (parent !== -1) continue;
    const area = cv.contourArea(contours.get(i));
    if (area > maxArea) {
      maxArea = area;
      largestIdx = i;
    }
  }

  if (largestIdx < 0) {
    mat.delete();
    contours.delete();
    hierarchy.delete();
    return null;
  }

  const outer = approxContour(cv, contours.get(largestIdx), simplifyTolerance);

  // Find all direct holes of the winning outer contour (parent == largestIdx)
  const holes: Contour2D[] = [];
  const minHoleArea = Math.max(50, maxArea * 0.005); // ignore tiny noise
  for (let i = 0; i < contours.size(); i++) {
    const parent = hierarchy.data32S[i * 4 + 3];
    if (parent !== largestIdx) continue;
    const area = cv.contourArea(contours.get(i));
    if (area < minHoleArea) continue;
    const hole = approxContour(cv, contours.get(i), simplifyTolerance);
    if (hole.length >= 3) holes.push(hole);
  }

  mat.delete();
  contours.delete();
  hierarchy.delete();

  return outer.length >= 3 ? { outer, holes } : null;
}
