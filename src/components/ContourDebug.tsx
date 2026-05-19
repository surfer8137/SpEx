'use client';
import { useEffect, useRef } from 'react';
import type { ContourResult, Contour2D } from '../lib/contourExtractor';

interface Props {
  imageData: ImageData;
  contour: ContourResult;
}

function drawContour(
  ctx: CanvasRenderingContext2D,
  pts: Contour2D,
  stroke: string,
  fill: string,
  lw: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lw;
  ctx.stroke();
  ctx.fillStyle = fill;
  for (const [x, y] of pts) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

export default function ContourDebug({ imageData, contour }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const { width, height } = imageData;
    canvas.width = width;
    canvas.height = height;
    ctx.putImageData(imageData, 0, 0);

    const lw = Math.max(1, Math.round(Math.max(width, height) / 200));
    const r = Math.max(2, Math.round(Math.max(width, height) / 150));

    drawContour(ctx, contour.outer, '#ff3c3c', '#ff3c3c', lw, r);
    for (const hole of contour.holes) {
      drawContour(ctx, hole, '#3c9fff', '#3c9fff', lw, r);
    }
  }, [imageData, contour]);

  const total = contour.outer.length + contour.holes.reduce((s, h) => s + h.length, 0);

  return (
    <div className="contour-debug">
      <canvas ref={canvasRef} />
      <span className="contour-debug-label">
        outer {contour.outer.length} · holes {contour.holes.length} · {total} pts
      </span>
    </div>
  );
}
