/**
 * Receives rendered cosmetic PNGs from cosmetic-preview.html?all=1.
 * Run: node scripts/save-preview-images.cjs   (then open the page in a browser)
 */
const http = require('node:http')
const { writeFile } = require('node:fs/promises')
const path = require('node:path')

const PREVIEWS = path.resolve(__dirname, '..', 'resources', 'cosmetics-shop', 'previews')

http
  .createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Headers', 'content-type')
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end()
      return
    }
    const id = new URL(request.url, 'http://localhost').searchParams.get('id') || ''
    if (!/^[a-z0-9-]+$/.test(id)) {
      response.writeHead(400).end('bad id')
      return
    }
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      writeFile(path.join(PREVIEWS, `${id}.png`), Buffer.concat(chunks))
        .then(() => {
          console.log(`saved ${id}.png`)
          response.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
        })
        .catch((error) => {
          console.error(error)
          response.writeHead(500).end('write failed')
        })
    })
  })
  .listen(5198, '127.0.0.1', () => console.log('preview saver on http://127.0.0.1:5198'))
