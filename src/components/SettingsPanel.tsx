'use client';
import type { AppSettings, FaceMode } from '../types';

interface Props {
  settings: AppSettings;
  onChange: (s: AppSettings) => void;
  disabled: boolean;
}

export default function SettingsPanel({ settings, onChange, disabled }: Props) {
  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    onChange({ ...settings, [key]: value });

  return (
    <div className="settings-panel">
      <h3>Settings</h3>

      <label className="label-row">
        <input
          type="checkbox"
          checked={settings.latheMode}
          onChange={(e) => update('latheMode', e.target.checked)}
          disabled={disabled}
        />
        Lathe (revolution 360°)
      </label>

      {settings.latheMode && (
        <>
          <label>
            Segments&nbsp;
            <span className="val">{settings.latheSegments}</span>
            <input
              type="range"
              min="6"
              max="64"
              step="2"
              value={settings.latheSegments}
              onChange={(e) => update('latheSegments', parseInt(e.target.value))}
              disabled={disabled}
            />
          </label>
          <label className="label-row">
            <input
              type="checkbox"
              checked={settings.latheClosed}
              onChange={(e) => update('latheClosed', e.target.checked)}
              disabled={disabled}
            />
            Close caps (fill top &amp; bottom)
          </label>
          <label className="label-row">
            <input
              type="checkbox"
              checked={settings.latheStretchTexture}
              onChange={(e) => update('latheStretchTexture', e.target.checked)}
              disabled={disabled}
            />
            Stretch texture (full coverage)
          </label>
          {settings.latheStretchTexture && (
            <label>
              Strip width&nbsp;
              <span className="val">
                {settings.latheColumnWidth === 0 ? 'auto' : `${settings.latheColumnWidth}px`}
              </span>
              <input
                type="range"
                min="0"
                max="128"
                step="1"
                value={settings.latheColumnWidth}
                onChange={(e) => update('latheColumnWidth', parseInt(e.target.value))}
                disabled={disabled}
              />
            </label>
          )}
        </>
      )}

      <div className="settings-divider" />

      <label>
        Face Mode
        <select
          value={settings.faceMode}
          onChange={(e) => update('faceMode', e.target.value as FaceMode)}
          disabled={disabled}
        >
          <option value="front">Front only</option>
          <option value="front-back">Front + Back</option>
          <option value="front-back-lr">Front + Back + Left/Right</option>
          <option value="front-back-lrtb">Front + Back + All sides</option>
        </select>
      </label>

      <div className="settings-divider" />

      <label>
        Background Mode
        <select
          value={settings.backgroundMode}
          onChange={(e) =>
            update('backgroundMode', e.target.value as AppSettings['backgroundMode'])
          }
          disabled={disabled}
        >
          <option value="auto">Auto</option>
          <option value="alpha">Alpha Channel</option>
          <option value="white">White Background</option>
        </select>
      </label>

      <label>
        Extrusion Depth&nbsp;
        <span className="val">{settings.extrusionDepth.toFixed(2)}</span>
        <input
          type="range"
          min="0.01"
          max="2"
          step="0.01"
          value={settings.extrusionDepth}
          onChange={(e) => update('extrusionDepth', parseFloat(e.target.value))}
          disabled={disabled}
        />
      </label>

      <label>
        Simplify Tolerance&nbsp;
        <span className="val">{settings.simplifyTolerance}</span>
        <input
          type="range"
          min="0.5"
          max="15"
          step="0.5"
          value={settings.simplifyTolerance}
          onChange={(e) =>
            update('simplifyTolerance', parseFloat(e.target.value))
          }
          disabled={disabled}
        />
      </label>

      <label>
        Scale&nbsp;
        <span className="val">{settings.scale.toFixed(1)}</span>
        <input
          type="range"
          min="0.5"
          max="5"
          step="0.1"
          value={settings.scale}
          onChange={(e) => update('scale', parseFloat(e.target.value))}
          disabled={disabled}
        />
      </label>

      <label>
        Side Texture
        <select
          value={settings.sideMode}
          onChange={(e) =>
            update('sideMode', e.target.value as AppSettings['sideMode'])
          }
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
            value={settings.sideColor}
            onChange={(e) => update('sideColor', e.target.value)}
            disabled={disabled}
          />
        </label>
      )}

      <div className="settings-divider" />

      <label className="label-row">
        <input
          type="checkbox"
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
              value={settings.outlineColor}
              onChange={(e) => update('outlineColor', e.target.value)}
              disabled={disabled}
            />
          </label>

          <label>
            Outline Opacity&nbsp;
            <span className="val">{settings.outlineOpacity.toFixed(2)}</span>
            <input
              type="range"
              min="0.1"
              max="1"
              step="0.05"
              value={settings.outlineOpacity}
              onChange={(e) => update('outlineOpacity', parseFloat(e.target.value))}
              disabled={disabled}
            />
          </label>
        </>
      )}

      <div className="settings-divider" />

      <label className="label-row">
        <input
          type="checkbox"
          checked={settings.normalMapEnabled}
          onChange={(e) => update('normalMapEnabled', e.target.checked)}
          disabled={disabled}
        />
        Normal Map (Sobel)
      </label>

      {settings.normalMapEnabled && (
        <label>
          Strength&nbsp;
          <span className="val">{settings.normalMapStrength.toFixed(1)}</span>
          <input
            type="range"
            min="0.5"
            max="8"
            step="0.5"
            value={settings.normalMapStrength}
            onChange={(e) => update('normalMapStrength', parseFloat(e.target.value))}
            disabled={disabled}
          />
        </label>
      )}

      <div className="settings-divider" />

      <label className="label-row">
        <input
          type="checkbox"
          checked={settings.reliefEnabled}
          onChange={(e) => update('reliefEnabled', e.target.checked)}
          disabled={disabled}
        />
        Relief (geometry displacement)
      </label>

      {settings.reliefEnabled && (
        <label>
          Relief Strength&nbsp;
          <span className="val">{settings.reliefStrength.toFixed(3)}</span>
          <input
            type="range"
            min="0.005"
            max="0.2"
            step="0.005"
            value={settings.reliefStrength}
            onChange={(e) => update('reliefStrength', parseFloat(e.target.value))}
            disabled={disabled}
          />
        </label>
      )}
    </div>
  );
}
