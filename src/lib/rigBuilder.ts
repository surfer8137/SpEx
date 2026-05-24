import * as THREE from 'three';
import type { RigMarkers, JointId } from '../types/rig';
import { BONE_SEGMENTS, BONE_NAMES } from '../types/rig';

// Convert marker normalized image coords → world XY coords
// Same transform as meshBuilder normalize()
function markerToWorld(
  mx: number, my: number,
  imgWidth: number, imgHeight: number,
  scale: number,
): [number, number] {
  const cx = imgWidth / 2;
  const cy = imgHeight / 2;
  const maxDim = Math.max(imgWidth, imgHeight);
  const px = mx * imgWidth;
  const py = my * imgHeight;
  return [
    (px - cx) / maxDim * scale,
    -((py - cy) / maxDim) * scale,
  ];
}

// Distance from point (px,py) to segment (ax,ay)→(bx,by)
function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.sqrt((px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2);
}

function subdivideGeometryForSkinning(input: THREE.BufferGeometry, levels = 1): THREE.BufferGeometry {
  let geo = input;

  for (let level = 0; level < levels; level++) {
    const index = geo.index;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) break;
    const normal = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;

    const groups = geo.groups.length > 0
      ? geo.groups
      : [{ start: 0, count: (index ? index.count : pos.count), materialIndex: 0 }];

    const outPos: number[] = [];
    const outNorm: number[] = [];
    const outUv: number[] = [];
    const outGroups: Array<{ start: number; count: number; materialIndex: number }> = [];

    const readTri = (ia: number, ib: number, ic: number) => {
      const a = new THREE.Vector3(pos.getX(ia), pos.getY(ia), pos.getZ(ia));
      const b = new THREE.Vector3(pos.getX(ib), pos.getY(ib), pos.getZ(ib));
      const c = new THREE.Vector3(pos.getX(ic), pos.getY(ic), pos.getZ(ic));
      const ab = a.clone().add(b).multiplyScalar(0.5);
      const bc = b.clone().add(c).multiplyScalar(0.5);
      const ca = c.clone().add(a).multiplyScalar(0.5);

      const nA = normal ? new THREE.Vector3(normal.getX(ia), normal.getY(ia), normal.getZ(ia)).normalize() : null;
      const nB = normal ? new THREE.Vector3(normal.getX(ib), normal.getY(ib), normal.getZ(ib)).normalize() : null;
      const nC = normal ? new THREE.Vector3(normal.getX(ic), normal.getY(ic), normal.getZ(ic)).normalize() : null;
      const nAB = (nA && nB) ? nA.clone().add(nB).normalize() : null;
      const nBC = (nB && nC) ? nB.clone().add(nC).normalize() : null;
      const nCA = (nC && nA) ? nC.clone().add(nA).normalize() : null;

      const uvA = uv ? new THREE.Vector2(uv.getX(ia), uv.getY(ia)) : null;
      const uvB = uv ? new THREE.Vector2(uv.getX(ib), uv.getY(ib)) : null;
      const uvC = uv ? new THREE.Vector2(uv.getX(ic), uv.getY(ic)) : null;
      const uvAB = (uvA && uvB) ? uvA.clone().add(uvB).multiplyScalar(0.5) : null;
      const uvBC = (uvB && uvC) ? uvB.clone().add(uvC).multiplyScalar(0.5) : null;
      const uvCA = (uvC && uvA) ? uvC.clone().add(uvA).multiplyScalar(0.5) : null;

      const pushV = (p: THREE.Vector3, n: THREE.Vector3 | null, t: THREE.Vector2 | null) => {
        outPos.push(p.x, p.y, p.z);
        if (normal && n) outNorm.push(n.x, n.y, n.z);
        if (uv && t) outUv.push(t.x, t.y);
      };

      // 4-triangle split
      pushV(a, nA, uvA);   pushV(ab, nAB, uvAB); pushV(ca, nCA, uvCA);
      pushV(ab, nAB, uvAB); pushV(b, nB, uvB);   pushV(bc, nBC, uvBC);
      pushV(ca, nCA, uvCA); pushV(bc, nBC, uvBC); pushV(c, nC, uvC);
      pushV(ab, nAB, uvAB); pushV(bc, nBC, uvBC); pushV(ca, nCA, uvCA);
    };

    let vertexCursor = 0;
    for (const g of groups) {
      const groupStart = vertexCursor;
      const triStart = g.start;
      const triEnd = g.start + g.count;
      for (let i = triStart; i < triEnd; i += 3) {
        const ia = index ? index.getX(i) : i;
        const ib = index ? index.getX(i + 1) : i + 1;
        const ic = index ? index.getX(i + 2) : i + 2;
        readTri(ia, ib, ic);
        vertexCursor += 12; // 4 tris * 3 verts
      }
      outGroups.push({ start: groupStart, count: vertexCursor - groupStart, materialIndex: g.materialIndex ?? 0 });
    }

    const next = new THREE.BufferGeometry();
    next.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));
    if (outNorm.length > 0) next.setAttribute('normal', new THREE.Float32BufferAttribute(outNorm, 3));
    if (outUv.length > 0) next.setAttribute('uv', new THREE.Float32BufferAttribute(outUv, 2));
    for (const g of outGroups) next.addGroup(g.start, g.count, g.materialIndex);
    next.computeBoundingBox();
    next.computeBoundingSphere();

    geo = next;
  }

  return geo;
}

export function buildSkinnedMesh(
  originalMesh: THREE.Mesh,
  markers: RigMarkers,
  scale: number,
  imgWidth: number,
  imgHeight: number,
): THREE.SkinnedMesh {
  const numBones = BONE_SEGMENTS.length;

  // 1. Compute world positions for all joint markers
  const worldPos: Record<JointId, [number, number]> = {} as Record<JointId, [number, number]>;
  for (const [jointId, pos] of Object.entries(markers) as [JointId, { x: number; y: number }][]) {
    worldPos[jointId] = markerToWorld(pos.x, pos.y, imgWidth, imgHeight, scale);
  }

  // 2. Build Three.js bone hierarchy
  // One bone per BONE_SEGMENTS entry — each bone positioned at the START of its segment
  const bones: THREE.Bone[] = [];

  // World positions of bone roots (start of each segment)
  const boneWorldPos: Array<[number, number]> = BONE_SEGMENTS.map(([start]) => worldPos[start]);

  for (let i = 0; i < numBones; i++) {
    const bone = new THREE.Bone();
    bone.name = BONE_NAMES[i];
    bones.push(bone);
  }

  // Set up parent–child relationships.
  // Bone 0 (hips→spine) is root.
  // Parent of bone i = the segment whose END joint equals this segment's START joint.
  // This avoids ambiguous matches when multiple segments share the same start joint (e.g. spine_mid).
  for (let i = 0; i < numBones; i++) {
    const startJoint = BONE_SEGMENTS[i][0] as JointId;
    let parentBoneIdx = BONE_SEGMENTS.findIndex(([, end]) => end === startJoint);
    // Segments that also start at hips (legs) have no segment ending at hips.
    // Attach them to the hips root chain (bone 0) so leg animation propagates.
    if (i !== 0 && startJoint === 'hips') parentBoneIdx = 0;
    if (parentBoneIdx >= 0) {
      bones[parentBoneIdx].add(bones[i]);
    }
  }

  // Set bone local positions (relative to parent)
  for (let i = 0; i < numBones; i++) {
    const [wx, wy] = boneWorldPos[i];
    const parent = bones[i].parent as THREE.Bone | null;
    if (parent && parent instanceof THREE.Bone) {
      const parentIdx = bones.indexOf(parent);
      const [pwx, pwy] = boneWorldPos[parentIdx];
      bones[i].position.set(wx - pwx, wy - pwy, 0);
    } else {
      // Root bone: position in world space
      bones[i].position.set(wx, wy, 0);
    }
  }

  // 3. Clone geometry and add skinning attributes
  const sourceGeo = originalMesh.geometry.clone();
  // Add local vertex density so joint bends deform smoother (less panel-like creasing).
  const geo = subdivideGeometryForSkinning(sourceGeo, 1);
  const posAttr = geo.attributes.position;
  const vertCount = posAttr.count;

  const skinIndices = new Uint16Array(vertCount * 4);
  const skinWeights = new Float32Array(vertCount * 4);

  const hipsY = worldPos.hips[1];
  const spineY = worldPos.spine_mid[1];
  const shoulderY = (worldPos.l_shoulder[1] + worldPos.r_shoulder[1]) * 0.5;
  const centerX = worldPos.hips[0];

  for (let v = 0; v < vertCount; v++) {
    const vx = posAttr.getX(v);
    const vy = posAttr.getY(v);

    // Compute distance to each bone segment (in world XY)
    const dists: Array<{ idx: number; dist: number }> = [];
    for (let b = 0; b < numBones; b++) {
      const [startJoint, endJoint] = BONE_SEGMENTS[b];
      const [ax, ay] = worldPos[startJoint];
      const [bxp, byp] = worldPos[endJoint];
      let d = distToSegment(vx, vy, ax, ay, bxp, byp);

      // Region-aware penalties so torso/legs keep cohesive deformation.
      // This avoids e.g. leg verts being pulled by arm chains just because XY happens to be close.
      const isArmBone = b >= 2 && b <= 7;
      const isLegBone = b >= 8 && b <= 11;
      const isCoreBone = b <= 1; // hips, spine
      const isLeftBone = b === 2 || b === 3 || b === 4 || b === 8 || b === 9;
      const isRightBone = b === 5 || b === 6 || b === 7 || b === 10 || b === 11;

      // Below hips: strongly prefer leg chains.
      if (vy < hipsY) {
        if (isArmBone) d *= 4.0;
        if (isCoreBone) d *= 1.8;
      }

      // Mid torso (hips→shoulders): avoid leg bleeding.
      if (vy >= hipsY && vy <= shoulderY) {
        if (isLegBone) d *= 3.0;
      }

      // Above spine: avoid legs entirely.
      if (vy > spineY && isLegBone) d *= 5.0;

      // Gentle left/right bias to reduce cross-body pulls around center seam.
      if (vx < centerX && isRightBone) d *= 1.35;
      if (vx > centerX && isLeftBone) d *= 1.35;

      dists.push({ idx: b, dist: d });
    }

    // Sort by distance, take top 4
    dists.sort((a, b) => a.dist - b.dist);
    const top4 = dists.slice(0, 4);

    // Inverse-squared weights
    const EPS = 1e-6;
    const rawW = top4.map(({ dist }) => 1 / (dist * dist + EPS));
    const total = rawW.reduce((s, w) => s + w, 0);

    for (let k = 0; k < 4; k++) {
      skinIndices[v * 4 + k] = top4[k]?.idx ?? 0;
      skinWeights[v * 4 + k] = top4[k] ? rawW[k] / total : 0;
    }
  }

  geo.setAttribute('skinIndex',  new THREE.Uint16BufferAttribute(skinIndices, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));

  // 4. Create skeleton
  // Root bone must be added to scene root — caller handles that
  const skeleton = new THREE.Skeleton(bones);

  // 5. Create SkinnedMesh — copy materials from original
  const skinnedMesh = new THREE.SkinnedMesh(geo, originalMesh.material);
  skinnedMesh.add(bones[0]); // attach root bone
  skinnedMesh.bind(skeleton);

  return skinnedMesh;
}
