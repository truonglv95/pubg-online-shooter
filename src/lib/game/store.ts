'use client'

import { create } from 'zustand'
import type {
  PlayerSnapshot,
  WelcomePayload,
  ShotPayload,
  SystemMessage,
  DamagedPayload,
  RespawnPayload,
  PickupSnapshot,
  ZoneSnapshot,
  PickupEvent,
  LeaderboardPayload,
  LeaderboardEntry,
  WeaponId,
  Weapons,
} from './types'

interface KillFeedEntry {
  id: string
  text: string
  ts: number
  kind: 'kill' | 'join' | 'leave'
}

interface GameState {
  // connection
  connected: boolean
  joined: boolean
  selfId: string | null
  // world
  constants: WelcomePayload['constants'] | null
  weapons: Weapons | null
  mapSize: number
  players: Record<string, PlayerSnapshot>
  pickups: PickupSnapshot[]
  zone: ZoneSnapshot | null
  // hud
  hp: number
  alive: boolean
  kills: number
  deaths: number
  respawnAt: number | null
  lastDamageFrom: string | null
  lastDamageAt: number
  currentWeapon: WeaponId
  ammo: Record<WeaponId, number>
  unlocked: Record<WeaponId, boolean>
  // feeds
  killFeed: KillFeedEntry[]
  // persistent leaderboard
  globalLeaderboard: LeaderboardEntry[]
  // settings
  playerName: string

  setConnected: (v: boolean) => void
  setPlayerName: (v: string) => void
  onWelcome: (p: WelcomePayload) => void
  onTick: (list: PlayerSnapshot[]) => void
  onPlayersBatch: (list: PlayerSnapshot[]) => void
  onPickupsBatch: (list: PickupSnapshot[]) => void
  onZone: (z: ZoneSnapshot) => void
  onShot: (s: ShotPayload) => void
  onSystem: (s: SystemMessage) => void
  onDamaged: (d: DamagedPayload) => void
  onRespawn: (r: RespawnPayload) => void
  onPickup: (p: PickupEvent) => void
  onLeaderboard: (l: LeaderboardPayload) => void
  reset: () => void
}

// Shot subscribers (consumed by the Three.js canvas for tracer visuals).
const shotSubscribers = new Set<(s: ShotPayload) => void>()
export function subscribeShots(cb: (s: ShotPayload) => void) {
  shotSubscribers.add(cb)
  return () => shotSubscribers.delete(cb)
}

// Pickup subscribers (consumed by the sound manager).
const pickupSubscribers = new Set<(p: PickupEvent) => void>()
export function subscribePickups(cb: (p: PickupEvent) => void) {
  pickupSubscribers.add(cb)
  return () => pickupSubscribers.delete(cb)
}

const KILL_FEED_MAX = 8

const DEFAULT_AMMO: Record<WeaponId, number> = { pistol: 999, rifle: 0, shotgun: 0, sniper: 0 }
const DEFAULT_UNLOCKED: Record<WeaponId, boolean> = { pistol: true, rifle: false, shotgun: false, sniper: false }

export const useGameStore = create<GameState>((set, get) => ({
  connected: false,
  joined: false,
  selfId: null,
  constants: null,
  weapons: null,
  mapSize: 80,
  players: {},
  pickups: [],
  zone: null,
  hp: 100,
  alive: true,
  kills: 0,
  deaths: 0,
  respawnAt: null,
  lastDamageFrom: null,
  lastDamageAt: 0,
  currentWeapon: 'pistol',
  ammo: { ...DEFAULT_AMMO },
  unlocked: { ...DEFAULT_UNLOCKED },
  killFeed: [],
  globalLeaderboard: [],
  playerName: '',

  setConnected: (v) => set({ connected: v }),
  setPlayerName: (v) => set({ playerName: v }),

  onWelcome: (p) =>
    set({
      selfId: p.selfId,
      joined: true,
      constants: p.constants,
      weapons: p.weapons,
      mapSize: p.map.size,
      players: { [p.selfId]: p.player },
      pickups: p.pickups,
      zone: p.zone,
      hp: p.player.hp,
      alive: p.player.alive,
      kills: p.player.kills,
      deaths: p.player.deaths,
      respawnAt: p.player.respawnAt,
      currentWeapon: p.player.currentWeapon,
      ammo: { ...p.player.ammo },
      unlocked: { ...p.player.unlocked },
    }),

  onTick: (list) => {
    const next: Record<string, PlayerSnapshot> = {}
    for (const p of list) next[p.id] = p
    const selfId = get().selfId
    const me = selfId ? next[selfId] : undefined
    set((s) => ({
      players: next,
      hp: me ? me.hp : s.hp,
      alive: me ? me.alive : s.alive,
      kills: me ? me.kills : s.kills,
      deaths: me ? me.deaths : s.deaths,
      respawnAt: me ? me.respawnAt : s.respawnAt,
      currentWeapon: me ? me.currentWeapon : s.currentWeapon,
      ammo: me ? { ...me.ammo } : s.ammo,
      unlocked: me ? { ...me.unlocked } : s.unlocked,
    }))
  },

  onPlayersBatch: (list) => {
    const next: Record<string, PlayerSnapshot> = {}
    for (const p of list) next[p.id] = p
    set({ players: next })
  },

  onPickupsBatch: (list) => set({ pickups: list }),
  onZone: (z) => set({ zone: z }),

  onShot: (s) => {
    for (const cb of shotSubscribers) cb(s)
  },

  onSystem: (s) => {
    if (s.kind === 'kill') {
      const isSelfKill = s.killerId === get().selfId
      const isSelfVictim = s.victimId === get().selfId
      const text =
        s.killerId === 'zone'
          ? `${s.victim} was caught outside the zone`
          : `${s.killer} eliminated ${s.victim}${isSelfKill ? ' (you)' : isSelfVictim ? ' (you)' : ''}`
      const entry: KillFeedEntry = {
        id: `${s.ts}-${Math.random().toString(36).slice(2, 6)}`,
        text,
        ts: s.ts,
        kind: 'kill',
      }
      set((st) => ({ killFeed: [entry, ...st.killFeed].slice(0, KILL_FEED_MAX) }))
    } else if (s.kind === 'join') {
      const entry: KillFeedEntry = {
        id: `${s.ts}-${Math.random().toString(36).slice(2, 6)}`,
        text: `${s.name} joined the battlefield`,
        ts: s.ts,
        kind: 'join',
      }
      set((st) => ({ killFeed: [entry, ...st.killFeed].slice(0, KILL_FEED_MAX) }))
    } else if (s.kind === 'leave') {
      const entry: KillFeedEntry = {
        id: `${s.ts}-${Math.random().toString(36).slice(2, 6)}`,
        text: `${s.name} left the battlefield`,
        ts: s.ts,
        kind: 'leave',
      }
      set((st) => ({ killFeed: [entry, ...st.killFeed].slice(0, KILL_FEED_MAX) }))
    } else if (s.kind === 'hit') {
      const selfId = get().selfId
      if (selfId && s.victimId === selfId) {
        set({ lastDamageFrom: s.attackerId || null, lastDamageAt: Date.now() })
      }
    }
  },

  onDamaged: (d) => {
    set({ lastDamageFrom: d.from, lastDamageAt: Date.now() })
  },

  onRespawn: (_r) => {
    set({
      alive: true,
      hp: 100,
      respawnAt: null,
      currentWeapon: 'pistol',
      ammo: { ...DEFAULT_AMMO },
      unlocked: { ...DEFAULT_UNLOCKED },
    })
  },

  onPickup: (p) => {
    for (const cb of pickupSubscribers) cb(p)
  },

  onLeaderboard: (l) => set({ globalLeaderboard: l.entries }),

  reset: () =>
    set({
      joined: false,
      selfId: null,
      players: {},
      pickups: [],
      zone: null,
      hp: 100,
      alive: true,
      kills: 0,
      deaths: 0,
      respawnAt: null,
      killFeed: [],
      lastDamageFrom: null,
      lastDamageAt: 0,
      currentWeapon: 'pistol',
      ammo: { ...DEFAULT_AMMO },
      unlocked: { ...DEFAULT_UNLOCKED },
      globalLeaderboard: [],
    }),
}))
