/**
 * Writes public/cosmetic-previews.json for cosmetic-preview.html?all=1.
 * Delete that file after rendering: it is build input, not a shipped asset.
 */
const { readFile, writeFile } = require('node:fs/promises')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SHOP = path.join(ROOT, 'resources', 'cosmetics-shop')
const ITEMS = ['bamboo-sticks', 'bird-cape', 'furry-ears', 'furry-tail', 'strohhut', 'wagasa']

async function main() {
  const { parseCosmiq } = require(path.join(ROOT, 'dist-electron', 'cosmetics', 'cosmiq.js'))
  const { buildBoneMesh } = require(path.join(ROOT, 'dist-electron', 'cosmetics', 'geometry.js'))
  const result = {}
  for (const id of ITEMS) {
    const bytes = await readFile(path.join(SHOP, `${id}.cosmiq`))
    const preview = parseCosmiq(bytes, id)
    result[id] = {
      name: preview.name,
      parts: preview.parts.map((part) => {
        const mesh = buildBoneMesh(part.cubes)
        const uvs = new Float32Array(mesh.uvs.length)
        for (let index = 0; index < mesh.uvs.length; index += 2) {
          uvs[index] = mesh.uvs[index] / part.textureWidth
          uvs[index + 1] = mesh.uvs[index + 1] / part.textureHeight
        }
        return {
          texture: part.texture,
          positions: Array.from(mesh.positions),
          normals: Array.from(mesh.normals),
          uvs: Array.from(uvs),
          indices: Array.from(mesh.indices),
        }
      }),
    }
  }
  await writeFile(path.join(ROOT, 'public', 'cosmetic-previews.json'), JSON.stringify(result), 'utf8')
  console.log('prepared', Object.keys(result).join(', '))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
