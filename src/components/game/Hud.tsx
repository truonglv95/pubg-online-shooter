'use client'

import { useEffect, useState } from 'react'
import { useGameStore } from '@/lib/game/store'

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

  const [now, setNow] = useState(Date.now())
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

  // Minimap
  const mapSize = constants?.MAP_SIZE ?? 80
  const self = selfId ? players[selfId] : undefined

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

      {/* Top-right: leaderboard */}
      <div className="absolute right-3 top-3 w-60">
        <div className="rounded-md border border-white/10 bg-black/60 backdrop-blur">
          <div className="border-b border-white/10 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-white/70">
            Leaderboard
          </div>
          <div className="max-h-64 overflow-y-auto">
            {sorted.length === 0 ? (
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
            )}
          </div>
        </div>
      </div>

      {/* Bottom-left: kill feed */}
      <div className="absolute bottom-3 left-3 w-72 space-y-1">
        {killFeed.map((k) => (
          <div
            key={k.id}
            className="rounded border border-white/10 bg-black/60 px-2 py-1 text-xs backdrop-blur"
          >
            {k.text}
          </div>
        ))}
      </div>

      {/* Bottom-center: HP bar */}
      <div className="absolute bottom-4 left-1/2 w-80 -translate-x-1/2">
        <div className="rounded-md border border-white/10 bg-black/60 px-3 py-2 backdrop-blur">
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

      {/* Bottom-right: minimap */}
      <div className="absolute bottom-3 right-3">
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
            {/* Center crosshair */}
            <div className="absolute left-1/2 top-1/2 h-px w-full -translate-y-1/2 -translate-x-1/2 bg-white/5" />
            <div className="absolute left-1/2 top-1/2 h-full w-px -translate-y-1/2 -translate-x-1/2 bg-white/5" />
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
                : 'Cause of death: unknown'}
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
    </div>
  )
}
