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
import FaceEditorPanel from '../components/FaceEditorPanel';
import { generateMask } from '../lib/maskGenerator';
import { extractContour, type ContourResult } from '../lib/contourExtractor';
import { buildExtrudedMesh, buildBoxMesh, buildLatheMesh, buildOutline, type MeshStats } from '../lib/meshBuilder';
import { buildSkinnedMesh } from '../lib/rigBuilder';
import type { AppSettings, FaceOffsets } from '../types';
import type { MixamoMarkers } from '../types/rig';
import { DEFAULT_MIXAMO_MARKERS, deriveFullMarkers } from '../types/rig';
import type { RigTestAnimationId } from '../lib/walkAnimation';

const ThreeViewport = dynamic(() => import('../components/ThreeViewport'), {
  ssr: false,
});

const RiggerModal = dynamic(() => import('../components/RiggerModal'), { ssr: false });
const AtlasMapperModal = dynamic(() => import('../components/AtlasMapperModal'), { ssr: false });

const DEFAULT_SETTINGS: AppSettings = {
  extrusionDepth: 0.05,
  simplifyTolerance: 0.5,
  scale: 1,
  backgroundMode: 'auto',
  sideMode: 'image',
  sideColor: '#888888',
  boxFillColor: '#5f5f5f',
  boxFillMode: 'edge-stretch',
  faceMode: 'front',
  outlineEnabled: false,
  outlineColor: '#000000',
  outlineOpacity: 1,
  normalMapEnabled: false,
  normalMapStrength: 2,
  reliefEnabled: false,
  reliefStrength: 0.04,
  boxMode: false,
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
  // One image / Per face toggle
  const [textureMode, setTextureMode] = useState<'single' | 'multi'>('multi');
  const [atlasFile, setAtlasFile] = useState<File | null>(null);
  const [atlasImageData, setAtlasImageData] = useState<ImageData | null>(null);
  const [pendingAtlasData, setPendingAtlasData] = useState<ImageData | null>(null);
  const [showAtlasMapper, setShowAtlasMapper] = useState(false);
  // Face Editor state
  const [faceOffsets, setFaceOffsets] = useState<FaceOffsets>({});
  const [weldFaces, setWeldFaces] = useState(true);
  // Camera reset key — increment to trigger fit
  const [cameraResetKey, setCameraResetKey] = useState(0);
  // Rig animation preview state
  const [isRigged, setIsRigged] = useState(false);
  const [selectedAnimation, setSelectedAnimation] = useState<RigTestAnimationId>('walk');
  const [playAnimation, setPlayAnimation] = useState(false);
  // Rigger state
  const [showRigger, setShowRigger] = useState(false);
  const [rigMarkers, setRigMarkers] = useState<MixamoMarkers>(DEFAULT_MIXAMO_MARKERS);
  const [rigSymmetry, setRigSymmetry] = useState(true);

  const runId = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      offsets?: FaceOffsets,
      weld?: boolean,
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

        if (s.boxMode && !s.latheMode) {
          // Box: 6 flat panels — skip contour extraction entirely
          setContour(null);
          ({ mesh: newMesh, stats } = buildBoxMesh(imgData, {
            depth: s.extrusionDepth,
            scale: s.scale,
            sideMode: s.sideMode,
            sideColor: s.sideColor,
            boxFillColor: s.boxFillColor,
            boxFillMode: s.boxFillMode,
            faceMode: s.faceMode,
            normalMapEnabled: s.normalMapEnabled,
            normalMapStrength: s.normalMapStrength,
            backImageData: s.faceMode !== 'front' ? backImg : undefined,
            sideImages: {
              right:  (s.faceMode === 'front-back-lr' || s.faceMode === 'front-back-lrtb') ? rightSideImg : undefined,
              left:   (s.faceMode === 'front-back-lr' || s.faceMode === 'front-back-lrtb') ? leftSideImg  : undefined,
              top:    s.faceMode === 'front-back-lrtb' ? topSideImg    : undefined,
              bottom: s.faceMode === 'front-back-lrtb' ? bottomSideImg : undefined,
            },
            reliefEnabled: false,
            reliefStrength: 0,
            uploadedNormalMap: normalImg,
            uploadedRoughnessMap: roughnessImg,
            uploadedMetallicMap: metallicImg,
            faceOffsets: offsets,
            weldFaces: weld,
          }));
        } else if (s.latheMode) {
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

        // Translate so bottom of mesh sits at Y=0 (ground level).
        if (newMesh) {
          newMesh.geometry.computeBoundingBox();
          const minY = newMesh.geometry.boundingBox!.min.y;
          if (minY !== 0) newMesh.geometry.translate(0, -minY, 0);
        }

        setMesh(newMesh);
        setOutline(newOutline);
        setMeshStats(stats);
        // New geometry → rig is gone
        setIsRigged(false);
        setPlayAnimation(false);
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

  const reprocess = useCallback((imgData: ImageData, s: AppSettings, tol?: number, offsets?: FaceOffsets, weld?: boolean) => {
    const m = extraMaps(s);
    process(imgData, s, tol, m.back, m.normal, m.roughness, m.metallic, m.right, m.left, m.top, m.bottom, offsets, weld);
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
        // First side image → auto-enable box mode for clean flat faces
        const activeSettings = !settings.boxMode ? { ...settings, boxMode: true } : settings;
        if (!settings.boxMode) setSettings(activeSettings);
        const m = extraMaps(activeSettings);
        const r   = kind === 'right'  ? imgData : m.right;
        const l   = kind === 'left'   ? imgData : m.left;
        const t   = kind === 'top'    ? imgData : m.top;
        const bot = kind === 'bottom' ? imgData : m.bottom;
        process(imageData, activeSettings, presetTol ?? undefined, m.back, m.normal, m.roughness, m.metallic, r, l, t, bot);
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
      if (!imageData) return;
      // Show working indicator immediately so user knows change was registered
      setStatusKind('working');
      setStatusText('Updating…');
      // Debounce: wait until slider stops moving before rebuilding mesh
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        reprocess(imageData, s);
      }, 200);
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

  // ── Face offset changes → rebuild ─────────────────────────────────────────
  const handleFaceOffsets = useCallback((offsets: FaceOffsets) => {
    setFaceOffsets(offsets);
    if (imageData) reprocess(imageData, settings, presetTol ?? undefined, offsets, weldFaces);
  }, [imageData, settings, presetTol, reprocess, weldFaces]);

  const handleWeldChange = useCallback((weld: boolean) => {
    setWeldFaces(weld);
    if (imageData) reprocess(imageData, settings, presetTol ?? undefined, faceOffsets, weld);
  }, [imageData, settings, presetTol, reprocess, faceOffsets]);

  const handleBuildRig = useCallback(() => {
    if (!mesh || !imageData) return;
    // For box-mode characters, force welded faces before rigging so animation
    // does not open gaps between panels.
    if (settings.boxMode && !weldFaces) {
      setWeldFaces(true);
      reprocess(imageData, settings, presetTol ?? undefined, faceOffsets, true);
      setStatusText('Weld faces enabled for rigging. Build Rig again.');
      setStatusKind('ok');
      return;
    }
    try {
      const fullMarkers = deriveFullMarkers(rigMarkers);
      const skinnedMesh = buildSkinnedMesh(mesh, fullMarkers, settings.scale, imageData.width, imageData.height);
      setMesh(skinnedMesh as unknown as THREE.Mesh);
      setIsRigged(true);
      setPlayAnimation(false);
      setShowRigger(false);
      setStatusText('Rig built — skeleton embedded in export');
      setStatusKind('ok');
    } catch (err) {
      setStatusText((err as Error).message);
      setStatusKind('error');
    }
  }, [mesh, imageData, rigMarkers, settings, weldFaces, reprocess, presetTol, faceOffsets]);

  // ── Atlas (single-image) helpers ───────────────────────────────────────────
  const handleAtlasImage = useCallback((file: File, atlas: ImageData) => {
    setAtlasFile(file);
    setAtlasImageData(atlas);
    if (settings.faceMode === 'front') {
      setImageFile(file);
      setImageData(atlas);
      reprocess(atlas, settings, presetTol ?? undefined);
    } else {
      setPendingAtlasData(atlas);
      setShowAtlasMapper(true);
    }
  }, [settings, presetTol, reprocess]);

  const handleAtlasConfirm = useCallback((faces: Partial<Record<'front'|'back'|'left'|'right'|'top'|'bottom', ImageData>>) => {
    setShowAtlasMapper(false);
    setPendingAtlasData(null);

    const front  = faces.front  ?? null;
    const back   = faces.back   ?? null;
    const right  = faces.right  ?? null;
    const left   = faces.left   ?? null;
    const top    = faces.top    ?? null;
    const bottom = faces.bottom ?? null;
    if (!front) return;

    setImageFile(atlasFile);        setImageData(front);
    setBackImageFile(back   ? atlasFile : null); setBackImageData(back);
    setRightSideFile(right  ? atlasFile : null); setRightSideData(right);
    setLeftSideFile(left    ? atlasFile : null);  setLeftSideData(left);
    setTopSideFile(top      ? atlasFile : null);  setTopSideData(top);
    setBottomSideFile(bottom? atlasFile : null);  setBottomSideData(bottom);

    const hasLR = !!(right || left);
    const activeSettings = (hasLR && !settings.boxMode) ? { ...settings, boxMode: true } : settings;
    if (hasLR && !settings.boxMode) setSettings(activeSettings);

    const m = extraMaps(activeSettings);
    process(front, activeSettings, presetTol ?? undefined,
      back ?? undefined, m.normal, m.roughness, m.metallic,
      right ?? undefined, left ?? undefined, top ?? undefined, bottom ?? undefined);
  }, [atlasFile, settings, presetTol, process, extraMaps]);

  const useBackImage = settings.faceMode !== 'front';
  const showLRSides  = settings.faceMode === 'front-back-lr' || settings.faceMode === 'front-back-lrtb';
  const showTBSides  = settings.faceMode === 'front-back-lrtb';

  // Build data-URL thumbnails from uploaded ImageData for face editor cards
  function imgDataToUrl(imgData: ImageData | null): string | undefined {
    if (!imgData) return undefined;
    const c = document.createElement('canvas');
    c.width = imgData.width; c.height = imgData.height;
    c.getContext('2d')!.putImageData(imgData, 0, 0);
    return c.toDataURL();
  }
  const faceThumbnails: Partial<Record<import('../types').FaceName, string>> = {
    front:  imgDataToUrl(imageData),
    back:   imgDataToUrl(backImageData),
    right:  imgDataToUrl(rightSideData),
    left:   imgDataToUrl(leftSideData),
    top:    imgDataToUrl(topSideData),
    bottom: imgDataToUrl(bottomSideData),
  };
  // Remove undefined keys
  (Object.keys(faceThumbnails) as import('../types').FaceName[]).forEach(k => {
    if (!faceThumbnails[k]) delete faceThumbnails[k];
  });

  return (
    <main className="app">
      <aside className="sidebar">
        <h1 className="logo">SpEx</h1>

        <label className="face-mode-select">
          Face Mode
          <select
            title="Choose how many model faces are generated and textured."
            value={settings.faceMode}
            onChange={(e) => {
              const fm = e.target.value as import('../types').FaceMode;
              // Auto-enable box mode for multi-sided modes — silhouette extrusion
              // can't display side face images cleanly (edge-quad geometry).
              const autoBox = fm === 'front-back-lr' || fm === 'front-back-lrtb';
              handleSettings({ ...settings, faceMode: fm, boxMode: autoBox || settings.boxMode });
            }}
          >
            <option value="front">Front only</option>
            <option value="front-back">Front + Back</option>
            <option value="front-back-lr">Front + Back + Left/Right</option>
            <option value="front-back-lrtb">Front + Back + All sides</option>
          </select>
        </label>

        {/* One image / Per face toggle — hidden in front-only mode */}
        {settings.faceMode !== 'front' && (
          <div className="texture-mode-toggle">
            <button
              className={textureMode === 'single' ? 'active' : ''}
              title="Upload one image split into equal horizontal tiles (front|back|right|left|top|bottom)."
              onClick={() => setTextureMode('single')}
            >One image</button>
            <button
              className={textureMode === 'multi' ? 'active' : ''}
              title="Upload a separate image per face."
              onClick={() => setTextureMode('multi')}
            >Per face</button>
          </div>
        )}

        {textureMode === 'single' && settings.faceMode !== 'front' ? (
          <>
            <ImageUploader
              onImage={handleAtlasImage}
              currentFile={atlasFile}
              label={
                settings.faceMode === 'front-back'   ? 'Atlas (front | back)' :
                settings.faceMode === 'front-back-lr' ? 'Atlas (front | back | right | left)' :
                                                        'Atlas (front | back | right | left | top | bottom)'
              }
            />
            {atlasImageData && (
              <button
                className="readjust-btn"
                title="Re-map atlas tiles; changes which texture goes to each model face."
                onClick={() => { setPendingAtlasData(atlasImageData); setShowAtlasMapper(true); }}
              >
                🗺 Re-adjust face tiles
              </button>
            )}
          </>
        ) : (
          <>
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
          </>
        )}

        <SettingsPanel
          settings={settings}
          onChange={handleSettings}
          disabled={statusKind === 'working'}
          imageWidth={imageData?.width}
          hasMesh={!!mesh}
          isRigged={isRigged}
          selectedAnimation={selectedAnimation}
          isAnimationPlaying={playAnimation}
          onOpenRigger={() => setShowRigger(true)}
          onAnimationChange={setSelectedAnimation}
          onAnimationPlay={() => setPlayAnimation(true)}
          onAnimationStop={() => setPlayAnimation(false)}
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
            title="Toggle contour debug overlay; helps inspect geometry extraction inputs."
            onClick={() => setShowDebug((v) => !v)}
          >
            {showDebug ? 'Hide' : 'Show'} contour debug
          </button>
        )}

        <ExportButtons mesh={mesh} />
      </aside>

      <section className="viewport">
        <ThreeViewport
          mesh={mesh}
          outline={outline}
          cameraResetKey={cameraResetKey}
          playAnimation={playAnimation}
          animationId={selectedAnimation}
        />
        <button
          className="reset-camera-btn"
          title="Reset camera"
          onClick={() => setCameraResetKey(k => k + 1)}
        >
          ⟳ Camera
        </button>
        {showDebug && imageData && contour && (
          <ContourDebug imageData={imageData} contour={contour} />
        )}
        <div className="viewport-hint">
          Drag to orbit · Scroll to zoom · Right-drag to pan
        </div>
      </section>

      {settings.boxMode && (
        <FaceEditorPanel
          faceMode={settings.faceMode}
          offsets={faceOffsets}
          thumbnails={faceThumbnails}
          onChange={handleFaceOffsets}
          disabled={statusKind === 'working'}
          weldFaces={weldFaces}
          onWeldChange={handleWeldChange}
        />
      )}

      {showAtlasMapper && pendingAtlasData && (
        <AtlasMapperModal
          imageData={pendingAtlasData}
          faceMode={settings.faceMode}
          onConfirm={handleAtlasConfirm}
          onClose={() => { setShowAtlasMapper(false); setPendingAtlasData(null); }}
        />
      )}

      {showRigger && imageData && (
        <RiggerModal
          imageData={imageData}
          markers={rigMarkers}
          onMarkersChange={setRigMarkers}
          useSymmetry={rigSymmetry}
          onSymmetryChange={setRigSymmetry}
          onBuild={handleBuildRig}
          onClose={() => setShowRigger(false)}
        />
      )}
    </main>
  );
}
