import { boxUvFaces, type BedrockDocument } from './geometry'

/**
 * A vanilla-shaped cape for texture-only custom capes.
 *
 * A plain cape PNG follows the 64x32 Mojang layout, so the mesh uses the same
 * box net the vanilla cape uses. The actual image may be any resolution; UVs
 * stay in the 64x32 grid and are normalised against it at render time, which
 * maps the same fractions of the image.
 *
 * The cape hangs from the body pivot, just behind the torso. Both the launcher
 * preview and the mod consume this document, so a texture-only cape behaves
 * exactly like a modelled one and can use the same placement editor.
 */
export function createCapeGeometry(id: string): BedrockDocument {
  const uv = boxUvFaces(10, 16, 1, 0, 0)
  // The vanilla box net mirrors the bottom face above v=0; the cape is only
  // one pixel thick, so sample the bottom strip instead of a negative row.
  uv.down = { uv: [11, 0], uv_size: [10, 1] }
  // Vanilla draws the cape after a 180° yaw, so the artwork that faces the
  // world is the box net's *north* panel (u 1..11), not the mirrored south
  // panel. This mesh is not yawed, so the outward south face gets that panel
  // and the inward north face gets the mirror. Sampling the south panel as-is
  // showed every Mojang cape mirrored in the preview.
  const inwardUv = uv.south
  uv.south = uv.north
  uv.north = inwardUv
  return {
    format_version: '1.12.0',
    'minecraft:geometry': [
      {
        description: {
          identifier: `geometry.bamboo.${id}`,
          texture_width: 64,
          texture_height: 32,
        },
        bones: [
          {
            name: 'bipedBody',
            pivot: [0, 24, 0],
            cubes: [
              {
                origin: [-5, 8, 2.1],
                size: [10, 16, 1],
                uv,
              },
            ],
          },
        ],
      },
    ],
  }
}
