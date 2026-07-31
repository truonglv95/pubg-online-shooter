// Shared types between client & server (kept in sync manually).

export type Vec3 = { x: number; y: number; z: number }

export type WeaponId = 'pistol' | 'rifle' | 'shotgun' | 'sniper'

export interface WeaponDef {
  id: WeaponId
  name: string
  damage: number
  cooldown: number
  range: number
  pellets: number
  spread: number
  ammoPerPickup: number
  bulletColor: number
  fireMode: 'semi' | 'auto'
}

export type Weapons = Record<WeaponId, WeaponDef>

export interface Obstacle {
  id: string
  pos: Vec3
  size: Vec3
}

export type PickupKind = 'health' | 'ammo' | 'rifle' | 'shotgun' | 'sniper'

export interface PickupSnapshot {
  id: string
  kind: PickupKind
  pos: Vec3
  taken: boolean
  respawnAt: number
}

export interface ZoneSnapshot {
  centerX: number
  centerZ: number
  radius: number
  targetX: number
  targetZ: number
  targetRadius: number
  phase: number
  phaseStartedAt: number
  shrinking: boolean
  shrinkEndsAt: number
  phaseCount: number
  nextDps: number
}

export interface PlayerSnapshot {
  id: string
  name: string
  color: string
  pos: Vec3
  rot: number
  hp: number
  alive: boolean
  kills: number
  deaths: number
  respawnAt: number | null
  connected: boolean
  currentWeapon: WeaponId
  ammo: Record<WeaponId, number>
  unlocked: Record<WeaponId, boolean>
}

export interface WelcomePayload {
  selfId: string
  player: PlayerSnapshot
  map: { size: number; obstacles: Obstacle[] }
  pickups: PickupSnapshot[]
  zone: ZoneSnapshot
  weapons: Weapons
  constants: {
    MAP_SIZE: number
    PLAYER_SPEED: number
    MAX_HP: number
    RESPAWN_MS: number
    TICK_RATE_HZ: number
    PICKUP_RESPAWN_MS: number
  }
}

export interface ShotTracer {
  end: Vec3
  hitPlayerId: string | null
}

export interface ShotPayload {
  shooterId: string
  weapon: WeaponId
  origin: Vec3
  tracers: ShotTracer[]
  ts: number
}

export interface SystemMessage {
  kind: 'join' | 'leave' | 'kill' | 'hit'
  name?: string
  killer?: string
  killerId?: string
  victim?: string
  victimId?: string
  attacker?: string
  attackerId?: string
  damage?: number
  ts: number
}

export interface DamagedPayload {
  from: string
  damage: number
  hp: number
}

export interface RespawnPayload {
  pos: Vec3
}

export interface PickupEvent {
  kind: PickupKind
  weapon: WeaponId
}

export interface LeaderboardEntry {
  name: string
  kills: number
  deaths: number
  bestStreak: number
  updatedAt: number
}

export interface LeaderboardPayload {
  entries: LeaderboardEntry[]
}
