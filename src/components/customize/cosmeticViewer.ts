import * as THREE from 'three'
import { boneMesh } from '../../../electron/cosmetics/geometry'
import type { CosmeticEntry, CosmeticTransform } from './cosmeticCatalog'
import { createPlayerModel, loadTexture, meshGeometry, type PlayerModel } from './playerModel'

/**
 * Renders the player and the equipped cosmetics.
 *
 * Cosmetics are mounted on the same body groups the skin uses, by their bone
 * name, so a hat follows the head and a back item follows the torso without a
 * second transform pipeline. The bundle itself carries the placement, so this
 * class only subtracts the bone pivot.
 */
const MODEL_SCALE = 1 / 16
const BONE_PIVOTS: Record<string, [number, number, number]> = {
  bipedHead: [0, 24, 0],
  bipedBody: [0, 24, 0],
}
const MIN_DISTANCE = 2.6
const MAX_DISTANCE = 6.2

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
  #attachments = new Map<string, { group: THREE.Group; mesh: THREE.Mesh; material: THREE.MeshStandardMaterial }>()
  #skinRequest = 0
  #skinTexture: THREE.Texture | null = null
  #capeTexture: THREE.Texture | null = null
  #frame = 0
  #disposed = false
  #view: 'front' | 'back' = 'back'
  #yaw = 0
  #pitch = 0.04
  #distance = 5.2
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
    this.#camera = new THREE.PerspectiveCamera(30, 1, 0.1, 40)

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
  }

  async setSkin(url: string | null): Promise<void> {
    const request = ++this.#skinRequest
    if (!url) {
      this.#skinTexture?.dispose()
      this.#skinTexture = null
      this.#player?.setSkin(null)
      return
    }
    try {
      const texture = await loadTexture(url)
      if (this.#disposed || request !== this.#skinRequest) {
        texture.dispose()
        return
      }
      this.#skinTexture?.dispose()
      this.#skinTexture = texture
      this.#player?.setSkin(texture)
    } catch (error) {
      console.warn('[cosmetics] skin texture failed', error)
    }
  }

  async setCape(url: string | null): Promise<void> {
    if (!this.#player) return
    if (!url) {
      this.#player.setCape(null)
      this.#capeTexture?.dispose()
      this.#capeTexture = null
      return
    }
    const cached = this.#textures.get(`cape:${url}`)
    if (cached) {
      this.#capeTexture = cached
      this.#player.setCape(cached)
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

  setEquipped(entries: CosmeticEntry[]): void {
    if (!this.#player) return

    const live = new Set(entries.map((entry) => entry.id))
    for (const [id, attachment] of this.#attachments) {
      if (live.has(id)) continue
      attachment.group.parent?.remove(attachment.group)
      attachment.mesh.geometry.dispose()
      attachment.material.dispose()
      this.#attachments.delete(id)
    }

    for (const entry of entries) {
      const existing = this.#attachments.get(entry.id)
      if (existing) {
        this.#applyTransform(existing.group, existing.mesh, entry.bone, entry.transform)
        continue
      }

      const mesh = boneMesh(entry.geometry, entry.bone)
      if (!mesh || mesh.faceCount === 0) {
        console.warn(`[cosmetics] ${entry.id} has no mesh for ${entry.bone}`)
        continue
      }
      const target =
        entry.bone === 'bipedHead'
          ? this.#player.head
          : entry.bone === 'bipedBody'
            ? this.#player.body
            : null
      if (!target) continue

      const geometry = meshGeometry(mesh, entry.atlasWidth, entry.atlasHeight)

      const material = new THREE.MeshStandardMaterial({
        roughness: 0.9,
        metalness: 0,
        transparent: true,
        alphaTest: 0.5,
        side: THREE.DoubleSide,
      })
      const meshObject = new THREE.Mesh(geometry, material)
      meshObject.name = entry.id

      const group = new THREE.Group()
      group.name = `${entry.id}:attachment`
      group.add(meshObject)
      target.add(group)
      this.#applyTransform(group, meshObject, entry.bone, entry.transform)
      this.#attachments.set(entry.id, { group, mesh: meshObject, material })

      const cached = this.#textures.get(entry.atlasUrl)
      if (cached) {
        material.map = cached
        material.needsUpdate = true
      } else {
        void loadTexture(entry.atlasUrl)
          .then((texture) => {
            if (this.#disposed) {
              texture.dispose()
              return
            }
            this.#textures.set(entry.atlasUrl, texture)
            material.map = texture
            material.needsUpdate = true
          })
          .catch((error) => console.warn(`[cosmetics] atlas failed for ${entry.id}`, error))
      }
    }
  }

  /**
   * Applies the bundle transform around the mount bone.
   *
   * The bone group already sits on the pivot, so the mesh is shifted back to the
   * player's feet space, while the wrapper rotates and scales around the pivot.
   * That matches the Java renderer's matrix and keeps both previews identical.
   */
  #applyTransform(
    group: THREE.Group,
    mesh: THREE.Mesh,
    bone: string,
    transform: CosmeticTransform,
  ): void {
    const pivot = BONE_PIVOTS[bone] ?? [0, 0, 0]
    const [rx, ry, rz] = transform.rotation.map(THREE.MathUtils.degToRad)
    group.position.set(transform.position[0], transform.position[1], transform.position[2])
    group.quaternion.setFromEuler(new THREE.Euler(rx, ry, rz, 'ZYX'))
    group.scale.set(transform.scale[0], transform.scale[1], transform.scale[2])
    mesh.position.set(-pivot[0], -pivot[1], -pivot[2])
  }

  setView(view: 'front' | 'back'): void {
    this.#view = view
    this.#yaw = view === 'front' ? Math.PI : 0
    this.#updateCamera()
  }

  resetCamera(): void {
    this.#yaw = this.#view === 'front' ? Math.PI : 0
    this.#pitch = 0.04
    this.#distance = 5.2
    this.#updateCamera()
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

    for (const attachment of this.#attachments.values()) {
      attachment.mesh.geometry.dispose()
      attachment.material.dispose()
    }
    this.#attachments.clear()
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
    this.#updateCamera()
  }

  #updateCamera(): void {
    const horizontal = Math.cos(this.#pitch) * this.#distance
    this.#camera.position.set(
      Math.sin(this.#yaw) * horizontal,
      0.1 + Math.sin(this.#pitch) * this.#distance,
      Math.cos(this.#yaw) * horizontal,
    )
    this.#camera.lookAt(0, 0.02, 0)
  }

  #loop = (): void => {
    if (this.#disposed) return
    this.#frame = requestAnimationFrame(this.#loop)
    const time = this.#clock.getElapsedTime()
    if (this.#player) {
      if (this.#reducedMotion) {
        this.#player.head.rotation.set(0, 0, 0)
        this.#player.root.position.y = -1
      } else {
        this.#player.head.rotation.y = Math.sin(time * 0.55) * 0.07
        this.#player.head.rotation.x = Math.sin(time * 0.83) * 0.018
        this.#player.root.position.y = -1 + Math.sin(time * 1.15) * 0.004
      }
    }
    this.#renderer.render(this.#scene, this.#camera)
  }
}
