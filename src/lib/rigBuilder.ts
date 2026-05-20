import * as THREE from 'three';
import type { RigMarkers, JointId } from '../types/rig';
import { BONE_SEGMENTS, BONE_NAMES, BONE_PARENT } from '../types/rig';

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

  // Set up parent–child relationships and local positions
  // Bone 0 (hips) is root
  // Bone i's parent = the bone whose start joint == BONE_PARENT[BONE_SEGMENTS[i][0]]
  for (let i = 0; i < numBones; i++) {
    const startJoint = BONE_SEGMENTS[i][0] as JointId;
    const parentJoint = BONE_PARENT[startJoint];
    if (parentJoint !== undefined) {
      // Find which bone index has startJoint == parentJoint
      const parentBoneIdx = BONE_SEGMENTS.findIndex(([s]) => s === parentJoint);
      if (parentBoneIdx >= 0) {
        bones[parentBoneIdx].add(bones[i]);
      }
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
  const geo = originalMesh.geometry.clone();
  const posAttr = geo.attributes.position;
  const vertCount = posAttr.count;

  const skinIndices = new Float32Array(vertCount * 4);
  const skinWeights = new Float32Array(vertCount * 4);

  for (let v = 0; v < vertCount; v++) {
    const vx = posAttr.getX(v);
    const vy = posAttr.getY(v);

    // Compute distance to each bone segment (in world XY)
    const dists: Array<{ idx: number; dist: number }> = [];
    for (let b = 0; b < numBones; b++) {
      const [startJoint, endJoint] = BONE_SEGMENTS[b];
      const [ax, ay] = worldPos[startJoint];
      const [bxp, byp] = worldPos[endJoint];
      const d = distToSegment(vx, vy, ax, ay, bxp, byp);
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

  geo.setAttribute('skinIndex',  new THREE.Uint16BufferAttribute(Array.from(skinIndices), 4));
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
