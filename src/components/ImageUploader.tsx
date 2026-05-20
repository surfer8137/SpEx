'use client';
import { useRef } from 'react';

interface Props {
  onImage: (file: File, imageData: ImageData) => void;
  currentFile: File | null;
  label?: string;
}

export default function ImageUploader({ onImage, currentFile, label }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (file: File) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      onImage(file, imageData);
    };
    img.src = URL.createObjectURL(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  return (
    <div>
      {label && <p className="uploader-label" title={`Select source image for ${label}; this updates the mapped texture on that model face.`}>{label}</p>}
    <div
      className="uploader"
      title={currentFile ? 'Click or drop to replace this image; the model face texture updates immediately.' : 'Click or drop an image; this texture will be applied to the model.'}
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/*"
        title="Select an image file to change the model texture."
        style={{ display: 'none' }}
        onChange={(e) => {
        if (e.target.files?.[0]) {
          handleFile(e.target.files[0]);
          // Reset so re-selecting the same file fires onChange again
          e.target.value = '';
        }
      }}
      />
      {currentFile ? (
        <p>
          <strong>{currentFile.name}</strong>
          <br />
          <small>Click to change</small>
        </p>
      ) : (
        <p>
          Drop PNG here
          <br />
          <small>or click to browse</small>
        </p>
      )}
    </div>
    </div>
  );
}
