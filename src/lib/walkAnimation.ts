import * as THREE from 'three';

const D = Math.PI / 180;

function q(ex: number, ey: number, ez: number): number[] {
  const qq = new THREE.Quaternion().setFromEuler(new THREE.Euler(ex, ey, ez, 'XYZ'));
  return [qq.x, qq.y, qq.z, qq.w];
}

/**
 * Build a looping walk-cycle AnimationClip for the skeleton produced by rigBuilder.
 * Bone names must match BONE_NAMES in types/rig.ts.
 *
 * Coordinate convention (Three.js, Y-up, character facing +Z):
 *   X rotation = pitch (forward/back swing)
 *   Z rotation = roll  (side lean)
 */
export function createWalkClip(): THREE.AnimationClip {
  // 5 evenly-spaced keyframe times for one full stride (loop-friendly)
  const T = [0, 0.25, 0.5, 0.75, 1.0];

  const tracks: THREE.KeyframeTrack[] = [];

  // ── Hips: vertical bounce + lateral sway ─────────────────────────────────
  tracks.push(new THREE.VectorKeyframeTrack(
    'hips.position',
    [0, 0.25, 0.5, 0.75, 1.0],
    [
      0,  0.018, 0,   // up   (both feet push)
      0,  0,     0,   // down (mid-swing)
      0,  0.018, 0,   // up
      0,  0,     0,   // down
      0,  0.018, 0,   // up  (loop)
    ],
  ));

  tracks.push(new THREE.QuaternionKeyframeTrack('hips.quaternion', T, [
    ...q(0,  0,  4*D),   // lean right
    ...q(0,  0,  0),
    ...q(0,  0, -4*D),   // lean left
    ...q(0,  0,  0),
    ...q(0,  0,  4*D),
  ]));

  // ── Spine: subtle counter-rotation ───────────────────────────────────────
  tracks.push(new THREE.QuaternionKeyframeTrack('spine.quaternion', T, [
    ...q(0, 0, -3*D),
    ...q(0, 0,  0),
    ...q(0, 0,  3*D),
    ...q(0, 0,  0),
    ...q(0, 0, -3*D),
  ]));

  // ── Left leg ─────────────────────────────────────────────────────────────
  // t=0: left leg forward (swing phase)
  // t=0.5: left leg back  (stance phase)
  tracks.push(new THREE.QuaternionKeyframeTrack('l_upper_leg.quaternion', T, [
    ...q(-38*D, 0, 0),  // forward
    ...q(  0,   0, 0),  // neutral
    ...q( 35*D, 0, 0),  // back
    ...q(  0,   0, 0),  // neutral
    ...q(-38*D, 0, 0),
  ]));

  // Knee bends more during forward swing
  tracks.push(new THREE.QuaternionKeyframeTrack('l_lower_leg.quaternion', T, [
    ...q(30*D, 0, 0),   // bent (clearing ground)
    ...q(45*D, 0, 0),   // peak bend mid-swing
    ...q( 5*D, 0, 0),   // nearly straight (stance)
    ...q(15*D, 0, 0),   // slight bend (push-off)
    ...q(30*D, 0, 0),
  ]));

  // ── Right leg (opposite phase) ───────────────────────────────────────────
  tracks.push(new THREE.QuaternionKeyframeTrack('r_upper_leg.quaternion', T, [
    ...q( 35*D, 0, 0),  // back
    ...q(  0,   0, 0),
    ...q(-38*D, 0, 0),  // forward
    ...q(  0,   0, 0),
    ...q( 35*D, 0, 0),
  ]));

  tracks.push(new THREE.QuaternionKeyframeTrack('r_lower_leg.quaternion', T, [
    ...q( 5*D, 0, 0),
    ...q(15*D, 0, 0),
    ...q(30*D, 0, 0),
    ...q(45*D, 0, 0),
    ...q( 5*D, 0, 0),
  ]));

  // ── Left arm (swings opposite to left leg) ───────────────────────────────
  tracks.push(new THREE.QuaternionKeyframeTrack('l_upper_arm.quaternion', T, [
    ...q( 28*D, 0, -12*D),  // back + natural hang
    ...q(  0,   0, -12*D),
    ...q(-28*D, 0, -12*D),  // forward
    ...q(  0,   0, -12*D),
    ...q( 28*D, 0, -12*D),
  ]));

  // Forearm follows naturally (slight elbow bend)
  tracks.push(new THREE.QuaternionKeyframeTrack('l_forearm.quaternion', T, [
    ...q(10*D, 0, 0),
    ...q(25*D, 0, 0),
    ...q(10*D, 0, 0),
    ...q(25*D, 0, 0),
    ...q(10*D, 0, 0),
  ]));

  // ── Right arm ────────────────────────────────────────────────────────────
  tracks.push(new THREE.QuaternionKeyframeTrack('r_upper_arm.quaternion', T, [
    ...q(-28*D, 0, 12*D),
    ...q(  0,   0, 12*D),
    ...q( 28*D, 0, 12*D),
    ...q(  0,   0, 12*D),
    ...q(-28*D, 0, 12*D),
  ]));

  tracks.push(new THREE.QuaternionKeyframeTrack('r_forearm.quaternion', T, [
    ...q(10*D, 0, 0),
    ...q(25*D, 0, 0),
    ...q(10*D, 0, 0),
    ...q(25*D, 0, 0),
    ...q(10*D, 0, 0),
  ]));

  return new THREE.AnimationClip('walk', 1.0, tracks);
}
