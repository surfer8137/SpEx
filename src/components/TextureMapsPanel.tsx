'use client';
import { useRef } from 'react';

type MapKind = 'normal' | 'roughness' | 'metallic';

interface Props {
  normalFile: File | null;
  roughnessFile: File | null;
  metallicFile: File | null;
  onUpload: (kind: MapKind, file: File, imageData: ImageData) => void;
  onClear: (kind: MapKind) => void;
  disabled: boolean;
}

function loadImageData(file: File): Promise<ImageData> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d')!.drawImage(img, 0, 0);
      resolve(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height));
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  });
}

function MapRow({
  label,
  hint,
  file,
  kind,
  disabled,
  onUpload,
  onClear,
}: {
  label: string;
  hint: string;
  file: File | null;
  kind: MapKind;
  disabled: boolean;
  onUpload: (kind: MapKind, file: File, imageData: ImageData) => void;
  onClear: (kind: MapKind) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (f: File) => {
    const data = await loadImageData(f);
    onUpload(kind, f, data);
  };

  return (
    <div className="map-row">
      <div className="map-row-info">
        <span className="map-row-label">{label}</span>
        {file
          ? <span className="map-row-file">{file.name}</span>
          : <span className="map-row-hint">{hint}</span>
        }
      </div>
      <div className="map-row-actions">
        <button
          className="map-btn"
          disabled={disabled}
          title={file ? `Replace ${label}; this changes model shading response.` : `Add ${label}; this modifies how light interacts with the model.`}
          onClick={() => inputRef.current?.click()}
        >
          {file ? '↺' : '+'}
        </button>
        {file && (
          <button className="map-btn map-btn-clear" title={`Remove ${label}; model shading returns to default for this channel.`} disabled={disabled} onClick={() => onClear(kind)}>
            ✕
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        title={`Select ${label}; this affects the material appearance on the model.`}
        style={{ display: 'none' }}
        onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
      />
    </div>
  );
}

export default function TextureMapsPanel({ normalFile, roughnessFile, metallicFile, onUpload, onClear, disabled }: Props) {
  return (
    <div className="settings-panel">
      <h3>PBR Maps <span className="section-hint">(optional)</span></h3>
      <MapRow label="Normal Map"     hint="overrides procedural" file={normalFile}    kind="normal"    disabled={disabled} onUpload={onUpload} onClear={onClear} />
      <MapRow label="Roughness Map"  hint="grayscale"            file={roughnessFile} kind="roughness" disabled={disabled} onUpload={onUpload} onClear={onClear} />
      <MapRow label="Metallic Map"   hint="grayscale"            file={metallicFile}  kind="metallic"  disabled={disabled} onUpload={onUpload} onClear={onClear} />
    </div>
  );
}
