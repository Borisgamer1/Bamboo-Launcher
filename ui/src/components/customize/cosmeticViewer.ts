import * as THREE from 'three'
import type { CosmeticPreview } from '../../electron'
import { buildBoneMesh } from '../../electron/cosmetics/geometry'
import { createPlayerModel, loadTexture, meshGeometry, type PlayerModel } from './playerModel'

/**
 * The player with one `.cosmiq` package.
 *
 * Package geometry is authored in feet space (y = 0 at the ground, +Z behind
 * the player) and the placement is already baked into it, so the mesh mounts
 * on the player root with no extra transform. That is the same space the game
 * renders at rest, which keeps the preview and the wardrobe identical.
 */
const MODEL_SCALE = 1 / 16
const MIN_DISTANCE = 2.6
const MAX_DISTANCE = 6.2

/** Used when the account has no skin and nothing was saved locally. */
export const DEFAULT_SKIN_URL = './images/default-skin.png'

export class CosmeticViewer {
  readonly #host: HTMLElement
  readonly #renderer: THREE.WebGLRenderer
  readonly #scene: THREE.Scene
  readonly #camera: THREE.PerspectiveCamera
  readonly #pivot: THREE.Group
  readonly #resizeObserver: ResizeObserver
  readonly #clock = new THREE.Clock()
  readonly #textures = new Map<string, THREE.Texture>()
  #player: PlayerModel | null = null
  #attachments: Array<{
    mesh: THREE.Mesh
    geometry: THREE.BufferGeometry
    material: THREE.MeshStandardMaterial
  }> = []
  #skinRequest = 0
  #skinTexture: THREE.Texture | null = null
  #capeTexture: THREE.Texture | null = null
  #frame = 0
  #disposed = false
  #view: 'front' | 'back' = 'back'
  #yaw = 0
  #pitch = 0.04
  #distance = 5.2
  #lookY = 0.02
  #dragging = false
  #pointerId: number | null = null
  #lastX = 0
  #lastY = 0
  #reducedMotion = false

  constructor(host: HTMLElement, canvas: HTMLCanvasElement) {
    this.#host = host
    this.#renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.#renderer.setClearAlpha(0)
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace

    this.#scene = new THREE.Scene()
    this.#camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50)

    this.#pivot = new THREE.Group()
    this.#scene.add(this.#pivot)

    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x8a97a8, 2.1)
    const key = new THREE.DirectionalLight(0xffffff, 2.6)
    key.position.set(2.4, 4.2, 3.4)
    const fill = new THREE.DirectionalLight(0xdfe8ff, 0.9)
    fill.position.set(-3, 1.6, -2.4)
    this.#scene.add(hemisphere, key, fill)

    this.#reducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    this.setVariant('classic')
    this.#resizeObserver = new ResizeObserver(() => this.#resize())
    this.#resizeObserver.observe(host)
    this.#resize()

    canvas.addEventListener('pointerdown', this.#onPointerDown)
    canvas.addEventListener('pointermove', this.#onPointerMove)
    canvas.addEventListener('pointerup', this.#onPointerUp)
    canvas.addEventListener('pointercancel', this.#onPointerUp)
    canvas.addEventListener('wheel', this.#onWheel, { passive: false })

    this.#loop()
  }

  setVariant(variant: 'classic' | 'slim'): void {
    if (this.#disposed) return
    this.#clearAttachments()
    if (this.#player) {
      this.#pivot.remove(this.#player.root)
      this.#player.dispose()
      this.#player = null
    }
    const player = createPlayerModel(variant)
    player.root.scale.setScalar(MODEL_SCALE)
    player.root.position.y = -1
    this.#pivot.add(player.root)
    this.#player = player
    if (this.#skinTexture) player.setSkin(this.#skinTexture)
    if (this.#capeTexture) player.setCape(this.#capeTexture)
    this.#fitCamera()
  }

  async setSkin(url: string | null): Promise<void> {
    const request = ++this.#skinRequest
    const apply = (texture: THREE.Texture) => {
      if (this.#disposed || request !== this.#skinRequest) {
        texture.dispose()
        return
      }
      this.#skinTexture?.dispose()
      this.#skinTexture = texture
      this.#player?.setSkin(texture)
    }

    try {
      // No account skin and no local file is normal on a fresh install; the
      // bundled sheet keeps the model dressed instead of plain white.
      apply(await loadTexture(url ?? DEFAULT_SKIN_URL))
    } catch (error) {
      console.warn('[cosmetics] skin texture failed, using the bundled one', error)
      if (url) {
        try {
          apply(await loadTexture(DEFAULT_SKIN_URL))
        } catch (fallbackError) {
          console.warn('[cosmetics] bundled skin failed', fallbackError)
        }
      }
    }
  }

  async setCape(url: string | null): Promise<void> {
    if (!url) {
      this.#player?.setCape(null)
      this.#capeTexture?.dispose()
      this.#capeTexture = null
      return
    }
    const cached = this.#textures.get(`cape:${url}`)
    if (cached) {
      this.#capeTexture = cached
      this.#player?.setCape(cached)
      return
    }
    try {
      const texture = await loadTexture(url)
      if (this.#disposed) {
        texture.dispose()
        return
      }
      this.#textures.set(`cape:${url}`, texture)
      this.#capeTexture = texture
      this.#player?.setCape(texture)
    } catch (error) {
      console.warn('[cosmetics] cape texture failed', error)
    }
  }

  /** Shows one package, or only the player when null. */
  setCosmetic(preview: CosmeticPreview | null): void {
    if (!this.#player) return
    this.#clearAttachments()
    if (!preview) return

    preview.parts.forEach((part, index) => {
      const mesh = buildBoneMesh(part.cubes)
      if (mesh.faceCount === 0) return
      const geometry = meshGeometry(mesh, part.textureWidth, part.textureHeight)
      const material = new THREE.MeshStandardMaterial({
        roughness: 0.9,
        metalness: 0,
        transparent: true,
        alphaTest: 0.5,
        side: THREE.DoubleSide,
      })
      const object = new THREE.Mesh(geometry, material)
      object.name = `${preview.id}:${index}`
      this.#player?.root.add(object)
      this.#attachments.push({ mesh: object, geometry, material })

      // A data URL is stable for one package, so the texture is reused across
      // selections instead of decoded again for every item.
      const key = `cosmetic:${part.texture.length}:${part.texture.slice(-64)}`
      const cached = this.#textures.get(key)
      if (cached) {
        material.map = cached
        material.needsUpdate = true
        return
      }
      void loadTexture(part.texture)
        .then((texture) => {
          if (this.#disposed) {
            texture.dispose()
            return
          }
          this.#textures.set(key, texture)
          material.map = texture
          material.needsUpdate = true
        })
        .catch((error) => console.warn(`[cosmetics] texture failed for ${preview.id}`, error))
    })
    this.#fitCamera()
    this.#updateCamera()
  }

  #clearAttachments(): void {
    for (const attachment of this.#attachments) {
      attachment.mesh.removeFromParent()
      attachment.geometry.dispose()
      attachment.material.dispose()
    }
    this.#attachments = []
  }

  setView(view: 'front' | 'back'): void {
    this.#view = view
    this.#yaw = view === 'front' ? Math.PI : 0
    this.#updateCamera()
  }

  resetCamera(): void {
    this.#yaw = this.#view === 'front' ? Math.PI : 0
    this.#pitch = 0.04
    this.#fitCamera()
    this.#updateCamera()
  }

  /** Fits the camera to the player plus whatever the package adds above it. */
  #fitCamera(): void {
    if (!this.#player) return
    const box = new THREE.Box3().setFromObject(this.#pivot)
    if (box.isEmpty()) return
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const vertical = THREE.MathUtils.degToRad(this.#camera.fov / 2)
    const horizontal = Math.atan(Math.tan(vertical) * this.#camera.aspect)
    this.#lookY = center.y
    this.#distance = THREE.MathUtils.clamp(
      Math.max(size.y / 2 / Math.tan(vertical), size.x / 2 / Math.tan(horizontal)) * 1.26,
      MIN_DISTANCE,
      MAX_DISTANCE,
    )
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    cancelAnimationFrame(this.#frame)
    this.#resizeObserver.disconnect()
    const canvas = this.#renderer.domElement
    canvas.removeEventListener('pointerdown', this.#onPointerDown)
    canvas.removeEventListener('pointermove', this.#onPointerMove)
    canvas.removeEventListener('pointerup', this.#onPointerUp)
    canvas.removeEventListener('pointercancel', this.#onPointerUp)
    canvas.removeEventListener('wheel', this.#onWheel)

    this.#clearAttachments()
    for (const texture of this.#textures.values()) texture.dispose()
    this.#textures.clear()
    this.#skinTexture?.dispose()
    this.#skinTexture = null
    this.#capeTexture = null
    this.#player?.dispose()
    this.#player = null
    this.#renderer.dispose()
  }

  #onPointerDown = (event: PointerEvent): void => {
    this.#dragging = true
    this.#pointerId = event.pointerId
    this.#lastX = event.clientX
    this.#lastY = event.clientY
    ;(event.currentTarget as HTMLCanvasElement).setPointerCapture?.(event.pointerId)
  }

  #onPointerMove = (event: PointerEvent): void => {
    if (!this.#dragging || event.pointerId !== this.#pointerId) return
    const deltaX = event.clientX - this.#lastX
    const deltaY = event.clientY - this.#lastY
    this.#lastX = event.clientX
    this.#lastY = event.clientY
    this.#yaw -= deltaX * 0.008
    this.#pitch = THREE.MathUtils.clamp(this.#pitch + deltaY * 0.005, -0.5, 0.65)
    this.#updateCamera()
  }

  #onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.#pointerId) return
    this.#dragging = false
    this.#pointerId = null
  }

  #onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    this.#distance = THREE.MathUtils.clamp(
      this.#distance + event.deltaY * 0.0022,
      MIN_DISTANCE,
      MAX_DISTANCE,
    )
    this.#updateCamera()
  }

  #resize(): void {
    const width = Math.max(this.#host.clientWidth, 1)
    const height = Math.max(this.#host.clientHeight, 1)
    this.#renderer.setSize(width, height, false)
    this.#camera.aspect = width / height
    this.#camera.updateProjectionMatrix()
    this.#fitCamera()
    this.#updateCamera()
  }

  #updateCamera(): void {
    const horizontal = Math.cos(this.#pitch) * this.#distance
    this.#camera.position.set(
      Math.sin(this.#yaw) * horizontal,
      this.#lookY + Math.sin(this.#pitch) * this.#distance,
      Math.cos(this.#yaw) * horizontal,
    )
    this.#camera.lookAt(0, this.#lookY, 0)
  }

  #loop = (): void => {
    if (this.#disposed) return
    this.#frame = requestAnimationFrame(this.#loop)
    const time = this.#clock.getElapsedTime()
    if (this.#player && !this.#reducedMotion) {
      this.#player.root.position.y = -1 + Math.sin(time * 1.15) * 0.004
    }
    this.#renderer.render(this.#scene, this.#camera)
  }
}
