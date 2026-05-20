# SpEx — TODO

## Basic Rigging (Mixamo-style)

Place bone markers on the sprite in 2D, auto-generate a skeleton, export with skinning weights.

### UX flow (reference: Mixamo auto-rigger)
1. User places circular markers on the 2D sprite view (front + side panels)
2. Markers define joint positions: chin, wrists, elbows, shoulders, hips/groin, knees, ankles, spine
3. "Use Symmetry" checkbox mirrors left-side joints to right automatically
4. App builds a skeleton (bone hierarchy) from marker positions
5. Auto-skinning: weight vertices by proximity/heat diffusion from each bone
6. Export: GLB with skeleton + skinning weights embedded (Three.js SkinnedMesh)

### Tech notes
- Marker overlay: SVG or Canvas draggable circles on top of the sprite preview
- Bone hierarchy: define parent-child relationships (chin→spine→hips, hips→knee→ankle, etc.)
- Skinning: compute vertex weights — nearest-bone distance or simple heat map
- Three.js: `THREE.Skeleton`, `THREE.SkinnedMesh`, `THREE.Bone`, `BufferGeometry` needs `skinIndex` + `skinWeight` attributes
- GLTFExporter supports skinned meshes natively — export just works if skeleton is wired correctly
- Stretch goal: simple T-pose animation preview (rotate bones to test deformation)

### Marker set (minimum viable)
| Marker | Bones enabled |
|--------|--------------|
| Chin | Head/neck |
| Shoulders (×2) | Upper arm |
| Elbows (×2) | Forearm |
| Wrists (×2) | Hand |
| Groin/hips | Pelvis + spine root |
| Knees (×2) | Upper leg |
| Ankles (×2) | Lower leg |

### Challenges
- Weight painting for non-humanoid sprites
- Side-view marker placement needed for depth (extrusion axis)
- Holes in sprite geometry (donut topology) may complicate skinning

---

## Other ideas

- [ ] Batch export (multiple sprites → zip of GLBs)
- [ ] Sprite sheet splitter (cut frames, export each as mesh)
- [ ] Animated sprite → morph targets (blend between frames)
