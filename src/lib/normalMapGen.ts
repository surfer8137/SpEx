import * as THREE from 'three';

function luma(data: Uint8ClampedArray, w: number, h: number, x: number, y: number): number {
  const cx = Math.max(0, Math.min(w - 1, x));
  const cy = Math.max(0, Math.min(h - 1, y));
  const i = (cy * w + cx) * 4;
  return (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
}

export function makeNormalMap(imageData: ImageData, strength: number): THREE.CanvasTexture {
  const { width, height, data } = imageData;
  const out = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Sobel 3×3 — central differences on luminance
      const gx =
        (-luma(data, width, height, x - 1, y - 1)
         - 2 * luma(data, width, height, x - 1, y)
         - luma(data, width, height, x - 1, y + 1)
         + luma(data, width, height, x + 1, y - 1)
         + 2 * luma(data, width, height, x + 1, y)
         + luma(data, width, height, x + 1, y + 1)) * strength;

      const gy =
        (-luma(data, width, height, x - 1, y - 1)
         - 2 * luma(data, width, height, x, y - 1)
         - luma(data, width, height, x + 1, y - 1)
         + luma(data, width, height, x - 1, y + 1)
         + 2 * luma(data, width, height, x, y + 1)
         + luma(data, width, height, x + 1, y + 1)) * strength;

      const len = Math.sqrt(gx * gx + gy * gy + 1) || 1;
      const nx = -gx / len;
      const ny = -gy / len;
      const nz = 1 / len;

      const idx = (y * width + x) * 4;
      out[idx]     = (nx * 0.5 + 0.5) * 255;
      out[idx + 1] = (ny * 0.5 + 0.5) * 255;
      out[idx + 2] = (nz * 0.5 + 0.5) * 255;
      out[idx + 3] = 255;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.putImageData(new ImageData(out, width, height), 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false;
  return tex;
}
