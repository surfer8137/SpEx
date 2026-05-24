'use client';
import { useState } from 'react';
import type { AppSettings, FaceMode } from '../types';
import { RIG_TEST_ANIMATIONS, type RigTestAnimationId } from '../lib/walkAnimation';

interface Props {
  settings: AppSettings;
  onChange: (s: AppSettings) => void;
  disabled: boolean;
  imageWidth?: number;
  hasMesh?: boolean;
  isRigged?: boolean;
  selectedAnimation?: RigTestAnimationId;
  isAnimationPlaying?: boolean;
  onOpenRigger?: () => void;
  onAnimationChange?: (id: RigTestAnimationId) => void;
  onAnimationPlay?: () => void;
  onAnimationStop?: () => void;
}

// ── Reusable slider with editable number input + min/max labels ───────────────
function SliderField({
  label,
  value,
  min,
  max,
  step,
  decimals = 0,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  decimals?: number;
  onChange: (v: number) => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const fmt = (n: number) => decimals > 0 ? n.toFixed(decimals) : String(n);
  const clamp = (n: number) => Math.max(min, Math.min(max, n));

  return (
    <div className="slider-field">
      <div className="slider-header">
        <span className="slider-label">{label}</span>
        <input
          type="number"
          className="val-input"
          title={`Adjust ${label}; this changes model geometry or shading intensity.`}
          value={draft ?? fmt(value)}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== null) {
              const n = parseFloat(draft);
              if (!isNaN(n)) onChange(clamp(parseFloat(n.toFixed(decimals > 0 ? decimals : 10))));
              setDraft(null);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      <input
        type="range"
        title={`Slide ${label}; this changes model geometry or shading intensity.`}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => { setDraft(null); onChange(parseFloat(e.target.value)); }}
        disabled={disabled}
      />
      <div className="slider-minmax">
        <span>{fmt(min)}</span>
        <span>{fmt(max)}</span>
      </div>
    </div>
  );
}

// ── Collapsible section ───────────────────────────────────────────────────────
function Section({ title, open = false, children }: { title: string; open?: boolean; children: React.ReactNode }) {
  return (
    <details className="settings-section" open={open}>
      <summary className="settings-section-title">{title}</summary>
      <div className="settings-section-body">{children}</div>
    </details>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────
export default function SettingsPanel({
  settings,
  onChange,
  disabled,
  imageWidth,
  hasMesh,
  isRigged,
  selectedAnimation = 'walk',
  isAnimationPlaying = false,
  onOpenRigger,
  onAnimationChange,
  onAnimationPlay,
  onAnimationStop,
}: Props) {
  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    onChange({ ...settings, [key]: value });

  return (
    <div className="settings-panel">
      <h3>Settings</h3>

      {/* ── Shape ─────────────────────────────────── */}
      <Section title="📐 Shape" open={!settings.latheMode}>
        <label>
          Background Mode
          <select
            title="Choose background detection; affects which pixels become model geometry."
            value={settings.backgroundMode}
            onChange={(e) => update('backgroundMode', e.target.value as AppSettings['backgroundMode'])}
            disabled={disabled}
          >
            <option value="auto">Auto</option>
            <option value="alpha">Alpha Channel</option>
            <option value="white">White Background</option>
          </select>
        </label>

        {!settings.latheMode && (
          <>
            <SliderField
              label="Extrusion Depth"
              value={settings.extrusionDepth}
              min={0.01} max={2} step={0.01} decimals={2}
              onChange={(v) => update('extrusionDepth', v)}
              disabled={disabled}
            />

            <SliderField
              label="Simplify Tolerance"
              value={settings.simplifyTolerance}
              min={0.5} max={15} step={0.5} decimals={1}
              onChange={(v) => update('simplifyTolerance', v)}
              disabled={disabled}
            />
          </>
        )}

        <SliderField
          label="Scale"
          value={settings.scale}
          min={0.5} max={5} step={0.1} decimals={1}
          onChange={(v) => update('scale', v)}
          disabled={disabled}
        />
      </Section>

      {/* ── Box Mode ──────────────────────────────── */}
      {!settings.latheMode && settings.faceMode !== 'front' && (
        <Section title="📦 Box Mode" open={settings.boxMode}>
          <label className="label-row">
            <input
              type="checkbox"
              title="Build a 6-face box from face images; switches from silhouette extrusion to panel model."
              checked={settings.boxMode}
              onChange={(e) => update('boxMode', e.target.checked)}
              disabled={disabled}
            />
            Build from face images (box mesh)
          </label>
          {settings.boxMode && (
            <p style={{ fontSize: '0.76rem', color: 'var(--text-muted, #aaa)', margin: 0 }}>
              6 flat panels. Best for buildings &amp; props.
              Use Extrusion Depth to set thickness.
            </p>
          )}
        </Section>
      )}

      {/* ── 360° Revolution ───────────────────────── */}
      <Section title="🔄 360° Revolution" open={settings.latheMode}>
        <label className="label-row">
          <input
            type="checkbox"
            title="Enable 360° lathe; revolves profile into a radial model."
            checked={settings.latheMode}
            onChange={(e) => update('latheMode', e.target.checked)}
            disabled={disabled}
          />
          Enable Lathe (revolution 360°)
        </label>

        {settings.latheMode && (
          <>
            <SliderField
              label="Segments"
              value={settings.latheSegments}
              min={6} max={64} step={2} decimals={0}
              onChange={(v) => update('latheSegments', Math.round(v))}
              disabled={disabled}
            />

            <label className="label-row">
              <input
                type="checkbox"
                title="Close top and bottom caps; seals the lathed model."
                checked={settings.latheClosed}
                onChange={(e) => update('latheClosed', e.target.checked)}
                disabled={disabled}
              />
              Close caps (fill top &amp; bottom)
            </label>

            <label className="label-row">
              <input
                type="checkbox"
                title="Stretch texture to cover the full lathe surface."
                checked={settings.latheStretchTexture}
                onChange={(e) => update('latheStretchTexture', e.target.checked)}
                disabled={disabled}
              />
              Stretch texture (full coverage)
            </label>

            {settings.latheStretchTexture && (
              <SliderField
                label={`Strip width${settings.latheColumnWidth === 0 ? ' (auto)' : ' px'}`}
                value={settings.latheColumnWidth}
                min={0} max={imageWidth ?? 512} step={1} decimals={0}
                onChange={(v) => update('latheColumnWidth', Math.round(v))}
                disabled={disabled}
              />
            )}
          </>
        )}
      </Section>

      {/* ── Texture ───────────────────────────────── */}
      {!settings.latheMode && (
        <Section title="🎨 Texture">
          <label>
            Side Texture
            <select
              title="Select lateral texturing mode; changes side-face appearance."
              value={settings.sideMode}
              onChange={(e) => update('sideMode', e.target.value as AppSettings['sideMode'])}
              disabled={disabled}
            >
              <option value="image">Image (projected)</option>
              <option value="edge">Edge stretch</option>
              <option value="flat">Flat color</option>
            </select>
          </label>

          {settings.sideMode === 'flat' && (
            <label>
              Side Color
              <input
                type="color"
                title="Set flat side color; paints side faces with a solid color."
                value={settings.sideColor}
                onChange={(e) => update('sideColor', e.target.value)}
                disabled={disabled}
              />
            </label>
          )}

          {settings.boxMode && (
            <>
              <label>
                Gap Fill Mode
                <select
                  title="Choose how transparent texels are filled; changes gap appearance on box faces."
                  value={settings.boxFillMode}
                  onChange={(e) => update('boxFillMode', e.target.value as AppSettings['boxFillMode'])}
                  disabled={disabled}
                >
                  <option value="edge-stretch">Edge stretch</option>
                  <option value="flat-color">Flat color</option>
                  <option value="keep-transparent">Keep transparent</option>
                </select>
              </label>

              {settings.boxFillMode === 'flat-color' && (
                <label>
                  Gap Fill Color
                  <input
                    type="color"
                    title="Set fill color used for transparent texels in flat-color mode."
                    value={settings.boxFillColor}
                    onChange={(e) => update('boxFillColor', e.target.value)}
                    disabled={disabled}
                  />
                </label>
              )}
            </>
          )}
        </Section>
      )}

      {/* ── Effects ───────────────────────────────── */}
      <Section title="✨ Effects">
        <label className="label-row">
          <input
            type="checkbox"
            title="Show outer contour lines around the model."
            checked={settings.outlineEnabled}
            onChange={(e) => update('outlineEnabled', e.target.checked)}
            disabled={disabled}
          />
          Show Outline
        </label>

        {settings.outlineEnabled && (
          <>
            <label>
              Outline Color
              <input
                type="color"
                title="Set contour line color on the model."
                value={settings.outlineColor}
                onChange={(e) => update('outlineColor', e.target.value)}
                disabled={disabled}
              />
            </label>
            <SliderField
              label="Outline Opacity"
              value={settings.outlineOpacity}
              min={0.1} max={1} step={0.05} decimals={2}
              onChange={(v) => update('outlineOpacity', v)}
              disabled={disabled}
            />
          </>
        )}

        <label className="label-row">
          <input
            type="checkbox"
            title="Generate procedural normal map from texture luminance; adds lighting detail."
            checked={settings.normalMapEnabled}
            onChange={(e) => update('normalMapEnabled', e.target.checked)}
            disabled={disabled}
          />
          Normal Map (Sobel)
        </label>

        {settings.normalMapEnabled && (
          <SliderField
            label="NM Strength"
            value={settings.normalMapStrength}
            min={0.5} max={8} step={0.5} decimals={1}
            onChange={(v) => update('normalMapStrength', v)}
            disabled={disabled}
          />
        )}

        {!settings.latheMode && (
          <>
            <label className="label-row">
              <input
                type="checkbox"
                title="Displace geometry from texture luminance; adds real depth to model surface."
                checked={settings.reliefEnabled}
                onChange={(e) => update('reliefEnabled', e.target.checked)}
                disabled={disabled}
              />
              Relief (geometry displacement)
            </label>

            {settings.reliefEnabled && (
              <SliderField
                label="Relief Strength"
                value={settings.reliefStrength}
                min={0.005} max={0.2} step={0.005} decimals={3}
                onChange={(v) => update('reliefStrength', v)}
                disabled={disabled}
              />
            )}
          </>
        )}
      </Section>

      {/* ── Rigger ─────────────────────────────────── */}
      <Section title="🦴 Rigger (WIP)">
        <button
          className="rigger-open-btn"
          title="Open rigging tool; adds skeleton and skinning deformation to the model."
          disabled={!hasMesh}
          onClick={onOpenRigger}
        >
          Open Rigger…
        </button>
        {isRigged && (
          <>
            <label style={{ marginTop: '0.6rem' }}>
              Test Animation
              <select
                title="Choose preview animation; changes how the rigged model moves."
                value={selectedAnimation}
                onChange={(e) => onAnimationChange?.(e.target.value as RigTestAnimationId)}
                disabled={disabled}
              >
                {RIG_TEST_ANIMATIONS.map((anim) => (
                  <option key={anim.id} value={anim.id}>{anim.label}</option>
                ))}
              </select>
            </label>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
              <button type="button" title="Play selected animation on the rigged model." onClick={onAnimationPlay} disabled={disabled || isAnimationPlaying}>Play</button>
              <button type="button" title="Stop animation and reset the model pose to frame 0." onClick={onAnimationStop} disabled={disabled || !isAnimationPlaying}>Stop</button>
            </div>
          </>
        )}
        {!isRigged && hasMesh && (
          <p className="section-hint" style={{ marginTop: '0.4rem' }}>
            Build a rig first to preview animations. For cohesive bends in box mode, keep "Weld faces" enabled.
          </p>
        )}
      </Section>
    </div>
  );
}
