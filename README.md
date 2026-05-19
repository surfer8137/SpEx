# SpEx: Sprite Extruder

> **Vibecodeada** — born from vibes, caffeine, and a stubborn refusal to touch Blender.

Drop a PNG sprite, get a 3D model. That's it.

SpEx takes any sprite image and extrudes it into a proper low-poly 3D mesh — silhouette traced, holes punched through (trigger guards, donut holes, whatever), texture baked onto the faces, and ready to export as GLB or OBJ.

---

## What it does

- **Silhouette extraction** — OpenCV.js traces the outer contour and any interior holes automatically
- **Extrusion** — earcut triangulates the 2D shape, meshBuilder pushes it into 3D
- **Texture mapping** — the original sprite pixel-perfect on front and back, projected on the sides too
- **Normal maps** — optional Sobel procedural normal map for depth without extra geometry
- **Outline rendering** — optional wireframe-style outline overlay
- **Export** — GLB (self-contained, textures embedded) or OBJ+MTL+PNG (classic triple-file)
- **LOD presets** — Ultra / High / Med / Low poly switches, sliders untouched

## Stack

- [Next.js 14](https://nextjs.org) — framework
- [Three.js](https://threejs.org) — rendering, materials, exporters
- [OpenCV.js](https://docs.opencv.org/4.x/d5/d10/tutorial_js_root.html) — contour extraction via CDN
- [earcut](https://github.com/mapbox/earcut) — 2D polygon triangulation with hole support
- TypeScript throughout

## Run locally

```bash
cd js
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

> OpenCV.js loads from the official CDN on first visit (~8 MB). First processing run waits for init (~2–5 s).

## Usage

1. Upload a PNG (transparent background works best, white background also supported)
2. Adjust **Extrusion Depth**, **Simplify Tolerance**, **Scale** to taste
3. Use **LOD presets** in the stats panel to quickly switch poly density
4. Toggle **Outline** and **Normal Map** for extra flair
5. Hit **Export GLB** (for game engines, Sketchfab, etc.) or **Export OBJ** (for anything else)

## Export formats

| Format | Textures | Notes |
|--------|----------|-------|
| GLB | Embedded | Single file, works everywhere |
| OBJ | Separate PNG + MTL | Classic, imports into most 3D software |

## Settings

| Setting | Effect |
|---------|--------|
| Background Mode | `auto` detects alpha vs white. Force if wrong. |
| Extrusion Depth | Thickness of the 3D solid |
| Simplify Tolerance | Higher = fewer verts = blockier silhouette |
| Scale | World-space size of the model |
| Side Texture | Project image onto sides, or use flat color |
| Normal Map (Sobel) | Procedural normal map from image luminance |
| Outline | Renders a line overlay tracing the silhouette |

---

*SpEx — because sprites deserve a third dimension.*
