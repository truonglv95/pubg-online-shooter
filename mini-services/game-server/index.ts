import { createServer } from 'http'
import { Server } from 'socket.io'

const httpServer = createServer()
const io = new Server(httpServer, {
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

// ============== Game constants ==============
const MAP_SIZE = 80            // ground is MAP_SIZE x MAP_SIZE
const HALF_MAP = MAP_SIZE / 2
const PLAYER_RADIUS = 0.6
const PLAYER_SPEED = 12        // units/sec
const MAX_HP = 100
const RESPAWN_MS = 4000
const TICK_RATE_HZ = 30
const TICK_MS = 1000 / TICK_RATE_HZ

// ============== Weapon definitions ==============
// Each weapon has independent damage / cooldown / range / pellets / spread.
type WeaponId = 'pistol' | 'rifle' | 'shotgun' | 'sniper'
interface WeaponDef {
  id: WeaponId
  name: string
  damage: number
  cooldown: number   // ms between shots
  range: number
  pellets: number    // bullets per shot (1 for single-shot weapons)
  spread: number     // radians of random cone (per pellet)
  ammoPerPickup: number
  bulletColor: number // for client tracer (hex)
  fireMode: 'semi' | 'auto'
}

const WEAPONS: Record<WeaponId, WeaponDef> = {
  pistol: {
    id: 'pistol', name: 'Pistol',
    damage: 14, cooldown: 280, range: 70,
    pellets: 1, spread: 0.01,
    ammoPerPickup: 999, // infinite reserve (sidearm)
    bulletColor: 0xffee88,
    fireMode: 'semi',
  },
  rifle: {
    id: 'rifle', name: 'Rifle',
    damage: 16, cooldown: 130, range: 100,
    pellets: 1, spread: 0.02,
    ammoPerPickup: 30,
    bulletColor: 0xffee88,
    fireMode: 'auto',
  },
  shotgun: {
    id: 'shotgun', name: 'Shotgun',
    damage: 9, cooldown: 700, range: 35,
    pellets: 8, spread: 0.18,
    ammoPerPickup: 6,
    bulletColor: 0xff8855,
    fireMode: 'semi',
  },
  sniper: {
    id: 'sniper', name: 'Sniper',
    damage: 75, cooldown: 1200, range: 200,
    pellets: 1, spread: 0.0,
    ammoPerPickup: 5,
    bulletColor: 0xff3366,
    fireMode: 'semi',
  },
}
const WEAPON_IDS: WeaponId[] = ['pistol', 'rifle', 'shotgun', 'sniper']

// ============== Types ==============
type Vec3 = { x: number; y: number; z: number }

interface Player {
  id: string
  name: string
  color: string
  pos: Vec3
  rot: number         // yaw around Y
  hp: number
  alive: boolean
  kills: number
  deaths: number
  lastShotAt: number
  respawnAt: number | null
  connected: boolean
  // weapons
  currentWeapon: WeaponId
  ammo: Record<WeaponId, number>   // current ammo per weapon
  unlocked: Record<WeaponId, boolean>
}

interface Obstacle {
  id: string
  pos: Vec3
  size: Vec3
}

type PickupKind = 'health' | 'ammo' | 'rifle' | 'shotgun' | 'sniper'
interface Pickup {
  id: string
  kind: PickupKind
  pos: Vec3
  taken: boolean
  respawnAt: number
}

// ============== World setup ==============
const players = new Map<string, Player>()

const obstacles: Obstacle[] = (() => {
  const list: Obstacle[] = []
  const wallThick = 2
  const wallH = 4
  list.push({ id: 'w_n', pos: { x: 0, y: wallH / 2, z: -HALF_MAP - wallThick / 2 }, size: { x: MAP_SIZE + wallThick * 2, y: wallH, z: wallThick } })
  list.push({ id: 'w_s', pos: { x: 0, y: wallH / 2, z: HALF_MAP + wallThick / 2 }, size: { x: MAP_SIZE + wallThick * 2, y: wallH, z: wallThick } })
  list.push({ id: 'w_e', pos: { x: HALF_MAP + wallThick / 2, y: wallH / 2, z: 0 }, size: { x: wallThick, y: wallH, z: MAP_SIZE + wallThick * 2 } })
  list.push({ id: 'w_w', pos: { x: -HALF_MAP - wallThick / 2, y: wallH / 2, z: 0 }, size: { x: wallThick, y: wallH, z: MAP_SIZE + wallThick * 2 } })

  list.push({ id: 'c1', pos: { x: 0, y: 1.5, z: 0 }, size: { x: 8, y: 3, z: 8 } })
  list.push({ id: 'c2', pos: { x: 0, y: 3.5, z: 0 }, size: { x: 4, y: 1, z: 4 } })

  const rng = mulberry32(1337)
  for (let i = 0; i < 28; i++) {
    const x = (rng() * 2 - 1) * (HALF_MAP - 6)
    const z = (rng() * 2 - 1) * (HALF_MAP - 6)
    if (Math.hypot(x, z) < 10) continue
    const s = 1.5 + rng() * 2
    const h = 1.5 + rng() * 2
    list.push({ id: `box_${i}`, pos: { x, y: h / 2, z }, size: { x: s, y: h, z: s } })
  }
  list.push({ id: 'lw1', pos: { x: -20, y: 1, z: -15 }, size: { x: 10, y: 2, z: 1 } })
  list.push({ id: 'lw2', pos: { x: 20, y: 1, z: 15 }, size: { x: 10, y: 2, z: 1 } })
  list.push({ id: 'lw3', pos: { x: -20, y: 1, z: 20 }, size: { x: 1, y: 2, z: 10 } })
  list.push({ id: 'lw4', pos: { x: 25, y: 1, z: -20 }, size: { x: 1, y: 2, z: 10 } })
  return list
})()

// ============== Pickups ==============
// Spawn a fixed grid of pickups that respawn 12s after being taken.
const PICKUP_RESPAWN_MS = 12000
const pickups: Pickup[] = (() => {
  const list: Pickup[] = []
  // Manually placed health/ammo/weapon crates around the map.
  const placements: { kind: PickupKind; x: number; z: number }[] = [
    { kind: 'health', x: -25, z: -25 },
    { kind: 'health', x:  25, z:  25 },
    { kind: 'health', x:  25, z: -25 },
    { kind: 'health', x: -25, z:  25 },
    { kind: 'health', x:   0, z: -30 },
    { kind: 'health', x:   0, z:  30 },
    { kind: 'ammo',   x: -15, z:   0 },
    { kind: 'ammo',   x:  15, z:   0 },
    { kind: 'ammo',   x:   0, z: -15 },
    { kind: 'ammo',   x:   0, z:  15 },
    { kind: 'ammo',   x: -30, z:   0 },
    { kind: 'ammo',   x:  30, z:   0 },
    { kind: 'rifle',    x: -35, z: -35 },
    { kind: 'rifle',    x:  35, z:  35 },
    { kind: 'shotgun',  x:  35, z: -35 },
    { kind: 'shotgun',  x: -35, z:  35 },
    { kind: 'sniper',   x:   0, z: -38 },
    { kind: 'sniper',   x:   0, z:  38 },
  ]
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i]
    list.push({
      id: `pk_${i}_${p.kind}`,
      kind: p.kind,
      pos: { x: p.x, y: 0.6, z: p.z },
      taken: false,
      respawnAt: 0,
    })
  }
  return list
})()

// ============== Zone (battle-royale shrinking circle) ==============
// The zone is a circle on the XZ plane, defined by center + radius.
// It shrinks in phases: hold for N seconds, then shrink over M seconds to a
// new (smaller) radius centered on a random point inside the current circle.
interface ZoneState {
  centerX: number
  centerZ: number
  radius: number
  // next shrink target
  targetX: number
  targetZ: number
  targetRadius: number
  // timing
  phase: number            // 0..N
  phaseStartedAt: number
  shrinking: boolean
  shrinkEndsAt: number
}

const ZONE_INITIAL_RADIUS = HALF_MAP + 2
const ZONE_PHASES = [
  { holdMs: 15000, shrinkMs: 20000, radiusFactor: 0.65, dps: 1  },
  { holdMs: 15000, shrinkMs: 20000, radiusFactor: 0.50, dps: 2  },
  { holdMs: 12000, shrinkMs: 18000, radiusFactor: 0.40, dps: 4  },
  { holdMs: 12000, shrinkMs: 15000, radiusFactor: 0.30, dps: 6  },
  { holdMs: 10000, shrinkMs: 15000, radiusFactor: 0.20, dps: 8  },
  { holdMs: 10000, shrinkMs: 12000, radiusFactor: 0.10, dps: 12 },
  { holdMs:  8000, shrinkMs: 10000, radiusFactor: 0.05, dps: 18 },
]

let zone: ZoneState = {
  centerX: 0, centerZ: 0, radius: ZONE_INITIAL_RADIUS,
  targetX: 0, targetZ: 0, targetRadius: ZONE_INITIAL_RADIUS,
  phase: 0,
  phaseStartedAt: Date.now(),
  shrinking: false,
  shrinkEndsAt: 0,
}

function startZonePhase(p: number) {
  if (p >= ZONE_PHASES.length) {
    // Final state — zone holds at last target.
    zone.shrinking = false
    zone.radius = zone.targetRadius
    zone.centerX = zone.targetX
    zone.centerZ = zone.targetZ
    return
  }
  const def = ZONE_PHASES[p]
  // Pick a new center inside the current circle
  const angle = Math.random() * Math.PI * 2
  const maxOffset = Math.max(0, zone.radius - def.radiusFactor * zone.radius)
  const offset = Math.random() * maxOffset
  zone.targetX = zone.centerX + Math.cos(angle) * offset
  zone.targetZ = zone.centerZ + Math.sin(angle) * offset
  zone.targetRadius = zone.radius * def.radiusFactor
  zone.shrinking = false
  zone.phase = p
  zone.phaseStartedAt = Date.now()
}

function tickZone(now: number) {
  if (zone.phase >= ZONE_PHASES.length) return
  const def = ZONE_PHASES[zone.phase]
  if (!zone.shrinking) {
    // Holding — wait for holdMs, then start shrinking
    if (now - zone.phaseStartedAt >= def.holdMs) {
      zone.shrinking = true
      zone.shrinkEndsAt = now + def.shrinkMs
    }
  } else {
    // Shrinking — interpolate center & radius
    const total = def.shrinkMs
    const elapsed = now - (zone.shrinkEndsAt - total)
    const t = Math.min(1, Math.max(0, elapsed / total))
    const startR = zone.radius  // BAD: this is the live radius, not the start
    // We need a proper start snapshot. Track it:
    if (!(zone as any)._shrinkStart) {
      ;(zone as any)._shrinkStart = {
        x: zone.centerX, z: zone.centerZ, r: zone.radius,
      }
    }
    const start = (zone as any)._shrinkStart
    zone.centerX = start.x + (zone.targetX - start.x) * t
    zone.centerZ = start.z + (zone.targetZ - start.z) * t
    zone.radius = start.r + (zone.targetRadius - start.r) * t
    if (t >= 1) {
      ;(zone as any)._shrinkStart = null
      zone.radius = zone.targetRadius
      zone.centerX = zone.targetX
      zone.centerZ = zone.targetZ
      startZonePhase(zone.phase + 1)
    }
  }
}

// Damage players outside the zone each tick.
function applyZoneDamage(now: number) {
  if (zone.phase >= ZONE_PHASES.length) return
  const def = ZONE_PHASES[zone.phase]
  const dps = def.dps
  const dmgPerTick = dps * (TICK_MS / 1000)
  for (const p of players.values()) {
    if (!p.alive) continue
    const dx = p.pos.x - zone.centerX
    const dz = p.pos.z - zone.centerZ
    const dist = Math.hypot(dx, dz)
    if (dist > zone.radius) {
      p.hp -= dmgPerTick
      if (p.hp <= 0) {
        p.hp = 0
        p.alive = false
        p.deaths += 1
        p.respawnAt = now + RESPAWN_MS
        io.emit('system', {
          kind: 'kill',
          killer: 'Zone',
          killerId: 'zone',
          victim: p.name,
          victimId: p.id,
          ts: now,
        })
      }
    }
  }
}

// Initialize zone
startZonePhase(0)

// ============== Utility ==============
function mulberry32(seed: number) {
  let a = seed
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PALETTE = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
  '#14b8a6', '#f43f5e', '#84cc16', '#a855f7',
]
function pickColor(idx: number) {
  return PALETTE[idx % PALETTE.length]
}

function randomSpawn(): Vec3 {
  // Spawn near the map edge but INSIDE the current zone (so players don't die instantly).
  for (let attempt = 0; attempt < 20; attempt++) {
    const angle = Math.random() * Math.PI * 2
    const radius = 8 + Math.random() * Math.max(8, zone.radius - 12)
    const x = zone.centerX + Math.cos(angle) * radius
    const z = zone.centerZ + Math.sin(angle) * radius
    if (Math.hypot(x, z) > HALF_MAP - 2) continue
    // Also avoid spawning on top of an obstacle
    let blocked = false
    for (const o of obstacles) {
      const hx = o.size.x / 2 + PLAYER_RADIUS
      const hz = o.size.z / 2 + PLAYER_RADIUS
      if (Math.abs(x - o.pos.x) < hx && Math.abs(z - o.pos.z) < hz) {
        blocked = true
        break
      }
    }
    if (!blocked) return { x, y: 0, z }
  }
  return { x: zone.centerX, y: 0, z: zone.centerZ }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

function resolveCollisions(pos: Vec3) {
  for (const o of obstacles) {
    const half = { x: o.size.x / 2, y: o.size.y / 2, z: o.size.z / 2 }
    const minX = o.pos.x - half.x - PLAYER_RADIUS
    const maxX = o.pos.x + half.x + PLAYER_RADIUS
    const minZ = o.pos.z - half.z - PLAYER_RADIUS
    const maxZ = o.pos.z + half.z + PLAYER_RADIUS
    if (pos.x > minX && pos.x < maxX && pos.z > minZ && pos.z < maxZ) {
      const dxLeft = pos.x - minX
      const dxRight = maxX - pos.x
      const dzTop = pos.z - minZ
      const dzBot = maxZ - pos.z
      const m = Math.min(dxLeft, dxRight, dzTop, dzBot)
      if (m === dxLeft) pos.x = minX
      else if (m === dxRight) pos.x = maxX
      else if (m === dzTop) pos.z = minZ
      else pos.z = maxZ
    }
  }
  pos.x = clamp(pos.x, -HALF_MAP + PLAYER_RADIUS, HALF_MAP - PLAYER_RADIUS)
  pos.z = clamp(pos.z, -HALF_MAP + PLAYER_RADIUS, HALF_MAP - PLAYER_RADIUS)
}

// Raycast vs AABB (slab method).
function rayVsAABB(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  ob: Obstacle,
): number | null {
  const hx = ob.size.x / 2, hy = ob.size.y / 2, hz = ob.size.z / 2
  const minX = ob.pos.x - hx, maxX = ob.pos.x + hx
  const minY = ob.pos.y - hy, maxY = ob.pos.y + hy
  const minZ = ob.pos.z - hz, maxZ = ob.pos.z + hz

  let tmin = -Infinity, tmax = Infinity

  if (Math.abs(dx) < 1e-8) {
    if (ox < minX || ox > maxX) return null
  } else {
    let t1 = (minX - ox) / dx
    let t2 = (maxX - ox) / dx
    if (t1 > t2) [t1, t2] = [t2, t1]
    tmin = Math.max(tmin, t1)
    tmax = Math.min(tmax, t2)
    if (tmin > tmax) return null
  }
  if (Math.abs(dy) < 1e-8) {
    if (oy < minY || oy > maxY) return null
  } else {
    let t1 = (minY - oy) / dy
    let t2 = (maxY - oy) / dy
    if (t1 > t2) [t1, t2] = [t2, t1]
    tmin = Math.max(tmin, t1)
    tmax = Math.min(tmax, t2)
    if (tmin > tmax) return null
  }
  if (Math.abs(dz) < 1e-8) {
    if (oz < minZ || oz > maxZ) return null
  } else {
    let t1 = (minZ - oz) / dz
    let t2 = (maxZ - oz) / dz
    if (t1 > t2) [t1, t2] = [t2, t1]
    tmin = Math.max(tmin, t1)
    tmax = Math.min(tmax, t2)
    if (tmin > tmax) return null
  }
  if (tmax < 0) return null
  return tmin < 0 ? 0 : tmin
}

function rayVsPlayer(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  p: Player,
): number | null {
  const px = p.pos.x - ox
  const pz = p.pos.z - oz
  const A = dx * dx + dz * dz
  if (A < 1e-8) return null
  const B = -2 * (dx * px + dz * pz)
  const C = px * px + pz * pz - PLAYER_RADIUS * PLAYER_RADIUS
  const disc = B * B - 4 * A * C
  if (disc < 0) return null
  const sq = Math.sqrt(disc)
  const t1 = (-B - sq) / (2 * A)
  const t2 = (-B + sq) / (2 * A)
  for (const t of [t1, t2]) {
    if (t < 0) continue
    const hy = oy + t * dy
    if (hy >= 0 && hy <= 1.8) return t
  }
  return null
}

// ============== Persistent leaderboard (in-process, file-backed) ==============
// We avoid pulling Prisma into the bun mini-service to keep it dependency-free.
// Instead we keep a simple JSON file at /tmp/game-server-leaderboard.json.
// The Next.js app reads the same file via an API route.
import { readFileSync, writeFileSync, existsSync } from 'fs'

const LB_FILE = process.env.LEADERBOARD_FILE || '/tmp/game-server-leaderboard.json'
interface LBEntry {
  name: string
  kills: number
  deaths: number
  bestStreak: number
  updatedAt: number
}
let leaderboard: Map<string, LBEntry> = new Map()

function loadLeaderboard() {
  try {
    if (existsSync(LB_FILE)) {
      const raw = readFileSync(LB_FILE, 'utf-8')
      const obj = JSON.parse(raw) as Record<string, LBEntry>
      leaderboard = new Map(Object.entries(obj))
    }
  } catch (e) {
    console.warn('[leaderboard] failed to load:', e)
  }
}
function saveLeaderboard() {
  try {
    const obj: Record<string, LBEntry> = {}
    for (const [k, v] of leaderboard) obj[k] = v
    writeFileSync(LB_FILE, JSON.stringify(obj, null, 2))
  } catch (e) {
    console.warn('[leaderboard] failed to save:', e)
  }
}
loadLeaderboard()

function recordLeaderboardStats(p: Player) {
  const key = p.name.toLowerCase()
  const existing = leaderboard.get(key)
  if (!existing) {
    leaderboard.set(key, {
      name: p.name,
      kills: p.kills,
      deaths: p.deaths,
      bestStreak: p.kills, // crude: current kills == streak since session start
      updatedAt: Date.now(),
    })
  } else {
    existing.kills = Math.max(existing.kills, p.kills)
    existing.deaths = Math.max(existing.deaths, p.deaths)
    existing.bestStreak = Math.max(existing.bestStreak, p.kills)
    existing.name = p.name
    existing.updatedAt = Date.now()
  }
  saveLeaderboard()
}

// Periodic save (every 30s) in case of crash
setInterval(saveLeaderboard, 30000)

// ============== Snapshot helpers ==============
function snapshot() {
  return Array.from(players.values()).map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    pos: p.pos,
    rot: p.rot,
    hp: p.hp,
    alive: p.alive,
    kills: p.kills,
    deaths: p.deaths,
    respawnAt: p.respawnAt,
    connected: p.connected,
    currentWeapon: p.currentWeapon,
    ammo: p.ammo,
    unlocked: p.unlocked,
  }))
}

function pickupsSnapshot() {
  return pickups.map((p) => ({
    id: p.id, kind: p.kind, pos: p.pos, taken: p.taken, respawnAt: p.respawnAt,
  }))
}

function zoneSnapshot() {
  return {
    centerX: zone.centerX,
    centerZ: zone.centerZ,
    radius: zone.radius,
    targetX: zone.targetX,
    targetZ: zone.targetZ,
    targetRadius: zone.targetRadius,
    phase: zone.phase,
    phaseStartedAt: zone.phaseStartedAt,
    shrinking: zone.shrinking,
    shrinkEndsAt: zone.shrinkEndsAt,
    phaseCount: ZONE_PHASES.length,
    nextDps: zone.phase < ZONE_PHASES.length ? ZONE_PHASES[zone.phase].dps : 0,
  }
}

// ============== Default loadout for new player ==============
function freshLoadout() {
  const ammo: Record<WeaponId, number> = { pistol: 999, rifle: 0, shotgun: 0, sniper: 0 }
  const unlocked: Record<WeaponId, boolean> = { pistol: true, rifle: false, shotgun: false, sniper: false }
  return { ammo, unlocked }
}

function fullLoadout() {
  const ammo: Record<WeaponId, number> = { pistol: 999, rifle: 30, shotgun: 6, sniper: 5 }
  const unlocked: Record<WeaponId, boolean> = { pistol: true, rifle: true, shotgun: true, sniper: true }
  return { ammo, unlocked }
}

// ============== Connection handling ==============
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`)

  socket.on('join', (data: { name: string }) => {
    const name = (data?.name || 'Player').toString().slice(0, 16) || 'Player'
    const spawn = randomSpawn()
    const loadout = freshLoadout()
    const player: Player = {
      id: socket.id,
      name,
      color: pickColor(players.size),
      pos: spawn,
      rot: 0,
      hp: MAX_HP,
      alive: true,
      kills: 0,
      deaths: 0,
      lastShotAt: 0,
      respawnAt: null,
      connected: true,
      currentWeapon: 'pistol',
      ammo: loadout.ammo,
      unlocked: loadout.unlocked,
    }
    players.set(socket.id, player)
    console.log(`[join] ${name} (${socket.id}) — ${players.size} player(s) online`)

    socket.emit('welcome', {
      selfId: socket.id,
      player,
      map: { size: MAP_SIZE, obstacles },
      pickups: pickupsSnapshot(),
      zone: zoneSnapshot(),
      weapons: WEAPONS,
      constants: {
        MAP_SIZE, PLAYER_SPEED, MAX_HP, RESPAWN_MS,
        TICK_RATE_HZ, PICKUP_RESPAWN_MS,
      },
    })
    io.emit('players-batch', snapshot())
    io.emit('pickups-batch', pickupsSnapshot())
    io.emit('zone', zoneSnapshot())
    io.emit('system', { kind: 'join', name, ts: Date.now() })
  })

  socket.on('move', (data: { pos: Vec3; rot: number }) => {
    const p = players.get(socket.id)
    if (!p || !p.alive) return
    const dx = data.pos.x - p.pos.x
    const dz = data.pos.z - p.pos.z
    const dist = Math.hypot(dx, dz)
    if (dist > 6) return
    p.pos.x = data.pos.x
    p.pos.z = data.pos.z
    p.pos.y = 0
    p.rot = data.rot
    resolveCollisions(p.pos)
  })

  socket.on('switchWeapon', (data: { weapon: WeaponId }) => {
    const p = players.get(socket.id)
    if (!p) return
    if (!p.unlocked[data.weapon]) return
    p.currentWeapon = data.weapon
  })

  socket.on('shoot', (data: { dir: Vec3; origin: Vec3 }) => {
    const p = players.get(socket.id)
    if (!p || !p.alive) return
    const weapon = WEAPONS[p.currentWeapon]
    const now = Date.now()
    if (now - p.lastShotAt < weapon.cooldown) return
    // Ammo check (pistol has infinite reserve)
    if (p.currentWeapon !== 'pistol' && p.ammo[p.currentWeapon] <= 0) return
    p.lastShotAt = now
    if (p.currentWeapon !== 'pistol') {
      p.ammo[p.currentWeapon] -= 1
    }

    const ox = data.origin.x
    const oy = data.origin.y
    const oz = data.origin.z

    // For each pellet, ray-cast and broadcast a tracer.
    const tracers: { end: Vec3; hitPlayerId: string | null }[] = []
    const hitSet = new Map<string, number>() // victimId -> total damage this shot

    for (let pellet = 0; pellet < weapon.pellets; pellet++) {
      // Add random spread
      const spreadX = (Math.random() - 0.5) * weapon.spread
      const spreadY = (Math.random() - 0.5) * weapon.spread * 0.5
      const spreadZ = (Math.random() - 0.5) * weapon.spread
      const dlen = Math.hypot(data.dir.x, data.dir.y, data.dir.z) || 1
      const dx = data.dir.x / dlen + spreadX
      const dy = data.dir.y / dlen + spreadY
      const dz = data.dir.z / dlen + spreadZ
      // Re-normalize
      const dlen2 = Math.hypot(dx, dy, dz) || 1
      const ndx = dx / dlen2
      const ndy = dy / dlen2
      const ndz = dz / dlen2

      let closestT = weapon.range
      let hitPlayerId: string | null = null

      for (const o of obstacles) {
        const t = rayVsAABB(ox, oy, oz, ndx, ndy, ndz, o)
        if (t !== null && t < closestT) {
          closestT = t
          hitPlayerId = null
        }
      }
      for (const [pid, other] of players) {
        if (pid === socket.id || !other.alive || !other.connected) continue
        const t = rayVsPlayer(ox, oy, oz, ndx, ndy, ndz, other)
        if (t !== null && t < closestT) {
          closestT = t
          hitPlayerId = pid
        }
      }
      const end = {
        x: ox + ndx * closestT,
        y: oy + ndy * closestT,
        z: oz + ndz * closestT,
      }
      tracers.push({ end, hitPlayerId })
      if (hitPlayerId) {
        hitSet.set(hitPlayerId, (hitSet.get(hitPlayerId) || 0) + weapon.damage)
      }
    }

    // Apply damage to each hit victim exactly once (sum of pellet damages).
    for (const [victimId, totalDmg] of hitSet) {
      const victim = players.get(victimId)
      if (!victim || !victim.alive) continue
      victim.hp -= totalDmg
      if (victim.hp <= 0) {
        victim.hp = 0
        victim.alive = false
        victim.deaths += 1
        victim.respawnAt = Date.now() + RESPAWN_MS
        p.kills += 1
        io.emit('system', {
          kind: 'kill',
          killer: p.name,
          killerId: p.id,
          victim: victim.name,
          victimId: victim.id,
          ts: Date.now(),
        })
        recordLeaderboardStats(p)
        recordLeaderboardStats(victim)
      } else {
        io.emit('system', {
          kind: 'hit',
          attacker: p.name,
          attackerId: p.id,
          victim: victim.name,
          victimId: victim.id,
          damage: totalDmg,
          ts: Date.now(),
        })
      }
      io.to(victimId).emit('damaged', {
        from: p.id,
        damage: totalDmg,
        hp: victim.hp,
      })
    }

    // Broadcast shot event with all tracers
    io.emit('shot', {
      shooterId: socket.id,
      weapon: p.currentWeapon,
      origin: { x: ox, y: oy, z: oz },
      tracers,
      ts: now,
    })
  })

  socket.on('disconnect', () => {
    const p = players.get(socket.id)
    if (p) {
      p.connected = false
      io.emit('system', { kind: 'leave', name: p.name, ts: Date.now() })
      recordLeaderboardStats(p)
      players.delete(socket.id)
      io.emit('players-batch', snapshot())
      console.log(`[disconnect] ${p.name}`)
    } else {
      console.log(`[disconnect] ${socket.id} (no join)`)
    }
  })

  socket.on('error', (err) => {
    console.error(`[error] ${socket.id}:`, err)
  })
})

// ============== Pickups pickup (collision-based, server-side) ==============
function tickPickups(now: number) {
  let dirty = false
  for (const pk of pickups) {
    if (pk.taken && now >= pk.respawnAt) {
      pk.taken = false
      pk.respawnAt = 0
      dirty = true
    }
    if (pk.taken) continue
    for (const p of players.values()) {
      if (!p.alive) continue
      const dx = p.pos.x - pk.pos.x
      const dz = p.pos.z - pk.pos.z
      if (Math.hypot(dx, dz) > 1.2) continue
      // Pick up
      let pickedUp = false
      if (pk.kind === 'health') {
        if (p.hp < MAX_HP) {
          p.hp = Math.min(MAX_HP, p.hp + 50)
          pickedUp = true
        }
      } else if (pk.kind === 'ammo') {
        // Refill current weapon's ammo to its pickup amount
        for (const wid of WEAPON_IDS) {
          if (p.unlocked[wid] && wid !== 'pistol') {
            p.ammo[wid] = Math.max(p.ammo[wid], WEAPONS[wid].ammoPerPickup)
          }
        }
        pickedUp = true
      } else if (pk.kind === 'rifle' || pk.kind === 'shotgun' || pk.kind === 'sniper') {
        const wid: WeaponId = pk.kind
        if (!p.unlocked[wid]) {
          p.unlocked[wid] = true
          p.ammo[wid] = WEAPONS[wid].ammoPerPickup
          p.currentWeapon = wid
          pickedUp = true
        } else {
          // Already has it — top up ammo
          if (p.ammo[wid] < WEAPONS[wid].ammoPerPickup * 2) {
            p.ammo[wid] = Math.min(WEAPONS[wid].ammoPerPickup * 2, p.ammo[wid] + WEAPONS[wid].ammoPerPickup)
            pickedUp = true
          }
        }
      }
      if (pickedUp) {
        pk.taken = true
        pk.respawnAt = now + PICKUP_RESPAWN_MS
        dirty = true
        io.to(p.id).emit('pickup', { kind: pk.kind, weapon: pk.kind })
        break
      }
    }
  }
  if (dirty) io.emit('pickups-batch', pickupsSnapshot())
}

// ============== Game loop ==============
setInterval(() => {
  const now = Date.now()
  // Respawn dead players
  for (const p of players.values()) {
    if (!p.alive && p.respawnAt && now >= p.respawnAt) {
      const spawn = randomSpawn()
      p.pos = spawn
      p.hp = MAX_HP
      p.alive = true
      p.respawnAt = null
      // Reset to fresh loadout on respawn (lose picked-up weapons)
      const f = freshLoadout()
      p.ammo = f.ammo
      p.unlocked = f.unlocked
      p.currentWeapon = 'pistol'
      io.to(p.id).emit('respawn', { pos: spawn })
    }
  }
  // Zone
  tickZone(now)
  applyZoneDamage(now)
  // Pickups
  tickPickups(now)
  // Broadcast snapshot
  io.emit('tick', snapshot())
  io.emit('zone', zoneSnapshot())
}, TICK_MS)

// Periodic leaderboard broadcast
setInterval(() => {
  io.emit('leaderboard', {
    entries: Array.from(leaderboard.values())
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
      .slice(0, 20),
  })
}, 5000)

const PORT = 3003
httpServer.listen(PORT, '::', () => {
  console.log(`Game server (socket.io) listening on [::]:${PORT} (dual-stack)`)
  console.log(`Leaderboard file: ${LB_FILE}`)
})

process.on('SIGTERM', () => httpServer.close(() => process.exit(0)))
process.on('SIGINT', () => httpServer.close(() => process.exit(0)))
