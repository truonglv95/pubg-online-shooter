'use client'

import { create } from 'zustand'
import type {
  PlayerSnapshot,
  WelcomePayload,
  ShotPayload,
  SystemMessage,
  DamagedPayload,
  RespawnPayload,
} from './types'

interface KillFeedEntry {
  id: string
  text: string
  ts: number
}

interface GameState {
  // connection
  connected: boolean
  joined: boolean
  selfId: string | null
  // world
  constants: WelcomePayload['constants'] | null
  mapSize: number
  players: Record<string, PlayerSnapshot>
  // hud
  hp: number
  alive: boolean
  kills: number
  deaths: number
  respawnAt: number | null
  lastDamageFrom: string | null
  lastDamageAt: number
  // feeds
  killFeed: KillFeedEntry[]
  // settings
  playerName: string

  setConnected: (v: boolean) => void
  setPlayerName: (v: string) => void
  onWelcome: (p: WelcomePayload) => void
  onTick: (list: PlayerSnapshot[]) => void
  onPlayersBatch: (list: PlayerSnapshot[]) => void
  onShot: (s: ShotPayload) => void
  onSystem: (s: SystemMessage) => void
  onDamaged: (d: DamagedPayload) => void
  onRespawn: (r: RespawnPayload) => void
  reset: () => void
}

let shotCounter = 0
// Shots are handled in the Three.js scene via a separate event emitter,
// but we expose a small ring buffer here for any UI consumer that needs it.
const shotSubscribers = new Set<(s: ShotPayload) => void>()
export function subscribeShots(cb: (s: ShotPayload) => void) {
  shotSubscribers.add(cb)
  return () => shotSubscribers.delete(cb)
}

const KILL_FEED_MAX = 6

export const useGameStore = create<GameState>((set, get) => ({
  connected: false,
  joined: false,
  selfId: null,
  constants: null,
  mapSize: 80,
  players: {},
  hp: 100,
  alive: true,
  kills: 0,
  deaths: 0,
  respawnAt: null,
  lastDamageFrom: null,
  lastDamageAt: 0,
  killFeed: [],
  playerName: '',

  setConnected: (v) => set({ connected: v }),
  setPlayerName: (v) => set({ playerName: v }),

  onWelcome: (p) =>
    set({
      selfId: p.selfId,
      joined: true,
      constants: p.constants,
      mapSize: p.map.size,
      players: { [p.selfId]: p.player },
      hp: p.player.hp,
      alive: p.player.alive,
      kills: p.player.kills,
      deaths: p.player.deaths,
      respawnAt: p.player.respawnAt,
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
    }))
  },

  onPlayersBatch: (list) => {
    const next: Record<string, PlayerSnapshot> = {}
    for (const p of list) next[p.id] = p
    set({ players: next })
  },

  onShot: (s) => {
    shotCounter++
    for (const cb of shotSubscribers) cb(s)
  },

  onSystem: (s) => {
    if (s.kind === 'kill') {
      const entry: KillFeedEntry = {
        id: `${s.ts}-${Math.random().toString(36).slice(2, 6)}`,
        text: `${s.killer} eliminated ${s.victim}`,
        ts: s.ts,
      }
      set((st) => ({ killFeed: [entry, ...st.killFeed].slice(0, KILL_FEED_MAX) }))
    } else if (s.kind === 'join') {
      const entry: KillFeedEntry = {
        id: `${s.ts}-${Math.random().toString(36).slice(2, 6)}`,
        text: `${s.name} joined the battlefield`,
        ts: s.ts,
      }
      set((st) => ({ killFeed: [entry, ...st.killFeed].slice(0, KILL_FEED_MAX) }))
    } else if (s.kind === 'leave') {
      const entry: KillFeedEntry = {
        id: `${s.ts}-${Math.random().toString(36).slice(2, 6)}`,
        text: `${s.name} left the battlefield`,
        ts: s.ts,
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
    set({ alive: true, hp: 100, respawnAt: null })
  },

  reset: () =>
    set({
      joined: false,
      selfId: null,
      players: {},
      hp: 100,
      alive: true,
      kills: 0,
      deaths: 0,
      respawnAt: null,
      killFeed: [],
      lastDamageFrom: null,
      lastDamageAt: 0,
    }),
}))
