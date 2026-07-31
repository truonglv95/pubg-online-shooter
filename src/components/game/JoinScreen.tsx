'use client'

import { useState } from 'react'
import { useGameStore } from '@/lib/game/store'
import { emitJoin } from '@/lib/game/socket'

export default function JoinScreen() {
  const connected = useGameStore((s) => s.connected)
  const [name, setName] = useState(() => {
    if (typeof window === 'undefined') return ''
    return localStorage.getItem('player_name') ?? ''
  })
  const [submitting, setSubmitting] = useState(false)

  const handleJoin = () => {
    const trimmed = name.trim()
    if (!trimmed || !connected) return
    setSubmitting(true)
    localStorage.setItem('player_name', trimmed)
    emitJoin(trimmed)
  }

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-gradient-to-br from-[#0b1020] via-[#10182f] to-[#0b1020]">
      {/* Background animated grid */}
      <div
        className="absolute inset-0 opacity-30"
        style={{
          backgroundImage:
            'linear-gradient(rgba(56,189,248,0.15) 1px, transparent 1px), linear-gradient(90deg, rgba(56,189,248,0.15) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />

      <div className="relative w-full max-w-md px-6">
        {/* Title */}
        <div className="mb-8 text-center">
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-red-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
            Live Multiplayer
          </div>
          <h1 className="text-5xl font-black uppercase tracking-tight text-white">
            BATTLE<span className="text-red-500">GROUND</span>
          </h1>
          <p className="mt-2 text-sm text-white/50">
            Top-down arena shooter. Last one standing wins.
          </p>
        </div>

        {/* Join card */}
        <div className="rounded-lg border border-white/10 bg-black/40 p-6 backdrop-blur">
          <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-white/60">
            Callsign
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 16))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleJoin()
            }}
            placeholder="Enter your name..."
            autoFocus
            className="w-full rounded-md border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-white/30 outline-none focus:border-cyan-400/50 focus:ring-2 focus:ring-cyan-400/20"
          />

          <button
            onClick={handleJoin}
            disabled={!connected || !name.trim() || submitting}
            className="mt-4 w-full rounded-md bg-gradient-to-r from-red-600 to-orange-500 px-4 py-3 text-sm font-bold uppercase tracking-wider text-white shadow-lg transition-all hover:from-red-500 hover:to-orange-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? 'Joining...' : !connected ? 'Connecting...' : 'Deploy'}
          </button>

          {!connected && (
            <div className="mt-3 text-center text-xs text-amber-400/80">
              Connecting to game server...
            </div>
          )}

          {/* Controls hint */}
          <div className="mt-6 border-t border-white/10 pt-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/40">
              Controls
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs text-white/70">
              <div className="flex items-center gap-2">
                <kbd className="rounded bg-white/10 px-1.5 py-0.5 font-mono">WASD</kbd>
                <span>Move</span>
              </div>
              <div className="flex items-center gap-2">
                <kbd className="rounded bg-white/10 px-1.5 py-0.5 font-mono">Mouse</kbd>
                <span>Aim</span>
              </div>
              <div className="flex items-center gap-2">
                <kbd className="rounded bg-white/10 px-1.5 py-0.5 font-mono">Click</kbd>
                <span>Shoot</span>
              </div>
              <div className="flex items-center gap-2">
                <kbd className="rounded bg-white/10 px-1.5 py-0.5 font-mono">Hold</kbd>
                <span>Auto-fire</span>
              </div>
            </div>
            <div className="mt-3 text-[11px] leading-relaxed text-white/40">
              Click the game area to lock your mouse. Press <kbd className="rounded bg-white/10 px-1 py-0.5 font-mono">Esc</kbd> to release.
            </div>
          </div>
        </div>

        <div className="mt-4 text-center text-[11px] text-white/30">
          Built with Next.js + Three.js + Socket.io
        </div>
      </div>
    </div>
  )
}
