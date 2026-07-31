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
const SHOOT_COOLDOWN_MS = 180  // rifle cooldown
const BULLET_DAMAGE = 18
const BULLET_RANGE = 100
const TICK_RATE_HZ = 30
const TICK_MS = 1000 / TICK_RATE_HZ

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
}

interface Obstacle {
  id: string
  pos: Vec3
  size: Vec3
}

// ============== World setup ==============
const players = new Map<string, Player>()

// Build a static set of obstacles (boxes) on the map.
const obstacles: Obstacle[] = (() => {
  const list: Obstacle[] = []
  // Outer walls
  const wallThick = 2
  const wallH = 4
  list.push({ id: 'w_n', pos: { x: 0, y: wallH / 2, z: -HALF_MAP - wallThick / 2 }, size: { x: MAP_SIZE + wallThick * 2, y: wallH, z: wallThick } })
  list.push({ id: 'w_s', pos: { x: 0, y: wallH / 2, z: HALF_MAP + wallThick / 2 }, size: { x: MAP_SIZE + wallThick * 2, y: wallH, z: wallThick } })
  list.push({ id: 'w_e', pos: { x: HALF_MAP + wallThick / 2, y: wallH / 2, z: 0 }, size: { x: wallThick, y: wallH, z: MAP_SIZE + wallThick * 2 } })
  list.push({ id: 'w_w', pos: { x: -HALF_MAP - wallThick / 2, y: wallH / 2, z: 0 }, size: { x: wallThick, y: wallH, z: MAP_SIZE + wallThick * 2 } })

  // Central building
  list.push({ id: 'c1', pos: { x: 0, y: 1.5, z: 0 }, size: { x: 8, y: 3, z: 8 } })
  list.push({ id: 'c2', pos: { x: 0, y: 3.5, z: 0 }, size: { x: 4, y: 1, z: 4 } })

  // Scattered crates (procedural but deterministic)
  const rng = mulberry32(1337)
  for (let i = 0; i < 28; i++) {
    const x = (rng() * 2 - 1) * (HALF_MAP - 6)
    const z = (rng() * 2 - 1) * (HALF_MAP - 6)
    if (Math.hypot(x, z) < 10) continue // keep central area clear
    const s = 1.5 + rng() * 2
    const h = 1.5 + rng() * 2
    list.push({ id: `box_${i}`, pos: { x, y: h / 2, z }, size: { x: s, y: h, z: s } })
  }
  // A few long cover walls
  list.push({ id: 'lw1', pos: { x: -20, y: 1, z: -15 }, size: { x: 10, y: 2, z: 1 } })
  list.push({ id: 'lw2', pos: { x: 20, y: 1, z: 15 }, size: { x: 10, y: 2, z: 1 } })
  list.push({ id: 'lw3', pos: { x: -20, y: 1, z: 20 }, size: { x: 1, y: 2, z: 10 } })
  list.push({ id: 'lw4', pos: { x: 25, y: 1, z: -20 }, size: { x: 1, y: 2, z: 10 } })
  return list
})()

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
  // Spawn near the map edge, away from center
  const rng = Math.random
  const angle = rng() * Math.PI * 2
  const radius = 20 + rng() * (HALF_MAP - 24)
  return {
    x: Math.cos(angle) * radius,
    y: 0,
    z: Math.sin(angle) * radius,
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

// Resolve circle-vs-AABB collisions for one player against all obstacles.
function resolveCollisions(pos: Vec3) {
  for (const o of obstacles) {
    const half = { x: o.size.x / 2, y: o.size.y / 2, z: o.size.z / 2 }
    // Expand AABB by player radius
    const minX = o.pos.x - half.x - PLAYER_RADIUS
    const maxX = o.pos.x + half.x + PLAYER_RADIUS
    const minZ = o.pos.z - half.z - PLAYER_RADIUS
    const maxZ = o.pos.z + half.z + PLAYER_RADIUS
    if (pos.x > minX && pos.x < maxX && pos.z > minZ && pos.z < maxZ) {
      // Find the smallest push-out direction
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
  // Keep inside map bounds
  pos.x = clamp(pos.x, -HALF_MAP + PLAYER_RADIUS, HALF_MAP - PLAYER_RADIUS)
  pos.z = clamp(pos.z, -HALF_MAP + PLAYER_RADIUS, HALF_MAP - PLAYER_RADIUS)
}

// Raycast vs AABB (slab method). Returns distance if hit, else null.
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

  // X slab
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
  // Y slab
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
  // Z slab
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

// Raycast vs player (treat as vertical capsule => cylinder along Y)
function rayVsPlayer(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  p: Player,
): number | null {
  // Player capsule: x,z within PLAYER_RADIUS of p.pos; y in [0, 1.8]
  // Solve 2D circle intersection in XZ, then check Y range.
  const px = p.pos.x - ox
  const pz = p.pos.z - oz
  // Quadratic in t for (ox + t*dx - p.pos.x)^2 + (oz + t*dz - p.pos.z)^2 = r^2
  // => (dx^2 + dz^2) t^2 - 2 (dx*px + dz*pz) t + (px^2 + pz^2 - r^2) = 0
  const A = dx * dx + dz * dz
  if (A < 1e-8) return null
  const B = -2 * (dx * px + dz * pz)
  const C = px * px + pz * pz - PLAYER_RADIUS * PLAYER_RADIUS
  const disc = B * B - 4 * A * C
  if (disc < 0) return null
  const sq = Math.sqrt(disc)
  const t1 = (-B - sq) / (2 * A)
  const t2 = (-B + sq) / (2 * A)
  // Check Y range at hit
  for (const t of [t1, t2]) {
    if (t < 0) continue
    const hy = oy + t * dy
    if (hy >= 0 && hy <= 1.8) return t
  }
  return null
}

// ============== Connection handling ==============
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`)

  socket.on('join', (data: { name: string }) => {
    const name = (data?.name || 'Player').toString().slice(0, 16) || 'Player'
    const spawn = randomSpawn()
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
    }
    players.set(socket.id, player)
    console.log(`[join] ${name} (${socket.id}) — ${players.size} player(s) online`)

    socket.emit('welcome', {
      selfId: socket.id,
      player,
      map: { size: MAP_SIZE, obstacles },
      constants: {
        MAP_SIZE, PLAYER_SPEED, MAX_HP, RESPAWN_MS, BULLET_DAMAGE,
      },
    })
    io.emit('players-batch', snapshot())
    io.emit('system', { kind: 'join', name, ts: Date.now() })
  })

  // Movement: client sends desired position delta. Server validates & broadcasts.
  socket.on('move', (data: { pos: Vec3; rot: number }) => {
    const p = players.get(socket.id)
    if (!p || !p.alive) return
    // Anti-cheat: clamp distance moved per packet
    const dx = data.pos.x - p.pos.x
    const dz = data.pos.z - p.pos.z
    const dist = Math.hypot(dx, dz)
    if (dist > 6) {
      // too far in one tick - reject
      return
    }
    p.pos.x = data.pos.x
    p.pos.z = data.pos.z
    p.pos.y = 0
    p.rot = data.rot
    resolveCollisions(p.pos)
  })

  // Shoot: client sends shoot direction. Server computes hits.
  socket.on('shoot', (data: { dir: Vec3; origin: Vec3 }) => {
    const p = players.get(socket.id)
    if (!p || !p.alive) return
    const now = Date.now()
    if (now - p.lastShotAt < SHOOT_COOLDOWN_MS) return
    p.lastShotAt = now

    // Normalise direction
    const dlen = Math.hypot(data.dir.x, data.dir.y, data.dir.z) || 1
    const dx = data.dir.x / dlen
    const dy = data.dir.y / dlen
    const dz = data.dir.z / dlen
    const ox = data.origin.x
    const oy = data.origin.y
    const oz = data.origin.z

    // Find closest hit (obstacle or player)
    let closestT = BULLET_RANGE
    let hitPlayerId: string | null = null

    // Obstacles
    for (const o of obstacles) {
      const t = rayVsAABB(ox, oy, oz, dx, dy, dz, o)
      if (t !== null && t < closestT) {
        closestT = t
        hitPlayerId = null
      }
    }
    // Players (skip self & dead)
    for (const [pid, other] of players) {
      if (pid === socket.id || !other.alive || !other.connected) continue
      const t = rayVsPlayer(ox, oy, oz, dx, dy, dz, other)
      if (t !== null && t < closestT) {
        closestT = t
        hitPlayerId = pid
      }
    }

    const endPoint = {
      x: ox + dx * closestT,
      y: oy + dy * closestT,
      z: oz + dz * closestT,
    }

    if (hitPlayerId) {
      const victim = players.get(hitPlayerId)!
      victim.hp -= BULLET_DAMAGE
      let killed = false
      if (victim.hp <= 0) {
        victim.hp = 0
        victim.alive = false
        victim.deaths += 1
        victim.respawnAt = Date.now() + RESPAWN_MS
        p.kills += 1
        killed = true
        io.emit('system', {
          kind: 'kill',
          killer: p.name,
          killerId: p.id,
          victim: victim.name,
          victimId: victim.id,
          ts: Date.now(),
        })
      } else {
        io.emit('system', {
          kind: 'hit',
          attacker: p.name,
          attackerId: p.id,
          victim: victim.name,
          victimId: victim.id,
          damage: BULLET_DAMAGE,
          ts: Date.now(),
        })
      }
      io.to(hitPlayerId).emit('damaged', {
        from: p.id,
        damage: BULLET_DAMAGE,
        hp: victim.hp,
      })
    }

    // Broadcast tracer to everyone (incl. shooter) for visual feedback
    io.emit('shot', {
      shooterId: socket.id,
      origin: { x: ox, y: oy, z: oz },
      end: endPoint,
      hitPlayerId,
      ts: now,
    })
  })

  socket.on('disconnect', () => {
    const p = players.get(socket.id)
    if (p) {
      p.connected = false
      io.emit('system', { kind: 'leave', name: p.name, ts: Date.now() })
      // Give a short grace before removing from leaderboard, but remove from active play now
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
  }))
}

// ============== Game loop ==============
// 1. Respawn dead players whose timer elapsed.
// 2. Broadcast a lightweight snapshot to everyone.
setInterval(() => {
  const now = Date.now()
  let dirty = false
  for (const p of players.values()) {
    if (!p.alive && p.respawnAt && now >= p.respawnAt) {
      const spawn = randomSpawn()
      p.pos = spawn
      p.hp = MAX_HP
      p.alive = true
      p.respawnAt = null
      dirty = true
      io.to(p.id).emit('respawn', { pos: spawn })
    }
  }
  io.emit('tick', snapshot())
}, TICK_MS)

const PORT = 3003
// Bind to '::' so the server accepts both IPv6 (::1) and IPv4 (127.0.0.1)
// connections. Caddy resolves 'localhost' to ::1 first on this host, so an
// IPv4-only bind produces 502 Bad Gateway errors.
httpServer.listen(PORT, '::', () => {
  console.log(`Game server (socket.io) listening on [::]:${PORT} (dual-stack)`)
})

process.on('SIGTERM', () => httpServer.close(() => process.exit(0)))
process.on('SIGINT', () => httpServer.close(() => process.exit(0)))
