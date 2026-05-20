'use client';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createRigTestClip, type RigTestAnimationId } from '../lib/walkAnimation';

interface Props {
  mesh: THREE.Mesh | null;
  outline: THREE.Group | null;
  cameraResetKey?: number;
  playAnimation?: boolean;
  animationId?: RigTestAnimationId;
}

export default function ThreeViewport({ mesh, outline, cameraResetKey, playAnimation, animationId = 'walk' }: Props) {
  const mountRef    = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef    = useRef<THREE.Scene | null>(null);
  const cameraRef   = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const animRef     = useRef<number>(0);
  const meshRef     = useRef<THREE.Mesh | null>(null);
  const outlineRef  = useRef<THREE.Group | null>(null);
  const hasAutoFit  = useRef(false);
  const mixerRef    = useRef<THREE.AnimationMixer | null>(null);
  const clockRef    = useRef(new THREE.Clock());
  const clipCacheRef = useRef<Partial<Record<RigTestAnimationId, THREE.AnimationClip>>>({});
  const currentActionRef = useRef<THREE.AnimationAction | null>(null);
  const playAnimationRef = useRef(false);

  // Keep ref in sync so the animate loop can read it without re-subscribing
  useEffect(() => { playAnimationRef.current = playAnimation ?? false; }, [playAnimation]);

  // Stop = reset current clip to frame 0 for consistent testing.
  useEffect(() => {
    if (playAnimation) return;
    currentActionRef.current?.reset();
    mixerRef.current?.update(0);
  }, [playAnimation]);

  const fitCamera = () => {
    const m = meshRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!m || !camera || !controls) return;
    const box    = new THREE.Box3().setFromObject(m);
    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3()).length();
    camera.position.copy(center).add(new THREE.Vector3(0, 0, size * 1.6));
    camera.lookAt(center);
    controls.target.copy(center);
    controls.update();
  };

  // ── Init (once) ───────────────────────────────────────────────────────────
  useEffect(() => {
    const mount = mountRef.current!;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, mount.clientWidth / mount.clientHeight, 0.001, 1000);
    camera.position.set(0, 0, 3);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x0d1117);
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controlsRef.current = controls;

    scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(3, 4, 5);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.3);
    fill.position.set(-3, -2, -3);
    scene.add(fill);
    scene.add(new THREE.GridHelper(6, 24, 0x222233, 0x1a1a2e));

    clockRef.current.start();

    const animate = () => {
      animRef.current = requestAnimationFrame(animate);
      const delta = clockRef.current.getDelta();
      if (mixerRef.current && playAnimationRef.current) {
        mixerRef.current.update(delta);
      }
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth, h = mount.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    ro.observe(mount);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(animRef.current);
      renderer.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
    };
  }, []);

  // ── Swap mesh ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    // Dispose old mixer
    if (mixerRef.current) {
      mixerRef.current.stopAllAction();
      mixerRef.current = null;
    }

    // Dispose old mesh
    if (meshRef.current) {
      scene.remove(meshRef.current);
      meshRef.current.geometry.dispose();
      const mats = Array.isArray(meshRef.current.material)
        ? meshRef.current.material : [meshRef.current.material];
      const seenTex = new Set<THREE.Texture>();
      for (const m of mats) {
        const sm = m as THREE.MeshStandardMaterial;
        for (const tex of [sm.map, sm.normalMap]) {
          if (tex && !seenTex.has(tex)) { tex.dispose(); seenTex.add(tex); }
        }
        m.dispose();
      }
      meshRef.current = null;
    }

    if (mesh) {
      scene.add(mesh);
      meshRef.current = mesh;

      // Set up AnimationMixer if this is a SkinnedMesh
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
        const mixer = new THREE.AnimationMixer(mesh);
        mixerRef.current = mixer;

        // Start with selected animation; animate loop only advances when playAnimationRef.current is true.
        const clip = clipCacheRef.current[animationId] ?? createRigTestClip(animationId);
        clipCacheRef.current[animationId] = clip;
        const action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.reset();
        action.play();
        currentActionRef.current = action;
      }

      if (!hasAutoFit.current) {
        hasAutoFit.current = true;
        fitCamera();
      }
    }
  }, [mesh]);

  // ── Swap selected animation on current skinned mesh ──────────────────────
  useEffect(() => {
    const mixer = mixerRef.current;
    const m = meshRef.current;
    if (!mixer || !m || !(m as THREE.SkinnedMesh).isSkinnedMesh) return;

    const clip = clipCacheRef.current[animationId] ?? createRigTestClip(animationId);
    clipCacheRef.current[animationId] = clip;

    const prev = currentActionRef.current;
    const next = mixer.clipAction(clip);
    if (prev === next) return;

    if (prev) {
      prev.stop();
    }
    next.reset();
    next.setLoop(THREE.LoopRepeat, Infinity);
    next.play();
    currentActionRef.current = next;
  }, [animationId]);

  // ── Explicit camera reset ─────────────────────────────────────────────────
  useEffect(() => {
    if (cameraResetKey === undefined) return;
    fitCamera();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraResetKey]);

  // ── Swap outline ──────────────────────────────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (outlineRef.current) {
      scene.remove(outlineRef.current);
      outlineRef.current.traverse(obj => {
        if (obj instanceof THREE.LineLoop || obj instanceof THREE.LineSegments) {
          obj.geometry.dispose();
          (obj.material as THREE.Material).dispose();
        }
      });
      outlineRef.current = null;
    }
    if (outline) { scene.add(outline); outlineRef.current = outline; }
  }, [outline]);

  return (
    <div ref={mountRef} style={{ width: '100%', height: '100%', background: '#0d1117' }} />
  );
}
