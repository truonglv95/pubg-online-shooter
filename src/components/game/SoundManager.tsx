'use client'

import { useEffect, useRef } from 'react'
import { useGameStore } from '@/lib/game/store'
import { subscribeShots, subscribePickups } from '@/lib/game/socket'
import type { WeaponId, PickupKind } from '@/lib/game/types'

// Procedural sound effects via Web Audio API.
// No external assets — every sound is synthesised on the fly.
// Sounds: shoot (per weapon), hit marker, take damage, kill, pickup, zone warning, respawn, footstep.

type SfxName =
  | 'shoot_pistol' | 'shoot_rifle' | 'shoot_shotgun' | 'shoot_sniper'
  | 'hit_marker' | 'take_damage' | 'kill' | 'pickup_health' | 'pickup_ammo'
  | 'pickup_weapon' | 'zone_warning' | 'respawn' | 'click'

export default function SoundManager() {
  const ctxRef = useRef<AudioContext | null>(null)
  const masterRef = useRef<GainNode | null>(null)
  const mutedRef = useRef(false)
  const volumeRef = useRef(0.4)
  const lastZoneWarnRef = useRef(0)
  const aliveRef = useRef(true)
  const inZoneRef = useRef(true)
  const zoneRef = useRef<{ centerX: number; centerZ: number; radius: number; phase: number; phaseCount: number } | null>(null)
  const selfPosRef = useRef<{ x: number; z: number }>({ x: 0, z: 0 })
  const selfIdRef = useRef<string | null>(null)
  const lastShotSoundAtRef = useRef(0)

  // Subscribe to store for state used by ambient sounds (zone warnings, footsteps).
  const players = useGameStore((s) => s.players)
  const selfId = useGameStore((s) => s.selfId)
  const zone = useGameStore((s) => s.zone)
  const hp = useGameStore((s) => s.hp)
  const alive = useGameStore((s) => s.alive)
  const kills = useGameStore((s) => s.kills)

  useEffect(() => { selfIdRef.current = selfId }, [selfId])
  useEffect(() => { aliveRef.current = alive }, [alive])
  useEffect(() => { zoneRef.current = zone }, [zone])

  useEffect(() => {
    if (!selfId) return
    const me = players[selfId]
    if (me) {
      selfPosRef.current = { x: me.pos.x, z: me.pos.z }
    }
  }, [players, selfId, hp])

  // Track previous HP to detect damage taken. We use a ref because playSfx is
  // defined later in the component body.
  const prevHpRef = useRef(hp)
  const prevAliveRef = useRef(alive)
  const prevKillsRef = useRef(kills)
  const playSfxRef = useRef<(name: SfxName) => void>(() => {})

  useEffect(() => {
    if (hp < prevHpRef.current && aliveRef.current) {
      playSfxRef.current('take_damage')
    }
    prevHpRef.current = hp
  }, [hp])

  // Init AudioContext on first user gesture (browsers block autoplay).
  useEffect(() => {
    const ensureCtx = () => {
      if (!ctxRef.current) {
        const Ctx = window.AudioContext || (window as any).webkitAudioContext
        if (!Ctx) return
        const ctx = new Ctx()
        const master = ctx.createGain()
        master.gain.value = volumeRef.current
        master.connect(ctx.destination)
        ctxRef.current = ctx
        masterRef.current = master
      }
      if (ctxRef.current && ctxRef.current.state === 'suspended') {
        ctxRef.current.resume()
      }
    }
    window.addEventListener('click', ensureCtx, { once: false })
    window.addEventListener('keydown', ensureCtx, { once: false })
    return () => {
      window.removeEventListener('click', ensureCtx)
      window.removeEventListener('keydown', ensureCtx)
    }
  }, [])

  // ============== SFX engine ==============
  // `addNoiseBurst` is defined inside `playSfx` to avoid forward-reference lint issues.
  const playSfx = (name: SfxName) => {
    const ctx = ctxRef.current
    const master = masterRef.current
    if (!ctx || !master || mutedRef.current) return
    const now = ctx.currentTime

    const env = (osc: AudioNode, gain: GainNode, attack: number, decay: number, peak: number) => {
      gain.gain.setValueAtTime(0, now)
      gain.gain.linearRampToValueAtTime(peak, now + attack)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + attack + decay)
      osc.connect(gain)
      gain.connect(master)
    }

    const addNoiseBurst = (duration: number, peak: number, lowpass: number) => {
      const bufferSize = Math.floor(ctx.sampleRate * duration)
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate)
      const data = buffer.getChannelData(0)
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize)
      }
      const noise = ctx.createBufferSource()
      noise.buffer = buffer
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.value = lowpass
      const g = ctx.createGain()
      g.gain.setValueAtTime(peak, now)
      g.gain.exponentialRampToValueAtTime(0.0001, now + duration)
      noise.connect(filter); filter.connect(g); g.connect(master)
      noise.start(now); noise.stop(now + duration)
    }

    switch (name) {
      case 'shoot_pistol': {
        const osc = ctx.createOscillator()
        const g = ctx.createGain()
        osc.type = 'square'
        osc.frequency.setValueAtTime(420, now)
        osc.frequency.exponentialRampToValueAtTime(80, now + 0.08)
        env(osc, g, 0.001, 0.09, 0.25)
        osc.start(now); osc.stop(now + 0.12)
        // Noise burst
        addNoiseBurst(0.05, 0.18, 1500)
        break
      }
      case 'shoot_rifle': {
        const osc = ctx.createOscillator()
        const g = ctx.createGain()
        osc.type = 'sawtooth'
        osc.frequency.setValueAtTime(520, now)
        osc.frequency.exponentialRampToValueAtTime(120, now + 0.06)
        env(osc, g, 0.001, 0.07, 0.22)
        osc.start(now); osc.stop(now + 0.1)
        addNoiseBurst(0.04, 0.16, 2200)
        break
      }
      case 'shoot_shotgun': {
        addNoiseBurst(0.18, 0.45, 800)
        const osc = ctx.createOscillator()
        const g = ctx.createGain()
        osc.type = 'square'
        osc.frequency.setValueAtTime(140, now)
        osc.frequency.exponentialRampToValueAtTime(40, now + 0.18)
        env(osc, g, 0.001, 0.2, 0.35)
        osc.start(now); osc.stop(now + 0.25)
        break
      }
      case 'shoot_sniper': {
        const osc = ctx.createOscillator()
        const g = ctx.createGain()
        osc.type = 'sawtooth'
        osc.frequency.setValueAtTime(800, now)
        osc.frequency.exponentialRampToValueAtTime(80, now + 0.25)
        env(osc, g, 0.001, 0.28, 0.35)
        osc.start(now); osc.stop(now + 0.32)
        addNoiseBurst(0.08, 0.3, 3500)
        break
      }
      case 'hit_marker': {
        const osc = ctx.createOscillator()
        const g = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(1200, now)
        env(osc, g, 0.001, 0.05, 0.18)
        osc.start(now); osc.stop(now + 0.07)
        break
      }
      case 'take_damage': {
        const osc = ctx.createOscillator()
        const g = ctx.createGain()
        osc.type = 'triangle'
        osc.frequency.setValueAtTime(220, now)
        osc.frequency.exponentialRampToValueAtTime(60, now + 0.18)
        env(osc, g, 0.001, 0.2, 0.28)
        osc.start(now); osc.stop(now + 0.25)
        break
      }
      case 'kill': {
        // Two-tone confirmation
        for (const f of [660, 990]) {
          const osc = ctx.createOscillator()
          const g = ctx.createGain()
          osc.type = 'triangle'
          osc.frequency.setValueAtTime(f, now + (f === 660 ? 0 : 0.08))
          env(osc, g, 0.001, 0.12, 0.25)
          osc.start(now + (f === 660 ? 0 : 0.08)); osc.stop(now + (f === 660 ? 0.15 : 0.25))
        }
        break
      }
      case 'pickup_health': {
        const osc = ctx.createOscillator()
        const g = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(440, now)
        osc.frequency.linearRampToValueAtTime(880, now + 0.15)
        env(osc, g, 0.001, 0.18, 0.22)
        osc.start(now); osc.stop(now + 0.2)
        break
      }
      case 'pickup_ammo': {
        const osc = ctx.createOscillator()
        const g = ctx.createGain()
        osc.type = 'square'
        osc.frequency.setValueAtTime(330, now)
        env(osc, g, 0.001, 0.08, 0.18)
        osc.start(now); osc.stop(now + 0.1)
        break
      }
      case 'pickup_weapon': {
        for (const f of [440, 550, 660]) {
          const osc = ctx.createOscillator()
          const g = ctx.createGain()
          osc.type = 'sine'
          osc.frequency.setValueAtTime(f, now + (f - 440) / 1000)
          env(osc, g, 0.001, 0.1, 0.2)
          osc.start(now + (f - 440) / 1000); osc.stop(now + (f - 440) / 1000 + 0.12)
        }
        break
      }
      case 'zone_warning': {
        const osc = ctx.createOscillator()
        const g = ctx.createGain()
        osc.type = 'sawtooth'
        osc.frequency.setValueAtTime(160, now)
        env(osc, g, 0.005, 0.4, 0.18)
        osc.start(now); osc.stop(now + 0.45)
        break
      }
      case 'respawn': {
        for (const f of [220, 330, 440]) {
          const osc = ctx.createOscillator()
          const g = ctx.createGain()
          osc.type = 'sine'
          osc.frequency.setValueAtTime(f, now + (f - 220) / 600)
          env(osc, g, 0.001, 0.15, 0.22)
          osc.start(now + (f - 220) / 600); osc.stop(now + (f - 220) / 600 + 0.18)
        }
        break
      }
      case 'click': {
        const osc = ctx.createOscillator()
        const g = ctx.createGain()
        osc.type = 'square'
        osc.frequency.setValueAtTime(800, now)
        env(osc, g, 0.001, 0.04, 0.12)
        osc.start(now); osc.stop(now + 0.05)
        break
      }
    }
  }
  // Keep playSfxRef in sync so earlier effects can call the latest closure.
  useEffect(() => {
    playSfxRef.current = playSfx
  })

  // ============== Subscriptions ==============
  // Shoot sounds — only for nearby shots (within 30 units) OR self shots
  useEffect(() => {
    const unsub = subscribeShots((s) => {
      const self = selfIdRef.current
      if (!self) return
      const isSelf = s.shooterId === self
      const dist = Math.hypot(
        s.origin.x - selfPosRef.current.x,
        s.origin.z - selfPosRef.current.z,
      )
      if (!isSelf && dist > 40) return // too far, don't play
      // Throttle: max one shot sound per 50ms per weapon type to avoid stacking
      const now = performance.now()
      if (now - lastShotSoundAtRef.current < 40) return
      lastShotSoundAtRef.current = now
      const weapon: WeaponId = s.weapon
      const name: SfxName =
        weapon === 'pistol' ? 'shoot_pistol' :
        weapon === 'rifle' ? 'shoot_rifle' :
        weapon === 'shotgun' ? 'shoot_shotgun' :
        'shoot_sniper'
      playSfx(name)
      // Hit marker if shooter is self AND any tracer hit a player
      if (isSelf && s.tracers.some((t) => t.hitPlayerId)) {
        playSfx('hit_marker')
      }
    })
    return unsub
  }, [])

  // Pickup sounds — only for self
  useEffect(() => {
    const unsub = subscribePickups((p) => {
      const kind: PickupKind = p.kind
      if (kind === 'health') playSfx('pickup_health')
      else if (kind === 'ammo') playSfx('pickup_ammo')
      else playSfx('pickup_weapon')
    })
    return unsub
  }, [])

  // Zone warning — periodic when player is outside the zone, or shrinking is starting
  useEffect(() => {
    const t = setInterval(() => {
      const z = zoneRef.current
      if (!z || !aliveRef.current) return
      const dist = Math.hypot(
        selfPosRef.current.x - z.centerX,
        selfPosRef.current.z - z.centerZ,
      )
      const outside = dist > z.radius
      if (outside) {
        const now = Date.now()
        if (now - lastZoneWarnRef.current > 1500) {
          lastZoneWarnRef.current = now
          playSfx('zone_warning')
        }
      }
    }, 500)
    return () => clearInterval(t)
  }, [])

  // Respawn sound
  useEffect(() => {
    if (!prevAliveRef.current && alive) {
      playSfxRef.current('respawn')
    }
    prevAliveRef.current = alive
  }, [alive])

  // Mute toggle (rendered as a hidden hook, but exposed via window for the HUD button)
  useEffect(() => {
    ;(window as any).__sfx = {
      toggleMute: () => {
        mutedRef.current = !mutedRef.current
        if (masterRef.current) {
          masterRef.current.gain.value = mutedRef.current ? 0 : volumeRef.current
        }
        return mutedRef.current
      },
      isMuted: () => mutedRef.current,
      setVolume: (v: number) => {
        volumeRef.current = v
        if (masterRef.current && !mutedRef.current) {
          masterRef.current.gain.value = v
        }
      },
      playClick: () => playSfx('click'),
      playKill: () => playSfx('kill'),
    }
  }, [])

  // Play 'kill' sound when self kills someone
  useEffect(() => {
    if (kills > prevKillsRef.current) {
      playSfxRef.current('kill')
    }
    prevKillsRef.current = kills
  }, [kills])

  // This component renders nothing — it's a side-effect-only mount.
  return null
}
