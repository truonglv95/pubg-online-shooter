'use client'

import { useEffect, useState } from 'react'
import { useGameSocket } from '@/lib/game/socket'
import { useGameStore } from '@/lib/game/store'
import JoinScreen from '@/components/game/JoinScreen'
import GameCanvas from '@/components/game/GameCanvas'
import Hud from '@/components/game/Hud'

export default function Home() {
  // Initialise the socket connection & store subscriptions.
  useGameSocket()

  const joined = useGameStore((s) => s.joined)
  const [canvasReady, setCanvasReady] = useState(false)

  // Hide overflow on body so the game fills the viewport.
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    document.documentElement.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
      document.documentElement.style.overflow = ''
    }
  }, [])

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#0b1020] text-white">
      {/* Game canvas mounts once the player has joined. */}
      {joined && (
        <GameCanvas onReady={() => setCanvasReady(true)} />
      )}

      {/* HUD overlays the canvas. */}
      {joined && canvasReady && <Hud />}

      {/* Join screen sits on top until the player has deployed. */}
      {!joined && <JoinScreen />}
    </main>
  )
}
