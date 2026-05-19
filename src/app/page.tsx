'use client';
import { useState, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import * as THREE from 'three';
import ImageUploader from '../components/ImageUploader';
import SettingsPanel from '../components/SettingsPanel';
import ExportButtons from '../components/ExportButtons';
import ContourDebug from '../components/ContourDebug';
import MeshStatsPanel from '../components/MeshStatsPanel';
import { generateMask } from '../lib/maskGenerator';
import { extractContour, type ContourResult } from '../lib/contourExtractor';
import { buildExtrudedMesh, buildOutline, type MeshStats } from '../lib/meshBuilder';
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
  outlineEnabled: false,
  outlineColor: '#000000',
  outlineOpacity: 1,
  normalMapEnabled: false,
  normalMapStrength: 2,
  reliefEnabled: false,
  reliefStrength: 0.04,
};

type StatusKind = 'idle' | 'working' | 'ok' | 'error';

export default function Home() {
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageData, setImageData] = useState<ImageData | null>(null);
  const [useBackImage, setUseBackImage] = useState(false);
  const [backImageFile, setBackImageFile] = useState<File | null>(null);
  const [backImageData, setBackImageData] = useState<ImageData | null>(null);
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
    async (imgData: ImageData, s: AppSettings, toleranceOverride?: number, backImg?: ImageData) => {
      const id = ++runId.current;
      setStatusKind('working');
      const tol = toleranceOverride ?? s.simplifyTolerance;

      try {
        setStatusText('Generating mask…');
        const { mask, width, height } = generateMask(imgData, s.backgroundMode);

        setStatusText('Extracting contour…');
        const found = await extractContour(mask, width, height, tol);

        if (id !== runId.current) return;

        if (!found || found.outer.length < 3) {
          setStatusText('No contour — try different background mode or lower tolerance.');
          setStatusKind('error');
          return;
        }

        setContour(found);
        setStatusText('Building mesh…');

        const { mesh: newMesh, stats } = buildExtrudedMesh(found, imgData, {
          depth: s.extrusionDepth,
          scale: s.scale,
          sideMode: s.sideMode,
          sideColor: s.sideColor,
          normalMapEnabled: s.normalMapEnabled,
          normalMapStrength: s.normalMapStrength,
          backImageData: backImg,
          reliefEnabled: s.reliefEnabled,
          reliefStrength: s.reliefStrength,
        });

        const newOutline = s.outlineEnabled
          ? buildOutline(found, imgData, {
              depth: s.extrusionDepth,
              scale: s.scale,
              color: s.outlineColor,
              opacity: s.outlineOpacity,
            })
          : null;

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

  const handleImage = useCallback(
    (file: File, imgData: ImageData) => {
      setImageFile(file);
      setImageData(imgData);
      process(imgData, settings, presetTol ?? undefined, useBackImage ? backImageData ?? undefined : undefined);
    },
    [settings, presetTol, process, useBackImage, backImageData],
  );

  const handleBackImage = useCallback(
    (file: File, imgData: ImageData) => {
      setBackImageFile(file);
      setBackImageData(imgData);
      if (imageData) process(imageData, settings, presetTol ?? undefined, imgData);
    },
    [imageData, settings, presetTol, process],
  );

  const handleToggleBackImage = useCallback(
    (enabled: boolean) => {
      setUseBackImage(enabled);
      if (!enabled) setBackImageFile(null);
      if (imageData) process(imageData, settings, presetTol ?? undefined, enabled ? backImageData ?? undefined : undefined);
    },
    [imageData, settings, presetTol, process, backImageData],
  );

  // Slider/setting change → clears any active preset
  const handleSettings = useCallback(
    (s: AppSettings) => {
      setPresetTol(null);
      setSettings(s);
      if (imageData) process(imageData, s, undefined, useBackImage ? backImageData ?? undefined : undefined);
    },
    [imageData, process, useBackImage, backImageData],
  );

  // Preset click → rebuilds with override tol, sliders unchanged
  const handlePreset = useCallback(
    (tol: number) => {
      setPresetTol(tol);
      if (imageData) process(imageData, settings, tol, useBackImage ? backImageData ?? undefined : undefined);
    },
    [imageData, settings, process, useBackImage, backImageData],
  );

  return (
    <main className="app">
      <aside className="sidebar">
        <h1 className="logo">SpEx</h1>

        <ImageUploader onImage={handleImage} currentFile={imageFile} label="Front / Both faces" />

        <label className="label-row back-face-toggle">
          <input
            type="checkbox"
            checked={useBackImage}
            onChange={(e) => handleToggleBackImage(e.target.checked)}
          />
          Different back face image
        </label>

        {useBackImage && (
          <ImageUploader onImage={handleBackImage} currentFile={backImageFile} label="Back face" />
        )}

        <SettingsPanel
          settings={settings}
          onChange={handleSettings}
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
