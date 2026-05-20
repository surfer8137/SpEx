'use client';
import { useState, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import * as THREE from 'three';
import ImageUploader from '../components/ImageUploader';
import SettingsPanel from '../components/SettingsPanel';
import TextureMapsPanel from '../components/TextureMapsPanel';
import ExportButtons from '../components/ExportButtons';
import ContourDebug from '../components/ContourDebug';
import MeshStatsPanel from '../components/MeshStatsPanel';
import { generateMask } from '../lib/maskGenerator';
import { extractContour, type ContourResult } from '../lib/contourExtractor';
import { buildExtrudedMesh, buildLatheMesh, buildOutline, type MeshStats } from '../lib/meshBuilder';
import type { AppSettings } from '../types';

const ThreeViewport = dynamic(() => import('../components/ThreeViewport'), {
  ssr: false,
});

const DEFAULT_SETTINGS: AppSettings = {
  extrusionDepth: 0.05,
  simplifyTolerance: 1,
  scale: 2,
  backgroundMode: 'auto',
  sideMode: 'image',
  sideColor: '#888888',
  faceMode: 'front',
  outlineEnabled: false,
  outlineColor: '#000000',
  outlineOpacity: 1,
  normalMapEnabled: false,
  normalMapStrength: 2,
  reliefEnabled: false,
  reliefStrength: 0.04,
  latheMode: false,
  latheSegments: 32,
  latheClosed: true,
  latheStretchTexture: true,
  latheColumnWidth: 0,
};

type StatusKind = 'idle' | 'working' | 'ok' | 'error';

export default function Home() {
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageData, setImageData] = useState<ImageData | null>(null);
  const [backImageFile, setBackImageFile] = useState<File | null>(null);
  const [backImageData, setBackImageData] = useState<ImageData | null>(null);
  // Directional side images (for lr / lrtb face modes)
  const [rightSideFile, setRightSideFile] = useState<File | null>(null);
  const [rightSideData, setRightSideData] = useState<ImageData | null>(null);
  const [leftSideFile, setLeftSideFile] = useState<File | null>(null);
  const [leftSideData, setLeftSideData] = useState<ImageData | null>(null);
  const [topSideFile, setTopSideFile] = useState<File | null>(null);
  const [topSideData, setTopSideData] = useState<ImageData | null>(null);
  const [bottomSideFile, setBottomSideFile] = useState<File | null>(null);
  const [bottomSideData, setBottomSideData] = useState<ImageData | null>(null);
  // Uploaded PBR maps
  const [normalMapFile, setNormalMapFile] = useState<File | null>(null);
  const [normalMapData, setNormalMapData] = useState<ImageData | null>(null);
  const [roughnessFile, setRoughnessFile] = useState<File | null>(null);
  const [roughnessData, setRoughnessData] = useState<ImageData | null>(null);
  const [metallicFile, setMetallicFile] = useState<File | null>(null);
  const [metallicData, setMetallicData] = useState<ImageData | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [mesh, setMesh] = useState<THREE.Mesh | null>(null);
  const [outline, setOutline] = useState<THREE.Group | null>(null);
  const [contour, setContour] = useState<ContourResult | null>(null);
  const [meshStats, setMeshStats] = useState<MeshStats | null>(null);
  const [statusText, setStatusText] = useState('Upload a PNG to start');
  const [statusKind, setStatusKind] = useState<StatusKind>('idle');
  const [showDebug, setShowDebug] = useState(false);
  // Preset overrides tolerance for rebuild without touching slider state
  const [presetTol, setPresetTol] = useState<number | null>(null);

  const runId = useRef(0);

  // toleranceOverride takes priority over settings.simplifyTolerance
  const process = useCallback(
    async (
      imgData: ImageData,
      s: AppSettings,
      toleranceOverride?: number,
      backImg?: ImageData,
      normalImg?: ImageData,
      roughnessImg?: ImageData,
      metallicImg?: ImageData,
      rightSideImg?: ImageData,
      leftSideImg?: ImageData,
      topSideImg?: ImageData,
      bottomSideImg?: ImageData,
    ) => {
      const id = ++runId.current;
      setStatusKind('working');
      const tol = toleranceOverride ?? s.simplifyTolerance;

      try {
        setStatusText('Generating mask…');
        const { mask, width, height } = generateMask(imgData, s.backgroundMode);

        if (!s.latheMode) {
          setStatusText('Extracting contour…');
        }
        const found = s.latheMode ? null : await extractContour(mask, width, height, tol);

        if (id !== runId.current) return;

        setStatusText('Building mesh…');

        let newMesh: THREE.Mesh;
        let stats: MeshStats;
        let newOutline = null;

        if (s.latheMode) {
          // Lathe: revolve right-side silhouette profile 360° — skip contour
          setContour(null);
          ({ mesh: newMesh, stats } = buildLatheMesh(mask, imgData, {
            scale: s.scale,
            latheSegments: s.latheSegments,
            latheClosed: s.latheClosed,
            latheStretchTexture: s.latheStretchTexture,
            latheColumnWidth: s.latheColumnWidth,
            normalMapEnabled: s.normalMapEnabled,
            normalMapStrength: s.normalMapStrength,
            uploadedNormalMap: normalImg,
            uploadedRoughnessMap: roughnessImg,
            uploadedMetallicMap: metallicImg,
          }));
        } else {
          if (!found || found.outer.length < 3) {
            setStatusText('No contour — try different background mode or lower tolerance.');
            setStatusKind('error');
            return;
          }
          setContour(found);
          ({ mesh: newMesh, stats } = buildExtrudedMesh(found, imgData, {
            depth: s.extrusionDepth,
            scale: s.scale,
            sideMode: s.sideMode,
            sideColor: s.sideColor,
            faceMode: s.faceMode,
            normalMapEnabled: s.normalMapEnabled,
            normalMapStrength: s.normalMapStrength,
            backImageData: s.faceMode !== 'front' ? backImg : undefined,
            sideImages: {
              right: (s.faceMode === 'front-back-lr' || s.faceMode === 'front-back-lrtb') ? rightSideImg : undefined,
              left:  (s.faceMode === 'front-back-lr' || s.faceMode === 'front-back-lrtb') ? leftSideImg  : undefined,
              top:   s.faceMode === 'front-back-lrtb' ? topSideImg    : undefined,
              bottom: s.faceMode === 'front-back-lrtb' ? bottomSideImg : undefined,
            },
            reliefEnabled: s.reliefEnabled,
            reliefStrength: s.reliefStrength,
            uploadedNormalMap: normalImg,
            uploadedRoughnessMap: roughnessImg,
            uploadedMetallicMap: metallicImg,
          }));
          newOutline = s.outlineEnabled
            ? buildOutline(found, imgData, {
                depth: s.extrusionDepth,
                scale: s.scale,
                color: s.outlineColor,
                opacity: s.outlineOpacity,
              })
            : null;
        }

        if (id !== runId.current) return;

        setMesh(newMesh);
        setOutline(newOutline);
        setMeshStats(stats);
        setStatusText(`${stats.triangles} tris · ${stats.holes} holes`);
        setStatusKind('ok');
      } catch (err) {
        if (id !== runId.current) return;
        setStatusText((err as Error).message);
        setStatusKind('error');
      }
    },
    [],
  );

  // Helper to get current extra textures, gated by faceMode
  const extraMaps = useCallback((s: AppSettings) => ({
    back:      s.faceMode !== 'front' ? backImageData ?? undefined : undefined,
    normal:    normalMapData   ?? undefined,
    roughness: roughnessData   ?? undefined,
    metallic:  metallicData    ?? undefined,
    right:     (s.faceMode === 'front-back-lr' || s.faceMode === 'front-back-lrtb') ? rightSideData ?? undefined : undefined,
    left:      (s.faceMode === 'front-back-lr' || s.faceMode === 'front-back-lrtb') ? leftSideData  ?? undefined : undefined,
    top:       s.faceMode === 'front-back-lrtb' ? topSideData    ?? undefined : undefined,
    bottom:    s.faceMode === 'front-back-lrtb' ? bottomSideData ?? undefined : undefined,
  }), [backImageData, normalMapData, roughnessData, metallicData, rightSideData, leftSideData, topSideData, bottomSideData]);

  const reprocess = useCallback((imgData: ImageData, s: AppSettings, tol?: number) => {
    const m = extraMaps(s);
    process(imgData, s, tol, m.back, m.normal, m.roughness, m.metallic, m.right, m.left, m.top, m.bottom);
  }, [process, extraMaps]);

  const handleImage = useCallback(
    (file: File, imgData: ImageData) => {
      setImageFile(file);
      setImageData(imgData);
      reprocess(imgData, settings, presetTol ?? undefined);
    },
    [settings, presetTol, reprocess],
  );

  const handleBackImage = useCallback(
    (file: File, imgData: ImageData) => {
      setBackImageFile(file);
      setBackImageData(imgData);
      if (imageData) {
        const m = extraMaps(settings);
        process(imageData, settings, presetTol ?? undefined, imgData, m.normal, m.roughness, m.metallic, m.right, m.left, m.top, m.bottom);
      }
    },
    [imageData, settings, presetTol, process, extraMaps],
  );

  const handleSideImage = useCallback(
    (kind: 'right' | 'left' | 'top' | 'bottom', file: File, imgData: ImageData) => {
      if (kind === 'right')  { setRightSideFile(file);  setRightSideData(imgData); }
      if (kind === 'left')   { setLeftSideFile(file);   setLeftSideData(imgData); }
      if (kind === 'top')    { setTopSideFile(file);    setTopSideData(imgData); }
      if (kind === 'bottom') { setBottomSideFile(file); setBottomSideData(imgData); }
      if (imageData) {
        const m = extraMaps(settings);
        const r     = kind === 'right'  ? imgData : m.right;
        const l     = kind === 'left'   ? imgData : m.left;
        const t     = kind === 'top'    ? imgData : m.top;
        const bot   = kind === 'bottom' ? imgData : m.bottom;
        process(imageData, settings, presetTol ?? undefined, m.back, m.normal, m.roughness, m.metallic, r, l, t, bot);
      }
    },
    [imageData, settings, presetTol, process, extraMaps],
  );

  const handleSideClear = useCallback(
    (kind: 'right' | 'left' | 'top' | 'bottom') => {
      if (kind === 'right')  { setRightSideFile(null);  setRightSideData(null); }
      if (kind === 'left')   { setLeftSideFile(null);   setLeftSideData(null); }
      if (kind === 'top')    { setTopSideFile(null);    setTopSideData(null); }
      if (kind === 'bottom') { setBottomSideFile(null); setBottomSideData(null); }
      if (imageData) {
        const m = extraMaps(settings);
        const r   = kind === 'right'  ? undefined : m.right;
        const l   = kind === 'left'   ? undefined : m.left;
        const t   = kind === 'top'    ? undefined : m.top;
        const bot = kind === 'bottom' ? undefined : m.bottom;
        process(imageData, settings, presetTol ?? undefined, m.back, m.normal, m.roughness, m.metallic, r, l, t, bot);
      }
    },
    [imageData, settings, presetTol, process, extraMaps],
  );

  const handleMapUpload = useCallback(
    (kind: 'normal' | 'roughness' | 'metallic', file: File, imgData: ImageData) => {
      if (kind === 'normal')    { setNormalMapFile(file);  setNormalMapData(imgData); }
      if (kind === 'roughness') { setRoughnessFile(file);  setRoughnessData(imgData); }
      if (kind === 'metallic')  { setMetallicFile(file);   setMetallicData(imgData); }
      if (imageData) {
        const m = extraMaps(settings);
        const n  = kind === 'normal'    ? imgData : m.normal;
        const rg = kind === 'roughness' ? imgData : m.roughness;
        const me = kind === 'metallic'  ? imgData : m.metallic;
        process(imageData, settings, presetTol ?? undefined, m.back, n, rg, me, m.right, m.left, m.top, m.bottom);
      }
    },
    [imageData, settings, presetTol, process, extraMaps],
  );

  const handleMapClear = useCallback(
    (kind: 'normal' | 'roughness' | 'metallic') => {
      if (kind === 'normal')    { setNormalMapFile(null);  setNormalMapData(null); }
      if (kind === 'roughness') { setRoughnessFile(null);  setRoughnessData(null); }
      if (kind === 'metallic')  { setMetallicFile(null);   setMetallicData(null); }
      if (imageData) {
        const m = extraMaps(settings);
        const n  = kind === 'normal'    ? undefined : m.normal;
        const rg = kind === 'roughness' ? undefined : m.roughness;
        const me = kind === 'metallic'  ? undefined : m.metallic;
        process(imageData, settings, presetTol ?? undefined, m.back, n, rg, me, m.right, m.left, m.top, m.bottom);
      }
    },
    [imageData, settings, presetTol, process, extraMaps],
  );

  // Slider/setting change → clears any active preset
  const handleSettings = useCallback(
    (s: AppSettings) => {
      setPresetTol(null);
      setSettings(s);
      if (imageData) reprocess(imageData, s);
    },
    [imageData, reprocess],
  );

  // Preset click → rebuilds with override tol, sliders unchanged
  const handlePreset = useCallback(
    (tol: number) => {
      setPresetTol(tol);
      if (imageData) reprocess(imageData, settings, tol);
    },
    [imageData, settings, reprocess],
  );

  const useBackImage = settings.faceMode !== 'front';
  const showLRSides  = settings.faceMode === 'front-back-lr' || settings.faceMode === 'front-back-lrtb';
  const showTBSides  = settings.faceMode === 'front-back-lrtb';

  return (
    <main className="app">
      <aside className="sidebar">
        <h1 className="logo">SpEx</h1>

        <ImageUploader onImage={handleImage} currentFile={imageFile} label="Front / Both faces" />

        {useBackImage && (
          <ImageUploader onImage={handleBackImage} currentFile={backImageFile} label="Back face" />
        )}

        {showLRSides && (
          <>
            <ImageUploader
              onImage={(file, imgData) => handleSideImage('right', file, imgData)}
              currentFile={rightSideFile}
              label="Right side"
            />
            <ImageUploader
              onImage={(file, imgData) => handleSideImage('left', file, imgData)}
              currentFile={leftSideFile}
              label="Left side"
            />
          </>
        )}

        {showTBSides && (
          <>
            <ImageUploader
              onImage={(file, imgData) => handleSideImage('top', file, imgData)}
              currentFile={topSideFile}
              label="Top side"
            />
            <ImageUploader
              onImage={(file, imgData) => handleSideImage('bottom', file, imgData)}
              currentFile={bottomSideFile}
              label="Bottom side"
            />
          </>
        )}

        <SettingsPanel
          settings={settings}
          onChange={handleSettings}
          disabled={statusKind === 'working'}
        />

        <TextureMapsPanel
          normalFile={normalMapFile}
          roughnessFile={roughnessFile}
          metallicFile={metallicFile}
          onUpload={handleMapUpload}
          onClear={handleMapClear}
          disabled={statusKind === 'working'}
        />

        <div
          className={`status ${statusKind === 'error' ? 'error' : statusKind === 'ok' ? 'ok' : ''}`}
        >
          {statusKind === 'working' && <span className="spinner" />}
          {statusText}
        </div>

        {meshStats && (
          <MeshStatsPanel
            stats={meshStats}
            activeTol={presetTol}
            onPreset={handlePreset}
            disabled={statusKind === 'working'}
          />
        )}

        {imageData && contour && (
          <button
            className="debug-toggle"
            onClick={() => setShowDebug((v) => !v)}
          >
            {showDebug ? 'Hide' : 'Show'} contour debug
          </button>
        )}

        <ExportButtons mesh={mesh} />
      </aside>

      <section className="viewport">
        <ThreeViewport mesh={mesh} outline={outline} />
        {showDebug && imageData && contour && (
          <ContourDebug imageData={imageData} contour={contour} />
        )}
        <div className="viewport-hint">
          Drag to orbit · Scroll to zoom · Right-drag to pan
        </div>
      </section>
    </main>
  );
}
