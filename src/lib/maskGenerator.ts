import type { BackgroundMode } from '../types';

export interface MaskResult {
  mask: Uint8ClampedArray;
  width: number;
  height: number;
}

export function generateMask(
  imageData: ImageData,
  mode: BackgroundMode,
  alphaThreshold = 128,
  whiteThreshold = 240,
): MaskResult {
  const { data, width, height } = imageData;
  const mask = new Uint8ClampedArray(width * height);

  const useAlpha =
    mode === 'alpha' || (mode === 'auto' && detectAlpha(data));

  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const a = data[i * 4 + 3];

    if (useAlpha) {
      mask[i] = a >= alphaThreshold ? 255 : 0;
    } else {
      mask[i] =
        r > whiteThreshold && g > whiteThreshold && b > whiteThreshold
          ? 0
          : 255;
    }
  }

  return { mask, width, height };
}

function detectAlpha(data: Uint8ClampedArray): boolean {
  // Sample up to 4000 bytes (1000 pixels) to detect transparency
  const limit = Math.min(data.length, 4000);
  for (let i = 3; i < limit; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
}
