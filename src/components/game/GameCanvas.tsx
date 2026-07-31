'use client'

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useGameStore } from '@/lib/game/store'
import { subscribeShots, emitMove, emitShoot, emitSwitchWeapon } from '@/lib/game/socket'
import { getObstaclesCache } from '@/lib/game/obstacles-cache'
import type { Obstacle, PlayerSnapshot, ShotPayload, PickupSnapshot, ZoneSnapshot, WeaponId } from '@/lib/game/types'

interface Props {
  onReady?: () => void
}

interface LocalPlayerView {
  group: THREE.Group
  body: THREE.Mesh
  head: THREE.Mesh
  gun: THREE.Mesh
  gunMat: THREE.MeshStandardMaterial
  nameSprite: THREE.Sprite
  hpBar: THREE.Mesh
  hpBarBg: THREE.Mesh
  weaponTagSprite: THREE.Sprite
  muzzle: THREE.Object3D
  color: string
  name: string
  weapon: WeaponId
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

// Per-weapon gun mesh dimensions (visual feedback when switching weapons).
const GUN_VISUALS: Record<WeaponId, { size: [number, number, number]; color: number; offset: [number, number, number] }> = {
  pistol:  { size: [0.12, 0.12, 0.5], color: 0x333333, offset: [0.3, 0.95, 0.35] },
  rifle:   { size: [0.14, 0.14, 1.0], color: 0x2a2a2a, offset: [0.32, 0.95, 0.55] },
  shotgun: { size: [0.18, 0.18, 1.1], color: 0x4a3a2a, offset: [0.32, 0.95, 0.55] },
  sniper:  { size: [0.12, 0.12, 1.6], color: 0x1a1a2a, offset: [0.32, 1.05, 0.7] },
}

export default function GameCanvas({ onReady }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const selfId = useGameStore((s) => s.selfId)
  const constants = useGameStore((s) => s.constants)
  const mapSize = useGameStore((s) => s.mapSize)
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
    renderer.shadowMap.type = THREE.PCFShadowMap
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
    const groundGeo = new THREE.PlaneGeometry(mapSize, mapSize, 1, 1)
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x1b2a1b, roughness: 1, metalness: 0 })
    const ground = new THREE.Mesh(groundGeo, groundMat)
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    scene.add(ground)

    const grid = new THREE.GridHelper(mapSize, mapSize / 4, 0x335544, 0x223322)
    grid.position.y = 0.01
    scene.add(grid)

    const outerGeo = new THREE.PlaneGeometry(mapSize * 4, mapSize * 4)
    const outerMat = new THREE.MeshBasicMaterial({ color: 0x05080f })
    const outer = new THREE.Mesh(outerGeo, outerMat)
    outer.rotation.x = -Math.PI / 2
    outer.position.y = -0.02
    scene.add(outer)

    // ---------- Obstacles ----------
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

        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(geo),
          new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4 }),
        )
        edges.position.copy(m.position)
        obstacleGroup.add(edges)
      }
    }

    // ---------- Zone (battle-royale circle) ----------
    // Render as a translucent ring on the ground + a vertical "wall" cylinder.
    const zoneGroup = new THREE.Group()
    scene.add(zoneGroup)
    let zoneRingMesh: THREE.Mesh | null = null
    let zoneWallMesh: THREE.Mesh | null = null
    let zoneNextRingMesh: THREE.Mesh | null = null  // shows the next target circle

    const buildZone = (z: ZoneSnapshot) => {
      zoneGroup.clear()
      // Outer (current) ring on the ground
      const ringGeo = new THREE.RingGeometry(Math.max(0.1, z.radius - 0.4), z.radius, 64)
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0x66ddff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthTest: false,
      })
      zoneRingMesh = new THREE.Mesh(ringGeo, ringMat)
      zoneRingMesh.rotation.x = -Math.PI / 2
      zoneRingMesh.position.set(z.centerX, 0.05, z.centerZ)
      zoneRingMesh.renderOrder = 990
      zoneGroup.add(zoneRingMesh)

      // Vertical translucent wall cylinder around the perimeter
      const wallGeo = new THREE.CylinderGeometry(z.radius, z.radius, 8, 64, 1, true)
      const wallMat = new THREE.MeshBasicMaterial({
        color: 0x66ddff, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false,
      })
      zoneWallMesh = new THREE.Mesh(wallGeo, wallMat)
      zoneWallMesh.position.set(z.centerX, 4, z.centerZ)
      zoneGroup.add(zoneWallMesh)

      // Next target ring (during holding phase)
      if (z.targetRadius > 0 && Math.abs(z.targetRadius - z.radius) > 0.5) {
        const nextGeo = new THREE.RingGeometry(Math.max(0.1, z.targetRadius - 0.2), z.targetRadius, 64)
        const nextMat = new THREE.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthTest: false,
        })
        zoneNextRingMesh = new THREE.Mesh(nextGeo, nextMat)
        zoneNextRingMesh.rotation.x = -Math.PI / 2
        zoneNextRingMesh.position.set(z.targetX, 0.04, z.targetZ)
        zoneNextRingMesh.renderOrder = 989
        zoneGroup.add(zoneNextRingMesh)
      }
    }

    // ---------- Pickups ----------
    const pickupsGroup = new THREE.Group()
    scene.add(pickupsGroup)
    const pickupViews = new Map<string, { group: THREE.Group; spin: () => void; bob: () => void }>()

    const makePickup = (p: PickupSnapshot) => {
      const group = new THREE.Group()
      let color = 0xffffff
      let label = '?'
      if (p.kind === 'health') { color = 0x22cc55; label = '+' }
      else if (p.kind === 'ammo') { color = 0xddaa33; label = 'A' }
      else if (p.kind === 'rifle') { color = 0x4488ff; label = 'R' }
      else if (p.kind === 'shotgun') { color = 0xff8844; label = 'S' }
      else if (p.kind === 'sniper') { color = 0xff3388; label = 'X' }

      // Base platform
      const baseGeo = new THREE.CylinderGeometry(0.6, 0.7, 0.15, 12)
      const baseMat = new THREE.MeshStandardMaterial({ color: 0x222233, roughness: 0.6, metalness: 0.3 })
      const base = new THREE.Mesh(baseGeo, baseMat)
      base.position.y = 0.075
      base.castShadow = true
      group.add(base)

      // Glowing icon (vertical box) with the kind color
      const iconGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5)
      const iconMat = new THREE.MeshStandardMaterial({
        color, emissive: color, emissiveIntensity: 0.6, roughness: 0.3, metalness: 0.4,
      })
      const icon = new THREE.Mesh(iconGeo, iconMat)
      icon.position.y = 0.7
      icon.castShadow = true
      group.add(icon)

      // Vertical beam (so you can see it from across the map)
      const beamGeo = new THREE.CylinderGeometry(0.05, 0.2, 6, 8, 1, true)
      const beamMat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false,
      })
      const beam = new THREE.Mesh(beamGeo, beamMat)
      beam.position.y = 3
      group.add(beam)

      group.position.set(p.pos.x, 0, p.pos.z)
      group.visible = !p.taken
      pickupsGroup.add(group)

      const initialY = group.position.y
      return {
        group,
        spin: () => { icon.rotation.y += 0.03 },
        bob: () => { icon.position.y = 0.7 + Math.sin(performance.now() / 400) * 0.08; group.position.y = initialY },
      }
    }

    const removePickup = (id: string) => {
      const v = pickupViews.get(id)
      if (!v) return
      pickupsGroup.remove(v.group)
      v.group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose()
          ;(obj.material as THREE.Material).dispose()
        }
      })
      pickupViews.delete(id)
    }

    const syncPickups = (list: PickupSnapshot[]) => {
      const seen = new Set<string>()
      for (const p of list) {
        seen.add(p.id)
        let v = pickupViews.get(p.id)
        if (!v) {
          v = makePickup(p)
          pickupViews.set(p.id, v)
        }
        v.group.visible = !p.taken
      }
      for (const id of Array.from(pickupViews.keys())) {
        if (!seen.has(id)) removePickup(id)
      }
    }

    // ---------- Player avatars ----------
    const playersGroup = new THREE.Group()
    scene.add(playersGroup)
    const views = new Map<string, LocalPlayerView>()

    const makeTextSprite = (text: string, color: string, fontSize = 36, bgOpacity = 0.55) => {
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')!
      ctx.font = `bold ${fontSize}px Inter, Arial, sans-serif`
      const metrics = ctx.measureText(text)
      const w = Math.ceil(metrics.width) + 16
      const h = fontSize + 12
      canvas.width = w
      canvas.height = h
      ctx.fillStyle = `rgba(0,0,0,${bgOpacity})`
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
      return sprite
    }

    const applyGunVisual = (gun: THREE.Mesh, gunMat: THREE.MeshStandardMaterial, weapon: WeaponId) => {
      const vis = GUN_VISUALS[weapon]
      gun.scale.set(vis.size[0] / 0.15, vis.size[1] / 0.15, vis.size[2] / 1.0)
      gun.position.set(vis.offset[0], vis.offset[1] * PLAYER_HEIGHT - PLAYER_HEIGHT, vis.offset[2])
      gunMat.color.setHex(vis.color)
    }

    const makePlayerView = (p: PlayerSnapshot): LocalPlayerView => {
      const group = new THREE.Group()
      const color = new THREE.Color(p.color)

      const bodyGeo = new THREE.CapsuleGeometry(PLAYER_RADIUS, PLAYER_HEIGHT - PLAYER_RADIUS * 2, 6, 12)
      const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.2 })
      const body = new THREE.Mesh(bodyGeo, bodyMat)
      body.position.y = PLAYER_HEIGHT / 2
      body.castShadow = true
      group.add(body)

      const headGeo = new THREE.SphereGeometry(0.32, 16, 12)
      const headMat = new THREE.MeshStandardMaterial({ color: color.clone().lerp(new THREE.Color(0xffffff), 0.3), roughness: 0.4 })
      const head = new THREE.Mesh(headGeo, headMat)
      head.position.y = PLAYER_HEIGHT + 0.05
      head.castShadow = true
      group.add(head)

      const gunGeo = new THREE.BoxGeometry(0.15, 0.15, 1.0)
      const gunMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.5, metalness: 0.6 })
      const gun = new THREE.Mesh(gunGeo, gunMat)
      gun.position.set(0.35, PLAYER_HEIGHT * 0.55, 0.55)
      gun.castShadow = true
      group.add(gun)

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
      nameSprite.position.y = PLAYER_HEIGHT + 0.6
      group.add(nameSprite)

      // Weapon tag (small sprite under name)
      const weaponTagSprite = makeTextSprite(p.currentWeapon.toUpperCase(), '#ffffff', 22, 0.45)
      weaponTagSprite.position.y = PLAYER_HEIGHT + 1.3
      weaponTagSprite.scale.set(0.7, 0.7, 1)
      group.add(weaponTagSprite)

      group.position.set(p.pos.x, p.pos.y, p.pos.z)
      group.rotation.y = p.rot
      playersGroup.add(group)

      const v: LocalPlayerView = {
        group, body, head, gun, gunMat, nameSprite, hpBar, hpBarBg, weaponTagSprite, muzzle,
        color: p.color,
        name: p.name,
        weapon: p.currentWeapon,
        targetPos: new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z),
        currentPos: new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z),
        targetRot: p.rot,
        currentRot: p.rot,
      }
      applyGunVisual(gun, gunMat, p.currentWeapon)
      return v
    }

    const removePlayerView = (id: string) => {
      const v = views.get(id)
      if (!v) return
      playersGroup.remove(v.group)
      v.body.geometry.dispose()
      ;(v.body.material as THREE.Material).dispose()
      v.head.geometry.dispose()
      ;(v.head.material as THREE.Material).dispose()
      v.gun.geometry.dispose()
      ;(v.gun.material as THREE.Material).dispose()
      v.hpBar.geometry.dispose()
      ;(v.hpBar.material as THREE.Material).dispose()
      v.hpBarBg.geometry.dispose()
      ;(v.hpBarBg.material as THREE.Material).dispose()
      ;(v.nameSprite.material as THREE.SpriteMaterial).map?.dispose()
      ;(v.nameSprite.material as THREE.SpriteMaterial).dispose()
      ;(v.weaponTagSprite.material as THREE.SpriteMaterial).map?.dispose()
      ;(v.weaponTagSprite.material as THREE.SpriteMaterial).dispose()
      views.delete(id)
    }

    // ---------- Local input state ----------
    const keys: Record<string, boolean> = {}
    const mouse = { down: false }
    let pointerLocked = false
    // Track whether mouse button is currently held AND we already fired the first shot
    // (for semi-auto weapons we need a fresh click for each shot).
    let mouseHeldSinceLastShot = false

    const WEAPON_COOLDOWNS: Record<WeaponId, number> = {
      pistol: 280, rifle: 130, shotgun: 700, sniper: 1200,
    }
    const WEAPON_FIRE_MODE: Record<WeaponId, 'semi' | 'auto'> = {
      pistol: 'semi', rifle: 'auto', shotgun: 'semi', sniper: 'semi',
    }

    const onKeyDown = (e: KeyboardEvent) => {
      keys[e.code] = true
      if (e.code === 'Space') e.preventDefault()
      // Weapon switch hotkeys: 1=pistol, 2=rifle, 3=shotgun, 4=sniper
      if (e.code === 'Digit1') trySwitchWeapon('pistol')
      else if (e.code === 'Digit2') trySwitchWeapon('rifle')
      else if (e.code === 'Digit3') trySwitchWeapon('shotgun')
      else if (e.code === 'Digit4') trySwitchWeapon('sniper')
      // Mouse wheel: cycle weapons (handled in wheel event below)
    }
    const onKeyUp = (e: KeyboardEvent) => { keys[e.code] = false }

    const trySwitchWeapon = (w: WeaponId) => {
      const self = selfIdRef.current
      if (!self) return
      const me = latestPlayersRef.current[self]
      if (!me) return
      if (!me.unlocked[w]) return
      if (me.currentWeapon === w) return
      emitSwitchWeapon(w)
      // Play click sound (via window sfx hook)
      ;(window as any).__sfx?.playClick?.()
    }

    const onMouseMove = (e: MouseEvent) => {
      if (!pointerLocked) return
      const self = selfIdRef.current
      if (!self) return
      const v = views.get(self)
      if (!v) return
      v.targetRot -= e.movementX * MOUSE_SENS
    }
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 0) {
        mouse.down = true
        mouseHeldSinceLastShot = false
        tryShoot()
      }
    }
    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 0) {
        mouse.down = false
        mouseHeldSinceLastShot = false
      }
    }
    const onWheel = (e: WheelEvent) => {
      const self = selfIdRef.current
      if (!self) return
      const me = latestPlayersRef.current[self]
      if (!me) return
      const order: WeaponId[] = ['pistol', 'rifle', 'shotgun', 'sniper']
      const unlocked = order.filter((w) => me.unlocked[w])
      if (unlocked.length < 2) return
      const idx = unlocked.indexOf(me.currentWeapon)
      const nextIdx = (idx + (e.deltaY > 0 ? 1 : -1) + unlocked.length) % unlocked.length
      trySwitchWeapon(unlocked[nextIdx])
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
    window.addEventListener('wheel', onWheel, { passive: true })
    renderer.domElement.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mouseup', onMouseUp)
    document.addEventListener('pointerlockchange', onPointerLockChange)
    renderer.domElement.addEventListener('click', onCanvasClick)

    // ---------- Shooting ----------
    let lastShotTs = 0

    const tryShoot = () => {
      const self = selfIdRef.current
      if (!self) return
      const v = views.get(self)
      if (!v) return
      const me = latestPlayersRef.current[self]
      if (!me || !me.alive) return

      const weapon = me.currentWeapon
      const cooldown = WEAPON_COOLDOWNS[weapon]
      const now = performance.now()
      if (now - lastShotTs < cooldown) return

      // Semi-auto: require a fresh click for each shot
      if (WEAPON_FIRE_MODE[weapon] === 'semi' && mouseHeldSinceLastShot) return
      mouseHeldSinceLastShot = true

      // Ammo check
      if (weapon !== 'pistol' && me.ammo[weapon] <= 0) {
        // Auto-switch back to pistol
        trySwitchWeapon('pistol')
        return
      }

      lastShotTs = now

      const muzzleWorld = new THREE.Vector3()
      v.muzzle.getWorldPosition(muzzleWorld)
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(v.group.quaternion).normalize()
      const dir = forward.clone()
      emitShoot({ x: dir.x, y: dir.y, z: dir.z }, { x: muzzleWorld.x, y: muzzleWorld.y, z: muzzleWorld.z })

      spawnMuzzleFlash(muzzleWorld, weapon)
    }

    // ---------- Bullet tracers ----------
    interface Tracer { line: THREE.Line; born: number }
    const tracers: Tracer[] = []
    const tracerGroup = new THREE.Group()
    scene.add(tracerGroup)

    const spawnTracer = (origin: THREE.Vector3, end: THREE.Vector3, weapon: WeaponId, hitPlayer: boolean) => {
      const geo = new THREE.BufferGeometry().setFromPoints([origin.clone(), end.clone()])
      const color =
        hitPlayer ? 0xff5533 :
        weapon === 'sniper' ? 0xff3366 :
        weapon === 'shotgun' ? 0xff8855 :
        0xffee88
      const mat = new THREE.LineBasicMaterial({
        color, transparent: true, opacity: 0.95,
      })
      const line = new THREE.Line(geo, mat)
      tracerGroup.add(line)
      tracers.push({ line, born: performance.now() })
    }

    const muzzleFlashGroup = new THREE.Group()
    scene.add(muzzleFlashGroup)
    interface Flash { mesh: THREE.Mesh; born: number }
    const flashes: Flash[] = []
    const spawnMuzzleFlash = (at: THREE.Vector3, weapon: WeaponId) => {
      const size = weapon === 'shotgun' ? 0.5 : weapon === 'sniper' ? 0.4 : 0.25
      const geo = new THREE.SphereGeometry(size, 8, 8)
      const color = weapon === 'sniper' ? 0xff5566 : 0xffcc55
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 })
      const m = new THREE.Mesh(geo, mat)
      m.position.copy(at)
      muzzleFlashGroup.add(m)
      flashes.push({ mesh: m, born: performance.now() })
    }

    const unsubShots = subscribeShots((s: ShotPayload) => {
      const origin = new THREE.Vector3(s.origin.x, s.origin.y, s.origin.z)
      for (const tracer of s.tracers) {
        spawnTracer(
          origin,
          new THREE.Vector3(tracer.end.x, tracer.end.y, tracer.end.z),
          s.weapon,
          !!tracer.hitPlayerId,
        )
      }
    })

    // ---------- Store subscription ----------
    const unsubStore = useGameStore.subscribe((state) => {
      latestPlayersRef.current = state.players
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
        const ratio = Math.max(0, snap.hp) / 100
        v.hpBar.scale.x = ratio
        v.hpBar.position.x = -(1 - ratio) * 0.66
        const hpColor = ratio > 0.6 ? 0x33dd55 : ratio > 0.3 ? 0xffaa22 : 0xff3322
        ;(v.hpBar.material as THREE.MeshBasicMaterial).color.setHex(hpColor)
        v.group.visible = true
        if (!snap.alive) {
          ;(v.body.material as THREE.MeshStandardMaterial).transparent = true
          ;(v.body.material as THREE.MeshStandardMaterial).opacity = 0.25
          ;(v.head.material as THREE.MeshStandardMaterial).transparent = true
          ;(v.head.material as THREE.MeshStandardMaterial).opacity = 0.25
          ;(v.gun.material as THREE.MeshStandardMaterial).transparent = true
          ;(v.gun.material as THREE.MeshStandardMaterial).opacity = 0.25
          v.hpBar.visible = false
          v.hpBarBg.visible = false
          v.nameSprite.visible = false
          v.weaponTagSprite.visible = false
        } else {
          ;(v.body.material as THREE.MeshStandardMaterial).transparent = false
          ;(v.body.material as THREE.MeshStandardMaterial).opacity = 1
          ;(v.head.material as THREE.MeshStandardMaterial).transparent = false
          ;(v.head.material as THREE.MeshStandardMaterial).opacity = 1
          ;(v.gun.material as THREE.MeshStandardMaterial).transparent = false
          ;(v.gun.material as THREE.MeshStandardMaterial).opacity = 1
          const isSelf = id === selfIdRef.current
          v.hpBar.visible = !isSelf
          v.hpBarBg.visible = !isSelf
          v.nameSprite.visible = !isSelf
          v.weaponTagSprite.visible = !isSelf
        }
        if (v.name !== snap.name) {
          v.group.remove(v.nameSprite)
          ;(v.nameSprite.material as THREE.SpriteMaterial).map?.dispose()
          ;(v.nameSprite.material as THREE.SpriteMaterial).dispose()
          const newSprite = makeTextSprite(snap.name, snap.color)
          newSprite.position.y = PLAYER_HEIGHT + 0.6
          v.group.add(newSprite)
          v.nameSprite = newSprite
          v.name = snap.name
        }
        if (v.color !== snap.color) {
          ;(v.body.material as THREE.MeshStandardMaterial).color.set(snap.color)
          v.color = snap.color
        }
        // Update weapon visuals
        if (v.weapon !== snap.currentWeapon) {
          applyGunVisual(v.gun, v.gunMat, snap.currentWeapon)
          // Update weapon tag
          v.group.remove(v.weaponTagSprite)
          ;(v.weaponTagSprite.material as THREE.SpriteMaterial).map?.dispose()
          ;(v.weaponTagSprite.material as THREE.SpriteMaterial).dispose()
          const tag = makeTextSprite(snap.currentWeapon.toUpperCase(), '#ffffff', 22, 0.45)
          tag.position.y = PLAYER_HEIGHT + 1.3
          tag.scale.set(0.7, 0.7, 1)
          v.group.add(tag)
          v.weaponTagSprite = tag
          v.weapon = snap.currentWeapon
        }
      }
      for (const id of Array.from(views.keys())) {
        if (!seen.has(id)) removePlayerView(id)
      }
      // Pickups
      syncPickups(state.pickups)
      // Zone
      if (state.zone) buildZone(state.zone)
    })

    const obstacles = getObstaclesCache()
    if (obstacles) buildObstacles(obstacles)

    // ---------- Movement ----------
    const SPEED = constants.PLAYER_SPEED
    let lastEmit = 0
    const EMIT_INTERVAL = 50

    const movePlayer = (dt: number) => {
      const self = selfIdRef.current
      if (!self) return
      const v = views.get(self)
      if (!v) return
      const me = latestPlayersRef.current[self]
      if (!me || !me.alive) return

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
        const half = mapSize / 2 - PLAYER_RADIUS
        v.targetPos.x = Math.max(-half, Math.min(half, v.targetPos.x))
        v.targetPos.z = Math.max(-half, Math.min(half, v.targetPos.z))
      }

      // Auto-fire for AUTO weapons only; SEMI requires fresh click
      if (mouse.down) {
        const weapon = me.currentWeapon
        if (WEAPON_FIRE_MODE[weapon] === 'auto') tryShoot()
      }

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

      const lerpFactor = 1 - Math.pow(0.001, dt)
      for (const v of views.values()) {
        v.currentPos.lerp(v.targetPos, lerpFactor)
        v.group.position.copy(v.currentPos)
        let dr = v.targetRot - v.currentRot
        while (dr > Math.PI) dr -= Math.PI * 2
        while (dr < -Math.PI) dr += Math.PI * 2
        v.currentRot += dr * lerpFactor
        v.group.rotation.y = v.currentRot
        v.hpBar.quaternion.copy(camera.quaternion)
        v.hpBarBg.quaternion.copy(camera.quaternion)
        v.nameSprite.quaternion.copy(camera.quaternion)
        v.weaponTagSprite.quaternion.copy(camera.quaternion)
      }

      // Pickup spin/bob
      for (const pv of pickupViews.values()) {
        if (pv.group.visible) { pv.spin(); pv.bob() }
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

      // Tracers fade
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
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('resize', onResize)
      renderer.domElement.removeEventListener('mousedown', onMouseDown)
      renderer.domElement.removeEventListener('click', onCanvasClick)
      document.removeEventListener('pointerlockchange', onPointerLockChange)
      unsubShots()
      unsubStore()
      for (const id of Array.from(views.keys())) removePlayerView(id)
      for (const id of Array.from(pickupViews.keys())) removePickup(id)
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement)
      }
    }
  }, [selfId, constants, mapSize, onReady])

  return <div ref={mountRef} className="absolute inset-0" />
}
