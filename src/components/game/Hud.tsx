'use client'

import { useEffect, useState } from 'react'
import { useGameStore } from '@/lib/game/store'
import type { WeaponId } from '@/lib/game/types'

const WEAPON_ORDER: WeaponId[] = ['pistol', 'rifle', 'shotgun', 'sniper']
const WEAPON_SHORT: Record<WeaponId, string> = {
  pistol: 'Pistol',
  rifle: 'Rifle',
  shotgun: 'Shotgun',
  sniper: 'Sniper',
}
const WEAPON_KEY: Record<WeaponId, string> = {
  pistol: '1', rifle: '2', shotgun: '3', sniper: '4',
}

export default function Hud() {
  const hp = useGameStore((s) => s.hp)
  const alive = useGameStore((s) => s.alive)
  const kills = useGameStore((s) => s.kills)
  const deaths = useGameStore((s) => s.deaths)
  const respawnAt = useGameStore((s) => s.respawnAt)
  const killFeed = useGameStore((s) => s.killFeed)
  const players = useGameStore((s) => s.players)
  const selfId = useGameStore((s) => s.selfId)
  const constants = useGameStore((s) => s.constants)
  const lastDamageFrom = useGameStore((s) => s.lastDamageFrom)
  const lastDamageAt = useGameStore((s) => s.lastDamageAt)
  const zone = useGameStore((s) => s.zone)
  const currentWeapon = useGameStore((s) => s.currentWeapon)
  const ammo = useGameStore((s) => s.ammo)
  const unlocked = useGameStore((s) => s.unlocked)
  const globalLeaderboard = useGameStore((s) => s.globalLeaderboard)
  const [now, setNow] = useState(Date.now())
  const [muted, setMuted] = useState(false)
  const [showGlobalLb, setShowGlobalLb] = useState(false)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(t)
  }, [])

  const respawnIn = respawnAt ? Math.max(0, respawnAt - now) : 0
  const maxHp = constants?.MAX_HP ?? 100
  const hpRatio = Math.max(0, Math.min(1, hp / maxHp))
  const playersList = Object.values(players)
  const sorted = [...playersList].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
  const onlineCount = playersList.filter((p) => p.connected).length
  const damageFlash = now - lastDamageAt < 250
  const mapSize = constants?.MAP_SIZE ?? 80
  const self = selfId ? players[selfId] : undefined

  // Zone status
  const zonePhase = zone?.phase ?? 0
  const zonePhaseCount = zone?.phaseCount ?? 7
  const zoneShrinking = zone?.shrinking ?? false
  const zoneShrinkEndsAt = zone?.shrinkEndsAt ?? 0
  const zonePhaseStartedAt = zone?.phaseStartedAt ?? 0
  const ZONE_PHASES = [
    { holdMs: 15000, shrinkMs: 20000 },
    { holdMs: 15000, shrinkMs: 20000 },
    { holdMs: 12000, shrinkMs: 18000 },
    { holdMs: 12000, shrinkMs: 15000 },
    { holdMs: 10000, shrinkMs: 15000 },
    { holdMs: 10000, shrinkMs: 12000 },
    { holdMs:  8000, shrinkMs: 10000 },
  ]
  const def = ZONE_PHASES[Math.min(zonePhase, ZONE_PHASES.length - 1)]
  const zoneTimeLeft = zoneShrinking
    ? Math.max(0, zoneShrinkEndsAt - now)
    : Math.max(0, (zonePhaseStartedAt + def.holdMs) - now)
  const zoneTimeLeftSec = Math.ceil(zoneTimeLeft / 1000)

  // Player distance to zone center (for warning indicator)
  const distFromZoneCenter = self && zone
    ? Math.hypot(self.pos.x - zone.centerX, self.pos.z - zone.centerZ)
    : 0
  const outsideZone = !!(zone && distFromZoneCenter > zone.radius)

  const toggleMute = () => {
    const next = (window as any).__sfx?.toggleMute?.() ?? false
    setMuted(next)
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-10 select-none font-mono text-white">
      {/* Damage flash overlay */}
      <div
        className="absolute inset-0 transition-opacity duration-200"
        style={{
          background: 'radial-gradient(ellipse at center, rgba(255,0,0,0) 30%, rgba(255,0,0,0.45) 100%)',
          opacity: damageFlash ? 1 : 0,
        }}
      />

      {/* Zone outside tint */}
      {outsideZone && alive && (
        <div
          className="absolute inset-0"
          style={{
            background: 'radial-gradient(ellipse at center, rgba(100,200,255,0) 30%, rgba(100,200,255,0.35) 100%)',
            animation: 'pulse 1.5s ease-in-out infinite',
          }}
        />
      )}

      {/* Top bar: connection + score */}
      <div className="absolute left-1/2 top-3 -translate-x-1/2">
        <div className="flex items-center gap-4 rounded-md border border-white/10 bg-black/60 px-4 py-2 backdrop-blur">
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-white/60">Kills</span>
            <span className="text-lg font-bold text-emerald-400">{kills}</span>
          </div>
          <div className="h-4 w-px bg-white/20" />
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-white/60">Deaths</span>
            <span className="text-lg font-bold text-red-400">{deaths}</span>
          </div>
          <div className="h-4 w-px bg-white/20" />
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-white/60">Online</span>
            <span className="text-lg font-bold text-cyan-300">{onlineCount}</span>
          </div>
        </div>
      </div>

      {/* Top-right: live session leaderboard (toggleable to global) */}
      <div className="pointer-events-auto absolute right-3 top-3 w-60">
        <div className="rounded-md border border-white/10 bg-black/60 backdrop-blur">
          <div className="flex border-b border-white/10">
            <button
              onClick={() => setShowGlobalLb(false)}
              className={`flex-1 px-3 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
                !showGlobalLb ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70'
              }`}
            >
              Session
            </button>
            <button
              onClick={() => setShowGlobalLb(true)}
              className={`flex-1 px-3 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
                showGlobalLb ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70'
              }`}
            >
              All-Time
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {!showGlobalLb ? (
              sorted.length === 0 ? (
                <div className="px-3 py-3 text-center text-xs text-white/40">No players</div>
              ) : (
                sorted.slice(0, 10).map((p, i) => (
                  <div
                    key={p.id}
                    className={`flex items-center justify-between px-3 py-1.5 text-xs ${
                      p.id === selfId ? 'bg-white/10' : ''
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="w-4 text-right text-white/40">{i + 1}</span>
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: p.color }}
                      />
                      <span className="truncate">{p.name}{p.id === selfId ? ' (you)' : ''}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-emerald-400">{p.kills}</span>
                      <span className="text-white/30">/</span>
                      <span className="text-red-400">{p.deaths}</span>
                    </div>
                  </div>
                ))
              )
            ) : globalLeaderboard.length === 0 ? (
              <div className="px-3 py-3 text-center text-xs text-white/40">No all-time entries yet</div>
            ) : (
              globalLeaderboard.slice(0, 10).map((p, i) => (
                <div key={i} className="flex items-center justify-between px-3 py-1.5 text-xs">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="w-4 text-right text-white/40">{i + 1}</span>
                    <span className="truncate">{p.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-emerald-400">{p.kills}</span>
                    <span className="text-white/30">/</span>
                    <span className="text-red-400">{p.deaths}</span>
                    <span className="ml-1 text-amber-400" title="Best kill streak">
                      🔥{p.bestStreak}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Top-left: zone status */}
      <div className="absolute left-3 top-3 w-56">
        <div className="rounded-md border border-cyan-400/30 bg-black/60 px-3 py-2 backdrop-blur">
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="font-semibold uppercase tracking-wider text-cyan-300">Zone</span>
            <span className="text-white/60">
              Phase {Math.min(zonePhase + 1, zonePhaseCount)}/{zonePhaseCount}
            </span>
          </div>
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-[10px] uppercase tracking-wider text-white/50">
              {zoneShrinking ? 'Shrinking in' : 'Next shrink in'}
            </span>
            <span className={`text-lg font-bold ${zoneShrinking ? 'text-red-400' : 'text-cyan-300'}`}>
              {zoneTimeLeftSec}s
            </span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded bg-black/50">
            <div
              className={`h-full ${zoneShrinking ? 'bg-red-500' : 'bg-cyan-400'}`}
              style={{
                width: `${
                  zoneShrinking
                    ? 100 - (zoneTimeLeft / def.shrinkMs) * 100
                    : 100 - (zoneTimeLeft / def.holdMs) * 100
                }%`,
              }}
            />
          </div>
          {outsideZone && alive && (
            <div className="mt-1 text-[10px] font-bold uppercase tracking-wider text-red-400">
              ⚠ Outside zone — taking damage
            </div>
          )}
        </div>
      </div>

      {/* Bottom-left: kill feed */}
      <div className="absolute bottom-3 left-3 w-72 space-y-1">
        {killFeed.map((k) => (
          <div
            key={k.id}
            className={`rounded border px-2 py-1 text-xs backdrop-blur ${
              k.kind === 'kill'
                ? 'border-red-500/30 bg-red-950/60'
                : k.kind === 'join'
                ? 'border-emerald-500/20 bg-black/60'
                : 'border-white/10 bg-black/60'
            }`}
          >
            {k.text}
          </div>
        ))}
      </div>

      {/* Bottom-center: HP bar + weapon panel */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2">
        <div className="flex flex-col items-center gap-2">
          {/* Weapon panel */}
          <div className="pointer-events-auto flex items-center gap-1 rounded-md border border-white/10 bg-black/60 px-2 py-1.5 backdrop-blur">
            {WEAPON_ORDER.map((w) => {
              const isUnlocked = unlocked[w]
              const isCurrent = currentWeapon === w
              const ammoCount = ammo[w]
              return (
                <div
                  key={w}
                  className={`relative flex min-w-[68px] flex-col items-center rounded px-2 py-1 transition-all ${
                    isCurrent
                      ? 'bg-cyan-500/30 ring-1 ring-cyan-400'
                      : isUnlocked
                      ? 'bg-white/5 hover:bg-white/10'
                      : 'opacity-30'
                  }`}
                >
                  <div className="flex items-center gap-1">
                    <span className="rounded bg-black/40 px-1 text-[9px] font-mono text-white/60">
                      {WEAPON_KEY[w]}
                    </span>
                    <span className="text-[10px] font-bold uppercase tracking-wider">
                      {WEAPON_SHORT[w]}
                    </span>
                  </div>
                  <div className="text-xs font-bold">
                    {w === 'pistol' ? '∞' : isUnlocked ? ammoCount : '—'}
                  </div>
                </div>
              )
            })}
          </div>

          {/* HP bar */}
          <div className="w-80 rounded-md border border-white/10 bg-black/60 px-3 py-2 backdrop-blur">
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="font-semibold uppercase tracking-wider text-white/70">
                {alive ? 'Health' : 'Eliminated'}
              </span>
              <span className="font-bold">{alive ? `${hp} / ${maxHp}` : '—'}</span>
            </div>
            <div className="h-3 w-full overflow-hidden rounded bg-black/50">
              <div
                className="h-full transition-all duration-150"
                style={{
                  width: `${hpRatio * 100}%`,
                  backgroundColor:
                    hpRatio > 0.6 ? '#22c55e' : hpRatio > 0.3 ? '#f59e0b' : '#ef4444',
                }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Bottom-right: minimap + mute button */}
      <div className="absolute bottom-3 right-3 flex flex-col items-end gap-2">
        {/* Mute button */}
        <button
          onClick={toggleMute}
          className="pointer-events-auto rounded-md border border-white/10 bg-black/60 px-2 py-1 text-xs text-white/70 backdrop-blur transition-colors hover:bg-white/10"
        >
          {muted ? '🔇 Muted' : '🔊 Sound'}
        </button>

        {/* Minimap */}
        <div className="rounded-md border border-white/10 bg-black/60 p-1 backdrop-blur">
          <div
            className="relative overflow-hidden rounded"
            style={{ width: 140, height: 140, background: '#0e1a0e' }}
          >
            {/* Grid */}
            <div className="absolute inset-0">
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={`v${i}`}
                  className="absolute h-full w-px bg-white/10"
                  style={{ left: `${(i + 1) * 20}%` }}
                />
              ))}
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={`h${i}`}
                  className="absolute h-px w-full bg-white/10"
                  style={{ top: `${(i + 1) * 20}%` }}
                />
              ))}
            </div>
            {/* Zone circle (current) */}
            {zone && (
              <svg
                className="absolute inset-0"
                viewBox="0 0 140 140"
                preserveAspectRatio="none"
                style={{ pointerEvents: 'none' }}
              >
                <circle
                  cx={((zone.centerX + mapSize / 2) / mapSize) * 140}
                  cy={((zone.centerZ + mapSize / 2) / mapSize) * 140}
                  r={(zone.radius / mapSize) * 140}
                  fill="none"
                  stroke="#66ddff"
                  strokeWidth="1.5"
                  strokeOpacity="0.9"
                />
                {zone.targetRadius > 0 && Math.abs(zone.targetRadius - zone.radius) > 0.5 && (
                  <circle
                    cx={((zone.targetX + mapSize / 2) / mapSize) * 140}
                    cy={((zone.targetZ + mapSize / 2) / mapSize) * 140}
                    r={(zone.targetRadius / mapSize) * 140}
                    fill="none"
                    stroke="#ffffff"
                    strokeWidth="0.8"
                    strokeOpacity="0.5"
                    strokeDasharray="3 2"
                  />
                )}
              </svg>
            )}
            {/* Players */}
            {playersList.map((p) => {
              if (!p.connected) return null
              const x = ((p.pos.x + mapSize / 2) / mapSize) * 140
              const y = ((p.pos.z + mapSize / 2) / mapSize) * 140
              return (
                <div
                  key={p.id}
                  className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                  style={{
                    left: x,
                    top: y,
                    backgroundColor: p.id === selfId ? '#ffffff' : p.color,
                    boxShadow: p.id === selfId ? '0 0 6px #fff' : 'none',
                    border: p.id === selfId ? '1px solid #000' : 'none',
                  }}
                />
              )
            })}
          </div>
          <div className="mt-1 text-center text-[10px] uppercase tracking-wider text-white/40">
            Minimap
          </div>
        </div>
      </div>

      {/* Respawn overlay */}
      {!alive && respawnAt && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-red-950/50 backdrop-blur-sm">
          <div className="text-center">
            <div className="mb-2 text-4xl font-black uppercase tracking-widest text-red-400">
              You were eliminated
            </div>
            <div className="mb-6 text-sm text-white/60">
              {lastDamageFrom && players[lastDamageFrom]
                ? `Killed by ${players[lastDamageFrom].name}`
                : 'Caught outside the safe zone'}
            </div>
            <div className="text-lg">
              Respawning in{' '}
              <span className="font-bold text-emerald-400">
                {(respawnIn / 1000).toFixed(1)}s
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Crosshair */}
      {alive && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <div className="relative h-6 w-6">
            <div className="absolute left-1/2 top-0 h-2 w-px -translate-x-1/2 bg-white/80" />
            <div className="absolute left-1/2 bottom-0 h-2 w-px -translate-x-1/2 bg-white/80" />
            <div className="absolute top-1/2 left-0 w-2 h-px -translate-y-1/2 bg-white/80" />
            <div className="absolute top-1/2 right-0 w-2 h-px -translate-y-1/2 bg-white/80" />
            <div className="absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-500" />
          </div>
        </div>
      )}

      {/* Inline keyframe for zone-pulse animation */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.6; }
          50% { opacity: 1; }
        }
      `}</style>
    </div>
  )
}
