'use client'

import { useEffect, useRef } from 'react'
import { io, Socket } from 'socket.io-client'
import { useGameStore, subscribeShots, subscribePickups } from './store'
import { setObstaclesCache } from './obstacles-cache'
import type {
  WelcomePayload,
  PlayerSnapshot,
  ShotPayload,
  SystemMessage,
  DamagedPayload,
  RespawnPayload,
  PickupSnapshot,
  ZoneSnapshot,
  PickupEvent,
  LeaderboardPayload,
  WeaponId,
} from './types'

let socketRef: Socket | null = null

export function getSocket(): Socket | null {
  return socketRef
}

export function useGameSocket() {
  const onWelcome = useGameStore((s) => s.onWelcome)
  const onTick = useGameStore((s) => s.onTick)
  const onPlayersBatch = useGameStore((s) => s.onPlayersBatch)
  const onPickupsBatch = useGameStore((s) => s.onPickupsBatch)
  const onZone = useGameStore((s) => s.onZone)
  const onShot = useGameStore((s) => s.onShot)
  const onSystem = useGameStore((s) => s.onSystem)
  const onDamaged = useGameStore((s) => s.onDamaged)
  const onRespawn = useGameStore((s) => s.onRespawn)
  const onPickup = useGameStore((s) => s.onPickup)
  const onLeaderboard = useGameStore((s) => s.onLeaderboard)
  const setConnected = useGameStore((s) => s.setConnected)
  const initialized = useRef(false)

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    const sock = io('/?XTransformPort=3003', {
      transports: ['polling', 'websocket'],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      timeout: 10000,
    })
    socketRef = sock

    const onConn = () => setConnected(true)
    const onDisc = () => setConnected(false)
    sock.on('connect', onConn)
    sock.on('disconnect', onDisc)
    sock.on('welcome', (p: WelcomePayload) => {
      setObstaclesCache(p.map.obstacles)
      onWelcome(p)
    })
    sock.on('tick', (list: PlayerSnapshot[]) => onTick(list))
    sock.on('players-batch', (list: PlayerSnapshot[]) => onPlayersBatch(list))
    sock.on('pickups-batch', (list: PickupSnapshot[]) => onPickupsBatch(list))
    sock.on('zone', (z: ZoneSnapshot) => onZone(z))
    sock.on('shot', (s: ShotPayload) => onShot(s))
    sock.on('system', (s: SystemMessage) => onSystem(s))
    sock.on('damaged', (d: DamagedPayload) => onDamaged(d))
    sock.on('respawn', (r: RespawnPayload) => onRespawn(r))
    sock.on('pickup', (p: PickupEvent) => onPickup(p))
    sock.on('leaderboard', (l: LeaderboardPayload) => onLeaderboard(l))

    return () => {
      sock.off('connect', onConn)
      sock.off('disconnect', onDisc)
      sock.disconnect()
      socketRef = null
      initialized.current = false
    }
  }, [
    onWelcome, onTick, onPlayersBatch, onPickupsBatch, onZone, onShot, onSystem,
    onDamaged, onRespawn, onPickup, onLeaderboard, setConnected,
  ])
}

export function emitJoin(name: string) {
  socketRef?.emit('join', { name })
}

export function emitMove(pos: { x: number; y: number; z: number }, rot: number) {
  socketRef?.emit('move', { pos, rot })
}

export function emitShoot(dir: { x: number; y: number; z: number }, origin: { x: number; y: number; z: number }) {
  socketRef?.emit('shoot', { dir, origin })
}

export function emitSwitchWeapon(weapon: WeaponId) {
  socketRef?.emit('switchWeapon', { weapon })
}

export { subscribeShots, subscribePickups }
