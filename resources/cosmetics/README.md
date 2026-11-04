# Cosmetics bundle

`resources/cosmetics` is the only source of truth for the launcher preview and
the Fabric mod. The launcher copies this folder into
`<instance>/cosmetics/files` and writes `manifest.json` before every launch.

## One folder per cosmetic

```
resources/cosmetics/<id>/
  cosmetic.json      metadata + placement
  <id>.png           atlas (one row, source textures side by side)
  <id>.geo.json      Bedrock geometry (modelled cosmetics only)
```

`cosmetic.json`:

```json
{
  "id": "bird-cape",
  "name": "Bird Cape",
  "slot": "cape",
  "bone": "bipedBody",
  "attachment": {
    "bone": "bipedBody",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1]
  },
  "geometry": "bird-cape.geo.json",
  "texture": "bird-cape.png",
  "cubes": 1
}
```

- `slot` is `hat`, `back` or `cape`.
- `bone` is the player part the mesh is mounted on; `bipedBody` covers back
  items and capes, `bipedHead` covers hats.
- `attachment` is the placement read by the preview and the mod. Position is in
  Blockbench pixels in feet space: `+X` right, `+Y` up, `+Z` back. Rotation is
  degrees around the mount bone, scale is a multiplier. The dev editor in
  **Anpassen → Cosmetics** writes these values; re-importing a model preserves
  them.
- `geometry` may be omitted for a texture-only cape. The launcher then
  generates the vanilla 10×16 cape shape at runtime from `electron/cosmetics/cape.ts`,
  so arbitrary cape artwork can still use the placement editor.

## Modelled cosmetics

Blockbench sources live in `../../BambooContent/Cosmetics`. Add an entry to
`sources.json` and run:

```sh
node scripts/import-cosmetics.cjs
```

The importer packs every referenced texture into one row, converts the Java
block model to Bedrock geometry with atlas-pixel UVs, and writes the three
files above. It never overwrites `attachment`, so calibrated placement
survives a re-import.

## Texture-only custom capes

Drop the PNG and a `cosmetic.json` without `geometry` into a new folder under
`resources/cosmetics`. The PNG follows the normal 64×32 cape layout (the
outward-facing artwork at `1,1`, its mirror at `12,1`) but may be any
resolution; the generated cape geometry uses the same fractions. `vogel-cape`
is an example.

Cape artwork needs a transparent background. The mod draws the cape with alpha
cutout, so an opaque background (a flattened black export, for example) becomes
a visible rectangle around the artwork.

## Runtime manifest

`manifest.json` is launcher-owned and must not be edited by hand:

```json
{
  "version": 1,
  "cosmetics": [
    {
      "slug": "bird-cape",
      "category": "cape",
      "displayName": "Bird Cape",
      "texture": "files/bird-cape.png",
      "geometry": "files/bird-cape.geo.json",
      "attachment": { "bone": "bipedBody", "position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1] }
    }
  ],
  "customCapes": [],
  "activeSelections": [{ "slug": "bird-cape", "category": "cape" }]
}
```

`activeSelections` is the equipped set from `Anpassen`. A `cape` object is only
present when a Mojang cape was selected; the mod then swaps the vanilla cape
texture. A modelled cape is rendered by the cosmetic layer and the mod hides
the vanilla cape layer while it is equipped.
