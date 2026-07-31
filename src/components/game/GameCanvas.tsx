'use client'

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useGameStore } from '@/lib/game/store'
import { subscribeShots, emitMove, emitShoot } from '@/lib/game/socket'
import { getObstaclesCache } from '@/lib/game/obstacles-cache'
import type { Obstacle, PlayerSnapshot, ShotPayload } from '@/lib/game/types'

interface Props {
  onReady?: () => void
}

interface LocalPlayerView {
  group: THREE.Group
  body: THREE.Mesh
  head: THREE.Mesh
  nameSprite: THREE.Sprite
  hpBar: THREE.Mesh
  hpBarBg: THREE.Mesh
  muzzle: THREE.Object3D
  color: string
  name: string
  // interpolation
  targetPos: THREE.Vector3
  currentPos: THREE.Vector3
  targetRot: number
  currentRot: number
}

const PLAYER_HEIGHT = 1.8
const PLAYER_RADIUS = 0.6
const CAMERA_HEIGHT = 14
const CAMERA_DISTANCE = 10
const MOUSE_SENS = 0.0025
const BULLET_LIFETIME_MS = 90

export default function GameCanvas({ onReady }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const selfId = useGameStore((s) => s.selfId)
  const constants = useGameStore((s) => s.constants)
  const mapSize = useGameStore((s) => s.mapSize)
  // Refs that the imperative Three.js code reads/writes inside the effect.
  const selfIdRef = useRef<string | null>(selfId)
  const latestPlayersRef = useRef<Record<string, PlayerSnapshot>>({})
  selfIdRef.current = selfId
  latestPlayersRef.current = useGameStore.getState().players

  useEffect(() => {
    if (!selfId || !constants) return
    const mount = mountRef.current
    if (!mount) return

    // ---------- Renderer / scene / camera ----------
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.setClearColor(0x0b1020)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0b1020)
    scene.fog = new THREE.Fog(0x0b1020, 40, 110)

    const camera = new THREE.PerspectiveCamera(55, mount.clientWidth / mount.clientHeight, 0.1, 500)
    camera.position.set(0, CAMERA_HEIGHT, CAMERA_DISTANCE)
    camera.lookAt(0, 0, 0)

    // ---------- Lights ----------
    const hemi = new THREE.HemisphereLight(0x88aaff, 0x223344, 0.8)
    scene.add(hemi)
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.2)
    sun.position.set(30, 50, 20)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.left = -50
    sun.shadow.camera.right = 50
    sun.shadow.camera.top = 50
    sun.shadow.camera.bottom = -50
    sun.shadow.camera.near = 1
    sun.shadow.camera.far = 200
    sun.shadow.bias = -0.0005
    scene.add(sun)

    // ---------- Ground ----------
    const halfMap = mapSize / 2
    const groundGeo = new THREE.PlaneGeometry(mapSize, mapSize, 1, 1)
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x1b2a1b, roughness: 1, metalness: 0 })
    const ground = new THREE.Mesh(groundGeo, groundMat)
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    scene.add(ground)

    // Grid overlay for visual movement feedback
    const grid = new THREE.GridHelper(mapSize, mapSize / 4, 0x335544, 0x223322)
    grid.position.y = 0.01
    scene.add(grid)

    // Out-of-bounds dark plane
    const outerGeo = new THREE.PlaneGeometry(mapSize * 4, mapSize * 4)
    const outerMat = new THREE.MeshBasicMaterial({ color: 0x05080f })
    const outer = new THREE.Mesh(outerGeo, outerMat)
    outer.rotation.x = -Math.PI / 2
    outer.position.y = -0.02
    scene.add(outer)

    // ---------- Obstacles ----------
    // Track obstacle meshes by id so we can rebuild only when map changes.
    const obstacleGroup = new THREE.Group()
    scene.add(obstacleGroup)
    const buildObstacles = (obstacles: Obstacle[]) => {
      obstacleGroup.clear()
      for (const o of obstacles) {
        const geo = new THREE.BoxGeometry(o.size.x, o.size.y, o.size.z)
        const mat = new THREE.MeshStandardMaterial({
          color: o.id.startsWith('w_') ? 0x444a55 : (o.id.startsWith('c') ? 0x6b5544 : 0x55606b),
          roughness: 0.9,
          metalness: 0.05,
        })
        const m = new THREE.Mesh(geo, mat)
        m.position.set(o.pos.x, o.pos.y, o.pos.z)
        m.castShadow = true
        m.receiveShadow = true
        obstacleGroup.add(m)

        // Wireframe outline for better readability
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(geo),
          new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4 }),
        )
        edges.position.copy(m.position)
        obstacleGroup.add(edges)
      }
    }

    // Pull obstacles from current players snapshot (already in store via welcome).
    // Easiest: read once on init via a fetch of the latest welcome. But welcome was already
    // dispatched into the store; we don't store obstacles there. So we request them from
    // server by re-emitting 'join' would create a duplicate session.
    // Instead, accept obstacles via prop (we read from store at mount time below).
    // We store obstacles in a ref set by an effect that listens for the welcome event.

    // ---------- Player avatars ----------
    const playersGroup = new THREE.Group()
    scene.add(playersGroup)
    const views = new Map<string, LocalPlayerView>()

    const makeTextSprite = (text: string, color: string) => {
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')!
      const fontSize = 36
      ctx.font = `bold ${fontSize}px Inter, Arial, sans-serif`
      const metrics = ctx.measureText(text)
      const w = Math.ceil(metrics.width) + 16
      const h = fontSize + 12
      canvas.width = w
      canvas.height = h
      ctx.fillStyle = 'rgba(0,0,0,0.55)'
      ctx.fillRect(0, 0, w, h)
      ctx.font = `bold ${fontSize}px Inter, Arial, sans-serif`
      ctx.fillStyle = color
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'center'
      ctx.fillText(text, w / 2, h / 2)
      const tex = new THREE.CanvasTexture(canvas)
      tex.minFilter = THREE.LinearFilter
      const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true })
      const sprite = new THREE.Sprite(mat)
      sprite.scale.set((w / h) * 1.4, 1.4, 1)
      sprite.position.y = PLAYER_HEIGHT + 0.6
      return sprite
    }

    const makePlayerView = (p: PlayerSnapshot): LocalPlayerView => {
      const group = new THREE.Group()
      const color = new THREE.Color(p.color)

      // Body: capsule
      const bodyGeo = new THREE.CapsuleGeometry(PLAYER_RADIUS, PLAYER_HEIGHT - PLAYER_RADIUS * 2, 6, 12)
      const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.2 })
      const body = new THREE.Mesh(bodyGeo, bodyMat)
      body.position.y = PLAYER_HEIGHT / 2
      body.castShadow = true
      group.add(body)

      // Head: small sphere
      const headGeo = new THREE.SphereGeometry(0.32, 16, 12)
      const headMat = new THREE.MeshStandardMaterial({ color: color.clone().lerp(new THREE.Color(0xffffff), 0.3), roughness: 0.4 })
      const head = new THREE.Mesh(headGeo, headMat)
      head.position.y = PLAYER_HEIGHT + 0.05
      head.castShadow = true
      group.add(head)

      // Gun: small box pointing +Z (forward in local space)
      const gunGeo = new THREE.BoxGeometry(0.15, 0.15, 1.0)
      const gunMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.5, metalness: 0.6 })
      const gun = new THREE.Mesh(gunGeo, gunMat)
      gun.position.set(0.35, PLAYER_HEIGHT * 0.55, 0.55)
      group.add(gun)

      // Muzzle marker (where bullets originate)
      const muzzle = new THREE.Object3D()
      muzzle.position.set(0.35, PLAYER_HEIGHT * 0.55, 1.1)
      group.add(muzzle)

      // HP bar
      const hpBarBgGeo = new THREE.PlaneGeometry(1.4, 0.16)
      const hpBarBgMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6, depthTest: false })
      const hpBarBg = new THREE.Mesh(hpBarBgGeo, hpBarBgMat)
      hpBarBg.position.y = PLAYER_HEIGHT + 0.95
      hpBarBg.renderOrder = 998
      group.add(hpBarBg)

      const hpBarGeo = new THREE.PlaneGeometry(1.32, 0.1)
      const hpBarMat = new THREE.MeshBasicMaterial({ color: 0x33dd55, depthTest: false })
      const hpBar = new THREE.Mesh(hpBarGeo, hpBarMat)
      hpBar.position.y = PLAYER_HEIGHT + 0.95
      hpBar.position.z = 0.001
      hpBar.renderOrder = 999
      group.add(hpBar)

      // Name sprite
      const nameSprite = makeTextSprite(p.name, p.color)
      group.add(nameSprite)

      // Make HP bar & name always face the camera
      // (we'll update their quaternion in the loop)

      group.position.set(p.pos.x, p.pos.y, p.pos.z)
      group.rotation.y = p.rot
      playersGroup.add(group)

      return {
        group, body, head, nameSprite, hpBar, hpBarBg, muzzle,
        color: p.color,
        name: p.name,
        targetPos: new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z),
        currentPos: new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z),
        targetRot: p.rot,
        currentRot: p.rot,
      }
    }

    const removePlayerView = (id: string) => {
      const v = views.get(id)
      if (!v) return
      playersGroup.remove(v.group)
      v.body.geometry.dispose()
      ;(v.body.material as THREE.Material).dispose()
      v.head.geometry.dispose()
      ;(v.head.material as THREE.Material).dispose()
      v.hpBar.geometry.dispose()
      ;(v.hpBar.material as THREE.Material).dispose()
      v.hpBarBg.geometry.dispose()
      ;(v.hpBarBg.material as THREE.Material).dispose()
      ;(v.nameSprite.material as THREE.SpriteMaterial).map?.dispose()
      ;(v.nameSprite.material as THREE.SpriteMaterial).dispose()
      views.delete(id)
    }

    // ---------- Local input state ----------
    const keys: Record<string, boolean> = {}
    const mouse = { x: 0, y: 0, down: false, world: new THREE.Vector3() }
    let pointerLocked = false

    const onKeyDown = (e: KeyboardEvent) => {
      keys[e.code] = true
      if (e.code === 'Space') e.preventDefault()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      keys[e.code] = false
    }
    const onMouseMove = (e: MouseEvent) => {
      if (!pointerLocked) return
      // We rotate the local player by mouse X delta (FPS-style strafe aim).
      // For top-down we keep it simple: player yaw = camera yaw + offset.
      // Instead here we directly rotate player by mouse X delta.
      const self = selfIdRef.current
      if (!self) return
      const v = views.get(self)
      if (!v) return
      v.targetRot -= e.movementX * MOUSE_SENS
    }
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 0) {
        mouse.down = true
        tryShoot()
      }
    }
    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 0) mouse.down = false
    }
    const onPointerLockChange = () => {
      pointerLocked = document.pointerLockElement === renderer.domElement
    }
    const onCanvasClick = () => {
      if (!pointerLocked) {
        renderer.domElement.requestPointerLock?.()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('mousemove', onMouseMove)
    renderer.domElement.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mouseup', onMouseUp)
    document.addEventListener('pointerlockchange', onPointerLockChange)
    renderer.domElement.addEventListener('click', onCanvasClick)

    // ---------- Shooting ----------
    let lastShotTs = 0
    const SHOOT_COOLDOWN = 180 // matches server

    const tryShoot = () => {
      const self = selfIdRef.current
      if (!self) return
      const v = views.get(self)
      if (!v) return
      // alive check
      const me = latestPlayersRef.current[self]
      if (!me || !me.alive) return
      const now = performance.now()
      if (now - lastShotTs < SHOOT_COOLDOWN) return
      lastShotTs = now

      // Compute muzzle world position
      const muzzleWorld = new THREE.Vector3()
      v.muzzle.getWorldPosition(muzzleWorld)
      // Direction: forward of player group in world space
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(v.group.quaternion).normalize()
      // Slight downward bias so aim feels natural with camera angle
      const dir = forward.clone()
      emitShoot({ x: dir.x, y: dir.y, z: dir.z }, { x: muzzleWorld.x, y: muzzleWorld.y, z: muzzleWorld.z })

      // Local muzzle flash visual
      spawnMuzzleFlash(muzzleWorld)
    }

    // ---------- Bullet tracers ----------
    interface Tracer {
      line: THREE.Line
      born: number
    }
    const tracers: Tracer[] = []
    const tracerGroup = new THREE.Group()
    scene.add(tracerGroup)

    const spawnTracer = (origin: THREE.Vector3, end: THREE.Vector3, hitPlayer: boolean) => {
      const geo = new THREE.BufferGeometry().setFromPoints([origin.clone(), end.clone()])
      const mat = new THREE.LineBasicMaterial({
        color: hitPlayer ? 0xff5533 : 0xffee88,
        transparent: true,
        opacity: 0.95,
      })
      const line = new THREE.Line(geo, mat)
      tracerGroup.add(line)
      tracers.push({ line, born: performance.now() })
    }

    const muzzleFlashGroup = new THREE.Group()
    scene.add(muzzleFlashGroup)
    interface Flash { mesh: THREE.Mesh; born: number }
    const flashes: Flash[] = []
    const spawnMuzzleFlash = (at: THREE.Vector3) => {
      const geo = new THREE.SphereGeometry(0.25, 8, 8)
      const mat = new THREE.MeshBasicMaterial({ color: 0xffcc55, transparent: true, opacity: 0.9 })
      const m = new THREE.Mesh(geo, mat)
      m.position.copy(at)
      muzzleFlashGroup.add(m)
      flashes.push({ mesh: m, born: performance.now() })
    }

    const unsubShots = subscribeShots((s: ShotPayload) => {
      spawnTracer(
        new THREE.Vector3(s.origin.x, s.origin.y, s.origin.z),
        new THREE.Vector3(s.end.x, s.end.y, s.end.z),
        !!s.hitPlayerId,
      )
    })

    // ---------- Crosshair ray (debug, optional) ----------
    // Not used.

    // ---------- Store subscription ----------
    const unsubStore = useGameStore.subscribe((state) => {
      latestPlayersRef.current = state.players
      // Sync obstacles if map data is present (not stored — built once from welcome)
      // Reconcile avatar list
      const seen = new Set<string>()
      for (const id of Object.keys(state.players)) {
        seen.add(id)
        const snap = state.players[id]
        let v = views.get(id)
        if (!v) {
          v = makePlayerView(snap)
          views.set(id, v)
        }
        v.targetPos.set(snap.pos.x, snap.pos.y, snap.pos.z)
        v.targetRot = snap.rot
        // Update HP bar width & color
        const ratio = Math.max(0, snap.hp) / 100
        v.hpBar.scale.x = ratio
        // Re-center bar (left-aligned: shift by half-width difference)
        v.hpBar.position.x = -(1 - ratio) * 0.66
        const hpColor =
          ratio > 0.6 ? 0x33dd55 :
          ratio > 0.3 ? 0xffaa22 :
          0xff3322
        ;(v.hpBar.material as THREE.MeshBasicMaterial).color.setHex(hpColor)
        // Hide HP bar for full-HP self (less clutter) -- keep visible for everyone for clarity
        v.group.visible = true
        if (!snap.alive) {
          // Render as ghost / faded
          ;(v.body.material as THREE.MeshStandardMaterial).transparent = true
          ;(v.body.material as THREE.MeshStandardMaterial).opacity = 0.25
          ;(v.head.material as THREE.MeshStandardMaterial).transparent = true
          ;(v.head.material as THREE.MeshStandardMaterial).opacity = 0.25
          v.hpBar.visible = false
          v.hpBarBg.visible = false
          v.nameSprite.visible = false
        } else {
          ;(v.body.material as THREE.MeshStandardMaterial).transparent = false
          ;(v.body.material as THREE.MeshStandardMaterial).opacity = 1
          ;(v.head.material as THREE.MeshStandardMaterial).transparent = false
          ;(v.head.material as THREE.MeshStandardMaterial).opacity = 1
          v.hpBar.visible = id !== selfIdRef.current // hide own HP bar in world
          v.hpBarBg.visible = id !== selfIdRef.current
          v.nameSprite.visible = id !== selfIdRef.current
        }
        if (v.name !== snap.name) {
          // Name changed — refresh sprite
          v.group.remove(v.nameSprite)
          ;(v.nameSprite.material as THREE.SpriteMaterial).map?.dispose()
          ;(v.nameSprite.material as THREE.SpriteMaterial).dispose()
          const newSprite = makeTextSprite(snap.name, snap.color)
          v.group.add(newSprite)
          v.nameSprite = newSprite
          v.name = snap.name
        }
        if (v.color !== snap.color) {
          ;(v.body.material as THREE.MeshStandardMaterial).color.set(snap.color)
          v.color = snap.color
        }
      }
      // Remove avatars no longer in snapshot
      for (const id of Array.from(views.keys())) {
        if (!seen.has(id)) removePlayerView(id)
      }
    })

    // Pull obstacles from the welcome payload via a one-time read of the store.
    // We didn't store obstacles in zustand to keep memory low; fetch them by
    // re-emitting a 'map' request? Simpler: store them once on init via a side channel.
    // Here we rely on the parent to have rendered <GameScene obstacles={...}> -- but to
    // keep API simple, we fetch obstacles from a module-level cache set by the welcome handler.
    const obstacles = getObstaclesCache()
    if (obstacles) buildObstacles(obstacles)

    // ---------- Movement ----------
    const SPEED = constants.PLAYER_SPEED
    let lastEmit = 0
    const EMIT_INTERVAL = 50 // ms (20Hz client->server)

    const movePlayer = (dt: number) => {
      const self = selfIdRef.current
      if (!self) return
      const v = views.get(self)
      if (!v) return
      const me = latestPlayersRef.current[self]
      if (!me || !me.alive) return

      // Movement is relative to player yaw (W = forward, S = back, A = left, D = right)
      const forward = new THREE.Vector3(Math.sin(v.targetRot), 0, Math.cos(v.targetRot))
      const right = new THREE.Vector3(Math.cos(v.targetRot), 0, -Math.sin(v.targetRot))
      const dir = new THREE.Vector3()
      if (keys['KeyW'] || keys['ArrowUp']) dir.add(forward)
      if (keys['KeyS'] || keys['ArrowDown']) dir.sub(forward)
      if (keys['KeyD'] || keys['ArrowRight']) dir.add(right)
      if (keys['KeyA'] || keys['ArrowLeft']) dir.sub(right)
      if (dir.lengthSq() > 0) {
        dir.normalize().multiplyScalar(SPEED * dt)
        v.targetPos.add(dir)
        // Clamp inside map
        const half = mapSize / 2 - PLAYER_RADIUS
        v.targetPos.x = Math.max(-half, Math.min(half, v.targetPos.x))
        v.targetPos.z = Math.max(-half, Math.min(half, v.targetPos.z))
      }

      // Auto-fire while holding mouse button
      if (mouse.down) tryShoot()

      // Send to server at 20Hz
      const now = performance.now()
      if (now - lastEmit > EMIT_INTERVAL) {
        lastEmit = now
        emitMove(
          { x: v.targetPos.x, y: 0, z: v.targetPos.z },
          v.targetRot,
        )
      }
    }

    // ---------- Animation loop ----------
    let raf = 0
    let prev = performance.now()
    const animate = () => {
      raf = requestAnimationFrame(animate)
      const now = performance.now()
      const dt = Math.min(0.05, (now - prev) / 1000)
      prev = now

      movePlayer(dt)

      // Interpolate avatars
      const lerpFactor = 1 - Math.pow(0.001, dt) // smoothing
      for (const v of views.values()) {
        v.currentPos.lerp(v.targetPos, lerpFactor)
        v.group.position.copy(v.currentPos)
        // Shortest-path rotation lerp
        let dr = v.targetRot - v.currentRot
        while (dr > Math.PI) dr -= Math.PI * 2
        while (dr < -Math.PI) dr += Math.PI * 2
        v.currentRot += dr * lerpFactor
        v.group.rotation.y = v.currentRot
        // Billboard HP bar / name
        v.hpBar.quaternion.copy(camera.quaternion)
        v.hpBarBg.quaternion.copy(camera.quaternion)
        v.nameSprite.quaternion.copy(camera.quaternion)
      }

      // Camera follows local player
      const self = selfIdRef.current
      if (self) {
        const v = views.get(self)
        if (v) {
          const target = v.currentPos
          const camOffset = new THREE.Vector3(0, CAMERA_HEIGHT, CAMERA_DISTANCE)
          camera.position.lerp(
            new THREE.Vector3(target.x + camOffset.x, target.y + camOffset.y, target.z + camOffset.z),
            lerpFactor,
          )
          camera.lookAt(target.x, target.y + 1, target.z)
        }
      }

      // Update tracers (fade & expire)
      for (let i = tracers.length - 1; i >= 0; i--) {
        const t = tracers[i]
        const age = now - t.born
        if (age > BULLET_LIFETIME_MS) {
          tracerGroup.remove(t.line)
          t.line.geometry.dispose()
          ;(t.line.material as THREE.Material).dispose()
          tracers.splice(i, 1)
        } else {
          const a = 1 - age / BULLET_LIFETIME_MS
          ;(t.line.material as THREE.LineBasicMaterial).opacity = a * 0.95
        }
      }
      for (let i = flashes.length - 1; i >= 0; i--) {
        const f = flashes[i]
        const age = now - f.born
        if (age > 60) {
          muzzleFlashGroup.remove(f.mesh)
          f.mesh.geometry.dispose()
          ;(f.mesh.material as THREE.Material).dispose()
          flashes.splice(i, 1)
        } else {
          const a = 1 - age / 60
          ;(f.mesh.material as THREE.MeshBasicMaterial).opacity = a * 0.9
          f.mesh.scale.setScalar(1 + (1 - a) * 0.8)
        }
      }

      renderer.render(scene, camera)
    }
    animate()

    // ---------- Resize ----------
    const onResize = () => {
      if (!mount) return
      camera.aspect = mount.clientWidth / mount.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(mount.clientWidth, mount.clientHeight)
    }
    window.addEventListener('resize', onResize)

    onReady?.()

    // ---------- Cleanup ----------
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('resize', onResize)
      renderer.domElement.removeEventListener('mousedown', onMouseDown)
      renderer.domElement.removeEventListener('click', onCanvasClick)
      document.removeEventListener('pointerlockchange', onPointerLockChange)
      unsubShots()
      unsubStore()
      for (const id of Array.from(views.keys())) removePlayerView(id)
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement)
      }
    }
  }, [selfId, constants, mapSize, onReady])

  return <div ref={mountRef} className="absolute inset-0" />
}

// ============ Obstacles cache ============
// (Moved to src/lib/game/obstacles-cache.ts)
