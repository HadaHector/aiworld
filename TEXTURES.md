# Textures

The plan for compressing the game's textures on the GPU. **Not built yet - it waits for approval; the
open questions are at the end.**

## 1. Why

Nothing is compressed today. Every texture is baked in the browser (the project has no image assets)
and uploaded as raw RGBA: 4 bytes a pixel, a third more for its mipmaps. A 1024 px material is
about 5.6 MB per texture, two textures a material. The building array alone (26 layers, colour and
normal) is about 280 MB of GPU memory; the ground's array, the bark and boulder textures, the leaf
atlases and the characters' atlases come on top. GPU block compression stores the same texture in a
quarter (or an eighth) of that, and the GPU reads it as it is - no unpacking - so it is faster to
sample too (less memory traffic, more of it in cache).

## 2. What exists

Where textures are made (`src/`), and how they are laid out:

| what | where | size | channels | count |
|---|---|---|---|---|
| building materials (array) | `buildings/buildingMesh.ts` | 1024 | colour+mask, normal xy+roughness+height (`surface`, see PROP_RENDERING.md step 6) | one layer each, 26 |
| props-only materials | `buildings/buildingMesh.ts` | 64-1024 (`textureSize`) | as above, plain 2D textures | 11 |
| ground materials (array) | `materials/materialLibrary.ts` | 1024 | colour+roughness, normal xyz+height (`ground` - the terrain blend reads height) | one layer each |
| bark, boulders | `foliage/treeModels.ts` | 1024 | as the ground | per kind |
| leaf atlases | `foliage/treeModels.ts` | 1024 | colour + coverage (cut-out) | per kind |
| grass blades (array) | `foliage/grassField.ts` | 256 | shading, petal mask, -, cut-out | per kind |
| characters, gear, beasts | `character/` | up to 1024 | colour (+ alpha) | per figure / tile |
| particles atlas | `particles/render.ts` | small | colour + alpha | 1 |
| house lightmaps | `buildings/buildingMesh.ts` | per house | half-float RGBA | per lit house |
| tint tables, 1-px stand-ins | various | tiny | - | - |

All bakes go through the same baker and workers (`materials/textureBakePool.ts`) and are kept between
visits in IndexedDB (`materials/textureCache.ts`), keyed by seed, id, texture and a hash of the bake code.

## 3. The plan

### Formats

Desktop browsers (Chrome, Edge, Firefox on Windows, through ANGLE/Direct3D 11) expose the BC formats:
`WEBGL_compressed_texture_s3tc` (BC1-3), `EXT_texture_compression_rgtc` (BC4-5) and
`EXT_texture_compression_bptc` (BC7). WebGL2 allows them in texture arrays (`compressedTexImage3D`).

| texture | format | bytes a pixel | against RGBA8 |
|---|---|---|---|
| a material's colour (+ mask or roughness) | BC7 | 1 | 1/4 |
| a material's normal texture (surface: xy, roughness, height; ground: xyz, height) | BC7 | 1 | 1/4 |
| leaf atlases, grass blades, character atlases, particles | BC7 | 1 | 1/4 |
| a texture with no alpha that tolerates it | BC1 | 0.5 | 1/8 |
| lightmaps | stay as they are (half-float, small, made per house) | - | - |

BC7 everywhere first: one encoder, one path, four channels, the quality the noisy procedural textures
need (BC1/BC3 band and block visibly on fine noise). The surface layout was chosen for this: both its
textures have four meaningful channels, so each is one BC7 texture with no change of layout. BC5
(two channels, the best normals) would need roughness and height elsewhere - not worth a second layout.

### Encoding

- In the bake workers, right after a bake: the RGBA pixels, each mip level made on the CPU (a
  compressed texture cannot make its own mipmaps on the GPU - the shrink already written for props-only
  textures, `shrinkTexels`, does it, normals renormalised), each level encoded to BC7.
- A BC7 encoder in WebAssembly (an existing open-source one - bc7enc's fast modes or similar - built
  once, checked in with its licence), at a fast setting: a cold load should not get much slower.
- Kept in the texture cache instead of the raw pixels: a later load reads the compressed levels and
  uploads them as they are - less to read, less to upload, so warm loads get faster.
- The layout in the cache key, and the format: an old raw entry is never read as a compressed one.

### Upload

- Babylon takes compressed data for raw textures; arrays and per-level uploads may need the engine's
  lower-level upload (`compressedTexSubImage3D` per layer and level) - to check first (step 1 below).
- `generateMipMaps` off for compressed textures: the levels come from the encoder.

### Fallback

- No BC support (a phone, some Macs' Safari): textures stay raw RGBA, as now. Phones would want ETC2 or
  ASTC - a second encoder, or a universal format (Basis Universal / KTX2, which Babylon can already
  transcode) - not part of this plan unless phones become a target.
- A setting to force raw textures, for comparing.

## 4. Phases

1. **Spike**: one building material through a WASM BC7 encoder, uploaded into a small array, drawn in
   the workbench beside the raw one. Measure encode time per 1024 px texture with its mips, GPU memory
   (`__aiworld.memory()`), and look at the quality up close and far off.
2. **Building and prop materials**: compressed in the bake workers, cached, uploaded; the props-only
   textures too. Shots before and after; memory before and after.
3. **Ground materials** (the terrain's array): the same.
4. **Bark, boulders, leaf atlases, grass**: the same, the leaves' cut-out checked (the mask's mip
   levels made by the shrink, not the GPU).
5. **Characters and gear**: the same, checking the atlases' edges (no bleeding across cells).

## 5. Open questions

1. Phones: a target or not? (Decides whether ETC2/ASTC or a universal format is needed.)
2. Quality bar: is BC7 at a fast setting acceptable on the noisiest materials, judged in the spike?
3. Cold-load budget: how much slower may a first load be (once, before the cache holds the bakes)?
4. Lightmaps: leave raw (the plan) or compress too (BC6H, half-float) later?
