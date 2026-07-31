// Shared types between client & server (kept in sync manually).

export type Vec3 = { x: number; y: number; z: number }

export interface Obstacle {
  id: string
  pos: Vec3
  size: Vec3
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
}

export interface WelcomePayload {
  selfId: string
  player: PlayerSnapshot
  map: { size: number; obstacles: Obstacle[] }
  constants: {
    MAP_SIZE: number
    PLAYER_SPEED: number
    MAX_HP: number
    RESPAWN_MS: number
    BULLET_DAMAGE: number
  }
}

export interface ShotPayload {
  shooterId: string
  origin: Vec3
  end: Vec3
  hitPlayerId: string | null
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
