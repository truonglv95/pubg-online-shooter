'use client'

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { EffectComposer, RenderPass, SMAAEffect, BloomEffect, VignetteEffect, EffectPass } from 'postprocessing'
import { useGameStore } from '@/lib/game/store'
import { subscribeShots, emitMove, emitShoot, emitSwitchWeapon } from '@/lib/game/socket'
import { getObstaclesCache } from '@/lib/game/obstacles-cache'
import type { Obstacle, PlayerSnapshot, ShotPayload, PickupSnapshot, ZoneSnapshot, WeaponId } from '@/lib/game/types'
import {
  createHumanoid, animateHumanoid, triggerRecoil, setAlive, applyGunVisual,
  type HumanoidRig,
} from './humanoid'

interface Props {
  onReady?: () => void
}

interface LocalPlayerView {
  rig: HumanoidRig
  nameSprite: THREE.Sprite
  hpBar: THREE.Mesh
  hpBarBg: THREE.Mesh
  weaponTagSprite: THREE.Sprite
  color: string
  name: string
  weapon: WeaponId
  // interpolation
  targetPos: THREE.Vector3
  currentPos: THREE.Vector3
  targetRot: number
  currentRot: number
  // animation helpers
  lastPosForVelocity: THREE.Vector3
  moving: boolean
}

const PLAYER_RADIUS = 0.6
const CAMERA_HEIGHT = 14
const CAMERA_DISTANCE = 10
const MOUSE_SENS = 0.0025
const BULLET_LIFETIME_MS = 120
const WEAPON_COOLDOWNS: Record<WeaponId, number> = {
  pistol: 280, rifle: 130, shotgun: 700, sniper: 1200,
}
const WEAPON_FIRE_MODE: Record<WeaponId, 'semi' | 'auto'> = {
  pistol: 'semi', rifle: 'auto', shotgun: 'semi', sniper: 'semi',
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
    const renderer = new THREE.WebGLRenderer({
      antialias: false,  // SMAA in post-processing handles AA
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.0
    renderer.setClearColor(0x0b1020)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0b1020)
    scene.fog = new THREE.Fog(0x0b1020, 40, 130)

    const camera = new THREE.PerspectiveCamera(55, mount.clientWidth / mount.clientHeight, 0.1, 500)
    camera.position.set(0, CAMERA_HEIGHT, CAMERA_DISTANCE)
    camera.lookAt(0, 0, 0)

    // ---------- Post-processing (bloom + SMAA + vignette) ----------
    const composer = new EffectComposer(renderer)
    composer.addPass(new RenderPass(scene, camera))
    const smaaEffect = new SMAAEffect({
      edgeDetection: 'ColorEdgeDetection',
      preset: 'high',
    })
    const bloomEffect = new BloomEffect({
      intensity: 0.55,
      luminanceThreshold: 0.55,
      luminanceSmoothing: 0.25,
      mipmapBlur: true,
      radius: 0.6,
    })
    const vignetteEffect = new VignetteEffect({
      darkness: 0.45,
      offset: 0.35,
    })
    composer.addPass(new EffectPass(camera, smaaEffect, bloomEffect, vignetteEffect))
    composer.setSize(mount.clientWidth, mount.clientHeight)

    // ---------- Lights ----------
    const hemi = new THREE.HemisphereLight(0x88aaff, 0x223344, 0.7)
    scene.add(hemi)
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.3)
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
    sun.shadow.normalBias = 0.02
    scene.add(sun)

    // Subtle ambient for fill light
    const ambient = new THREE.AmbientLight(0x404060, 0.4)
    scene.add(ambient)

    // ---------- Ground ----------
    const groundGeo = new THREE.PlaneGeometry(mapSize, mapSize, 1, 1)
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x1b2a1b, roughness: 1, metalness: 0,
    })
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
          roughness: 0.85,
          metalness: 0.1,
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
    const zoneGroup = new THREE.Group()
    scene.add(zoneGroup)

    const buildZone = (z: ZoneSnapshot) => {
      zoneGroup.clear()
      const ringGeo = new THREE.RingGeometry(Math.max(0.1, z.radius - 0.4), z.radius, 96)
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0x66ddff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthTest: false,
      })
      const ring = new THREE.Mesh(ringGeo, ringMat)
      ring.rotation.x = -Math.PI / 2
      ring.position.set(z.centerX, 0.05, z.centerZ)
      ring.renderOrder = 990
      zoneGroup.add(ring)

      const wallGeo = new THREE.CylinderGeometry(z.radius, z.radius, 10, 96, 1, true)
      const wallMat = new THREE.MeshBasicMaterial({
        color: 0x66ddff, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false,
      })
      const wall = new THREE.Mesh(wallGeo, wallMat)
      wall.position.set(z.centerX, 5, z.centerZ)
      zoneGroup.add(wall)

      if (z.targetRadius > 0 && Math.abs(z.targetRadius - z.radius) > 0.5) {
        const nextGeo = new THREE.RingGeometry(Math.max(0.1, z.targetRadius - 0.2), z.targetRadius, 96)
        const nextMat = new THREE.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthTest: false,
        })
        const next = new THREE.Mesh(nextGeo, nextMat)
        next.rotation.x = -Math.PI / 2
        next.position.set(z.targetX, 0.04, z.targetZ)
        next.renderOrder = 989
        zoneGroup.add(next)
      }
    }

    // ---------- Pickups ----------
    const pickupsGroup = new THREE.Group()
    scene.add(pickupsGroup)
    const pickupViews = new Map<string, { group: THREE.Group; icon: THREE.Mesh; beam: THREE.Mesh }>()

    const makePickup = (p: PickupSnapshot) => {
      const group = new THREE.Group()
      let color = 0xffffff
      if (p.kind === 'health') color = 0x22cc55
      else if (p.kind === 'ammo') color = 0xddaa33
      else if (p.kind === 'rifle') color = 0x4488ff
      else if (p.kind === 'shotgun') color = 0xff8844
      else if (p.kind === 'sniper') color = 0xff3388

      const baseGeo = new THREE.CylinderGeometry(0.55, 0.65, 0.15, 16)
      const baseMat = new THREE.MeshStandardMaterial({ color: 0x222233, roughness: 0.6, metalness: 0.4 })
      const base = new THREE.Mesh(baseGeo, baseMat)
      base.position.y = 0.075
      base.castShadow = true
      base.receiveShadow = true
      group.add(base)

      const iconGeo = new THREE.IcosahedronGeometry(0.32, 0)
      const iconMat = new THREE.MeshStandardMaterial({
        color, emissive: color, emissiveIntensity: 0.9, roughness: 0.3, metalness: 0.5,
      })
      const icon = new THREE.Mesh(iconGeo, iconMat)
      icon.position.y = 0.7
      icon.castShadow = true
      group.add(icon)

      const beamGeo = new THREE.CylinderGeometry(0.04, 0.18, 6, 8, 1, true)
      const beamMat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false,
      })
      const beam = new THREE.Mesh(beamGeo, beamMat)
      beam.position.y = 3
      group.add(beam)

      group.position.set(p.pos.x, 0, p.pos.z)
      group.visible = !p.taken
      pickupsGroup.add(group)

      return { group, icon, beam }
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

    // ---------- Player avatars (humanoid) ----------
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

    const makeHpBar = () => {
      const bgGeo = new THREE.PlaneGeometry(1.4, 0.16)
      const bgMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6, depthTest: false })
      const bg = new THREE.Mesh(bgGeo, bgMat)
      bg.renderOrder = 998

      const barGeo = new THREE.PlaneGeometry(1.32, 0.1)
      const barMat = new THREE.MeshBasicMaterial({ color: 0x33dd55, depthTest: false })
      const bar = new THREE.Mesh(barGeo, barMat)
      bar.position.z = 0.001
      bar.renderOrder = 999

      const container = new THREE.Group()
      container.add(bg)
      container.add(bar)
      return { container, bar, bg }
    }

    const makePlayerView = (p: PlayerSnapshot): LocalPlayerView => {
      const rig = createHumanoid(p.color)
      applyGunVisual(rig, p.currentWeapon)
      rig.group.position.set(p.pos.x, p.pos.y, p.pos.z)
      rig.group.rotation.y = p.rot
      playersGroup.add(rig.group)

      const nameSprite = makeTextSprite(p.name, p.color)
      rig.nameSpriteAnchor.add(nameSprite)

      const hpBar = makeHpBar()
      rig.hpBarAnchor.add(hpBar.container)

      const weaponTagSprite = makeTextSprite(p.currentWeapon.toUpperCase(), '#ffffff', 22, 0.45)
      weaponTagSprite.scale.set(0.7, 0.7, 1)
      rig.weaponTagAnchor.add(weaponTagSprite)

      return {
        rig, nameSprite, hpBar: hpBar.bar, hpBarBg: hpBar.bg, weaponTagSprite,
        color: p.color,
        name: p.name,
        weapon: p.currentWeapon,
        targetPos: new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z),
        currentPos: new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z),
        targetRot: p.rot,
        currentRot: p.rot,
        lastPosForVelocity: new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z),
        moving: false,
      }
    }

    const removePlayerView = (id: string) => {
      const v = views.get(id)
      if (!v) return
      playersGroup.remove(v.rig.group)
      v.nameSprite.material.map?.dispose()
      v.nameSprite.material.dispose()
      v.weaponTagSprite.material.map?.dispose()
      v.weaponTagSprite.material.dispose()
      v.hpBar.geometry.dispose()
      ;(v.hpBar.material as THREE.Material).dispose()
      ;(v.hpBarBg.material as THREE.Material).dispose()
      v.hpBarBg.geometry.dispose()
      views.delete(id)
    }

    // ---------- Local input state ----------
    const keys: Record<string, boolean> = {}
    const mouse = { down: false }
    let pointerLocked = false
    let mouseHeldSinceLastShot = false

    const trySwitchWeapon = (w: WeaponId) => {
      const self = selfIdRef.current
      if (!self) return
      const me = latestPlayersRef.current[self]
      if (!me) return
      if (!me.unlocked[w]) return
      if (me.currentWeapon === w) return
      emitSwitchWeapon(w)
      ;(window as any).__sfx?.playClick?.()
    }

    const onKeyDown = (e: KeyboardEvent) => {
      keys[e.code] = true
      if (e.code === 'Space') e.preventDefault()
      if (e.code === 'Digit1') trySwitchWeapon('pistol')
      else if (e.code === 'Digit2') trySwitchWeapon('rifle')
      else if (e.code === 'Digit3') trySwitchWeapon('shotgun')
      else if (e.code === 'Digit4') trySwitchWeapon('sniper')
    }
    const onKeyUp = (e: KeyboardEvent) => { keys[e.code] = false }
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
      if (!pointerLocked) renderer.domElement.requestPointerLock?.()
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
    // Camera FOV punch on shoot (visual recoil feel)
    let fovPunch = 0
    const baseFov = 55

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

      if (WEAPON_FIRE_MODE[weapon] === 'semi' && mouseHeldSinceLastShot) return
      mouseHeldSinceLastShot = true

      if (weapon !== 'pistol' && me.ammo[weapon] <= 0) {
        trySwitchWeapon('pistol')
        return
      }
      lastShotTs = now

      // Trigger recoil animation on the player's own rig
      triggerRecoil(v.rig)
      // Camera FOV punch (subtle zoom-out then back)
      fovPunch = weapon === 'sniper' ? 4 : weapon === 'shotgun' ? 3 : 1.5

      const muzzleWorld = new THREE.Vector3()
      v.rig.muzzle.getWorldPosition(muzzleWorld)
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(v.rig.group.quaternion).normalize()
      emitShoot({ x: forward.x, y: forward.y, z: forward.z }, { x: muzzleWorld.x, y: muzzleWorld.y, z: muzzleWorld.z })

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
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, linewidth: 2 })
      const line = new THREE.Line(geo, mat)
      tracerGroup.add(line)
      tracers.push({ line, born: performance.now() })
    }

    // ---------- Muzzle flash ----------
    const muzzleFlashGroup = new THREE.Group()
    scene.add(muzzleFlashGroup)
    interface Flash { mesh: THREE.Mesh; born: number; lifetime: number }
    const flashes: Flash[] = []
    const spawnMuzzleFlash = (at: THREE.Vector3, weapon: WeaponId) => {
      const size = weapon === 'shotgun' ? 0.55 : weapon === 'sniper' ? 0.5 : 0.3
      const geo = new THREE.SphereGeometry(size, 12, 8)
      const color = weapon === 'sniper' ? 0xff5566 : 0xffcc55
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 })
      const m = new THREE.Mesh(geo, mat)
      m.position.copy(at)
      muzzleFlashGroup.add(m)
      flashes.push({ mesh: m, born: performance.now(), lifetime: weapon === 'sniper' ? 90 : 60 })
    }

    // ---------- Blood / hit particles ----------
    interface Particle {
      mesh: THREE.Mesh
      velocity: THREE.Vector3
      born: number
      lifetime: number
      gravity: number
    }
    const particles: Particle[] = []
    const particleGroup = new THREE.Group()
    scene.add(particleGroup)
    const spawnHitParticles = (at: THREE.Vector3, color: number, count = 8) => {
      for (let i = 0; i < count; i++) {
        const geo = new THREE.SphereGeometry(0.08, 6, 4)
        const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 })
        const m = new THREE.Mesh(geo, mat)
        m.position.copy(at)
        particleGroup.add(m)
        const angle = Math.random() * Math.PI * 2
        const speed = 2 + Math.random() * 4
        const upSpeed = 1 + Math.random() * 3
        particles.push({
          mesh: m,
          velocity: new THREE.Vector3(Math.cos(angle) * speed, upSpeed, Math.sin(angle) * speed),
          born: performance.now(),
          lifetime: 500 + Math.random() * 200,
          gravity: 12,
        })
      }
    }

    // ---------- Footstep dust ----------
    interface Dust { mesh: THREE.Mesh; born: number; lifetime: number }
    const dusts: Dust[] = []
    const dustGroup = new THREE.Group()
    scene.add(dustGroup)
    let lastDustTime = 0
    const spawnFootstepDust = (at: THREE.Vector3) => {
      const now = performance.now()
      if (now - lastDustTime < 200) return
      lastDustTime = now
      const geo = new THREE.CircleGeometry(0.3, 8)
      const mat = new THREE.MeshBasicMaterial({
        color: 0x887755, transparent: true, opacity: 0.5, depthWrite: false,
      })
      const m = new THREE.Mesh(geo, mat)
      m.rotation.x = -Math.PI / 2
      m.position.set(at.x, 0.05, at.z)
      dustGroup.add(m)
      dusts.push({ mesh: m, born: now, lifetime: 400 })
    }

    // ---------- Subscribe to shots ----------
    const unsubShots = subscribeShots((s: ShotPayload) => {
      const origin = new THREE.Vector3(s.origin.x, s.origin.y, s.origin.z)
      for (const tracer of s.tracers) {
        const end = new THREE.Vector3(tracer.end.x, tracer.end.y, tracer.end.z)
        spawnTracer(origin, end, s.weapon, !!tracer.hitPlayerId)
        if (tracer.hitPlayerId) {
          // Spawn blood particles at hit point
          spawnHitParticles(end, 0xcc2222, 10)
        } else {
          // Spark particles at impact point
          spawnHitParticles(end, 0xffaa44, 4)
        }
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

        // HP bar
        const ratio = Math.max(0, snap.hp) / 100
        v.hpBar.scale.x = ratio
        v.hpBar.position.x = -(1 - ratio) * 0.66
        const hpColor = ratio > 0.6 ? 0x33dd55 : ratio > 0.3 ? 0xffaa22 : 0xff3322
        ;(v.hpBar.material as THREE.MeshBasicMaterial).color.setHex(hpColor)

        // Alive/dead state
        setAlive(v.rig, snap.alive)

        // Visibility of name/hp
        const isSelf = id === selfIdRef.current
        v.nameSprite.visible = !isSelf && snap.alive
        v.hpBar.visible = !isSelf && snap.alive
        v.hpBarBg.visible = !isSelf && snap.alive
        v.weaponTagSprite.visible = !isSelf && snap.alive

        // Body ghosting when dead
        v.rig.bodyMat.transparent = !snap.alive
        v.rig.bodyMat.opacity = snap.alive ? 1 : 0.35
        v.rig.headMat.transparent = !snap.alive
        v.rig.headMat.opacity = snap.alive ? 1 : 0.35

        if (v.name !== snap.name) {
          v.rig.nameSpriteAnchor.remove(v.nameSprite)
          v.nameSprite.material.map?.dispose()
          v.nameSprite.material.dispose()
          const newSprite = makeTextSprite(snap.name, snap.color)
          v.rig.nameSpriteAnchor.add(newSprite)
          v.nameSprite = newSprite
          v.name = snap.name
        }
        if (v.color !== snap.color) {
          v.rig.bodyMat.color.set(snap.color)
          v.color = snap.color
        }
        if (v.weapon !== snap.currentWeapon) {
          applyGunVisual(v.rig, snap.currentWeapon)
          v.rig.weaponTagAnchor.remove(v.weaponTagSprite)
          v.weaponTagSprite.material.map?.dispose()
          v.weaponTagSprite.material.dispose()
          const tag = makeTextSprite(snap.currentWeapon.toUpperCase(), '#ffffff', 22, 0.45)
          tag.scale.set(0.7, 0.7, 1)
          v.rig.weaponTagAnchor.add(tag)
          v.weaponTagSprite = tag
          v.weapon = snap.currentWeapon
        }
      }
      for (const id of Array.from(views.keys())) {
        if (!seen.has(id)) removePlayerView(id)
      }
      syncPickups(state.pickups)
      if (state.zone) buildZone(state.zone)
    })

    const obstacles = getObstaclesCache()
    if (obstacles) buildObstacles(obstacles)

    // ---------- Movement ----------
    const SPEED = constants.PLAYER_SPEED
    let lastEmit = 0
    const EMIT_INTERVAL = 50
    let dustAccumulator = 0

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
    const camTargetPos = new THREE.Vector3(0, CAMERA_HEIGHT, CAMERA_DISTANCE)
    const camLookTarget = new THREE.Vector3()

    const animate = () => {
      raf = requestAnimationFrame(animate)
      const now = performance.now()
      const dt = Math.min(0.05, (now - prev) / 1000)
      prev = now

      movePlayer(dt)

      // Interpolate + animate humanoids
      const lerpFactor = 1 - Math.pow(0.001, dt)
      for (const v of views.values()) {
        // Position lerp + compute movement for walk animation
        const prevCurrent = v.currentPos.clone()
        v.currentPos.lerp(v.targetPos, lerpFactor)
        v.rig.group.position.copy(v.currentPos)

        // Compute actual movement speed for walk cycle
        const moveDelta = v.currentPos.distanceTo(prevCurrent)
        const speed01 = Math.min(1, moveDelta / (SPEED * dt * 0.8))
        v.moving = speed01 > 0.05

        // Spawn footstep dust when moving
        if (v.moving && v.rig.alive) {
          dustAccumulator += dt
          if (dustAccumulator > 0.3) {
            dustAccumulator = 0
            spawnFootstepDust(v.currentPos)
          }
        }

        // Rotation
        let dr = v.targetRot - v.currentRot
        while (dr > Math.PI) dr -= Math.PI * 2
        while (dr < -Math.PI) dr += Math.PI * 2
        v.currentRot += dr * lerpFactor
        v.rig.group.rotation.y = v.currentRot

        // Animate the humanoid rig (walk cycle, idle, recoil, death)
        animateHumanoid(v.rig, dt, v.moving, speed01)

        // Billboard HP bar / name / weapon tag
        v.hpBar.quaternion.copy(camera.quaternion)
        v.hpBarBg.quaternion.copy(camera.quaternion)
        v.nameSprite.quaternion.copy(camera.quaternion)
        v.weaponTagSprite.quaternion.copy(camera.quaternion)
      }

      // Camera follows local player with damping
      const self = selfIdRef.current
      if (self) {
        const v = views.get(self)
        if (v) {
          const target = v.currentPos
          const desiredPos = new THREE.Vector3(
            target.x,
            target.y + CAMERA_HEIGHT,
            target.z + CAMERA_DISTANCE,
          )
          camTargetPos.lerp(desiredPos, 1 - Math.pow(0.005, dt))  // smooth damping
          camera.position.copy(camTargetPos)

          // FOV punch decay
          fovPunch = Math.max(0, fovPunch - dt * 12)
          camera.fov = baseFov + fovPunch
          camera.updateProjectionMatrix()

          // Look-at target with slight lead forward
          const lookDesired = new THREE.Vector3(target.x, target.y + 1, target.z)
          camLookTarget.lerp(lookDesired, 1 - Math.pow(0.001, dt))
          camera.lookAt(camLookTarget)
        }
      }

      // Pickup spin/bob
      for (const pv of pickupViews.values()) {
        if (pv.group.visible) {
          pv.icon.rotation.y += 0.025
          pv.icon.rotation.x += 0.012
          pv.icon.position.y = 0.7 + Math.sin(now / 400) * 0.08
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

      // Muzzle flashes
      for (let i = flashes.length - 1; i >= 0; i--) {
        const f = flashes[i]
        const age = now - f.born
        if (age > f.lifetime) {
          muzzleFlashGroup.remove(f.mesh)
          f.mesh.geometry.dispose()
          ;(f.mesh.material as THREE.Material).dispose()
          flashes.splice(i, 1)
        } else {
          const a = 1 - age / f.lifetime
          ;(f.mesh.material as THREE.MeshBasicMaterial).opacity = a * 0.95
          f.mesh.scale.setScalar(1 + (1 - a) * 1.2)
        }
      }

      // Particles (blood / sparks)
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]
        const age = now - p.born
        if (age > p.lifetime) {
          particleGroup.remove(p.mesh)
          p.mesh.geometry.dispose()
          ;(p.mesh.material as THREE.Material).dispose()
          particles.splice(i, 1)
        } else {
          const a = 1 - age / p.lifetime
          ;(p.mesh.material as THREE.MeshBasicMaterial).opacity = a
          p.velocity.y -= p.gravity * dt
          p.mesh.position.x += p.velocity.x * dt
          p.mesh.position.y += p.velocity.y * dt
          p.mesh.position.z += p.velocity.z * dt
          if (p.mesh.position.y < 0.05) {
            p.mesh.position.y = 0.05
            p.velocity.y *= -0.3
            p.velocity.x *= 0.7
            p.velocity.z *= 0.7
          }
        }
      }

      // Dust particles
      for (let i = dusts.length - 1; i >= 0; i--) {
        const d = dusts[i]
        const age = now - d.born
        if (age > d.lifetime) {
          dustGroup.remove(d.mesh)
          d.mesh.geometry.dispose()
          ;(d.mesh.material as THREE.Material).dispose()
          dusts.splice(i, 1)
        } else {
          const a = 1 - age / d.lifetime
          ;(d.mesh.material as THREE.MeshBasicMaterial).opacity = a * 0.5
          d.mesh.scale.setScalar(1 + (1 - a) * 1.5)
        }
      }

      composer.render()
    }
    animate()

    // ---------- Resize ----------
    const onResize = () => {
      if (!mount) return
      camera.aspect = mount.clientWidth / mount.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(mount.clientWidth, mount.clientHeight)
      composer.setSize(mount.clientWidth, mount.clientHeight)
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
      composer.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement)
      }
    }
  }, [selfId, constants, mapSize, onReady])

  return <div ref={mountRef} className="absolute inset-0" />
}
