'use client';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

interface Props {
  mesh: THREE.Mesh | null;
  outline: THREE.Group | null;
}

export default function ThreeViewport({ mesh, outline }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const animRef = useRef<number>(0);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const outlineRef = useRef<THREE.Group | null>(null);

  // Initialize renderer once
  useEffect(() => {
    const mount = mountRef.current!;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      45,
      mount.clientWidth / mount.clientHeight,
      0.001,
      1000,
    );
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

    // Lighting — ambient high so texture reads true, directional for depth
    scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(3, 4, 5);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.3);
    fill.position.set(-3, -2, -3);
    scene.add(fill);

    const grid = new THREE.GridHelper(6, 24, 0x222233, 0x1a1a2e);
    scene.add(grid);

    const animate = () => {
      animRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    ro.observe(mount);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(animRef.current);
      renderer.dispose();
      if (mount.contains(renderer.domElement)) {
        mount.removeChild(renderer.domElement);
      }
    };
  }, []);

  // Swap mesh
  useEffect(() => {
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!scene) return;

    if (meshRef.current) {
      scene.remove(meshRef.current);
      meshRef.current.geometry.dispose();
      const mats = Array.isArray(meshRef.current.material)
        ? meshRef.current.material
        : [meshRef.current.material];
      const disposedTextures = new Set<THREE.Texture>();
      for (const m of mats) {
        const sm = m as THREE.MeshStandardMaterial;
        for (const tex of [sm.map, sm.normalMap]) {
          if (tex && !disposedTextures.has(tex)) {
            tex.dispose();
            disposedTextures.add(tex);
          }
        }
        m.dispose();
      }
      meshRef.current = null;
    }

    if (mesh && camera && controls) {
      scene.add(mesh);
      meshRef.current = mesh;

      const box = new THREE.Box3().setFromObject(mesh);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3()).length();
      camera.position.copy(center).add(new THREE.Vector3(0, 0, size * 1.6));
      camera.lookAt(center);
      controls.target.copy(center);
      controls.update();
    }
  }, [mesh]);

  // Swap outline
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    if (outlineRef.current) {
      scene.remove(outlineRef.current);
      outlineRef.current.traverse((obj) => {
        if (obj instanceof THREE.LineLoop || obj instanceof THREE.LineSegments) {
          obj.geometry.dispose();
          (obj.material as THREE.Material).dispose();
        }
      });
      outlineRef.current = null;
    }

    if (outline) {
      scene.add(outline);
      outlineRef.current = outline;
    }
  }, [outline]);

  return (
    <div
      ref={mountRef}
      style={{ width: '100%', height: '100%', background: '#0d1117' }}
    />
  );
}
