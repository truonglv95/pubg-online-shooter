# PUBG-Style Online Shooter (Web)

A real-time, top-down 3D multiplayer arena shooter built with **Next.js 16**, **Three.js**, and **Socket.io**. Inspired by PUBG / battle-royale gameplay — drop into a map, hunt other players, and rack up kills.

![Game screenshot](https://via.placeholder.com/800x400/0b1020/ffffff?text=Battleground+-+Online+Shooter)

## ✨ Features

- **True multiplayer** — authoritative Socket.io server, every player sees every other player in real time (positions, rotations, HP, deaths).
- **3D arena** — Three.js rendered map with obstacles (crates, walls, central building), grid floor, dynamic shadows.
- **Top-down shooter controls** — WASD to move, mouse to aim, click/hold to fire. Pointer lock for FPS-style aiming.
- **Authoritative hit detection** — server ray-casts every bullet against players and obstacles, so cheaters can't fake hits.
- **Combat systems** — HP bars, damage flashes, kill feed, respawn timer, scoreboard.
- **Live HUD** — health bar, kills/deaths, online counter, leaderboard (top 10), minimap with all player blips, kill feed, crosshair, elimination overlay.
- **Respawn flow** — 4 s respawn timer after death, spawn at a random edge location.
- **Anti-cheat basics** — server validates that movement packets don't teleport, enforces shoot cooldown.

## 🏗️ Architecture

```
┌─────────────────────┐        Socket.io (polling+ws)        ┌──────────────────────┐
│  Browser (Next.js)  │  <─────────────────────────────────> │  Game Server (bun)   │
│                     │                                       │                      │
│  • Three.js canvas  │   join / move / shoot ─────────────► │  • Authoritative sim │
│  • HUD (React)      │                                       │  • Ray-cast hit det. │
│  • Zustand store    │   ◄───────────────── tick / shot /   │  • 30 Hz tick         │
│  • Local input      │       system / damaged / respawn     │  • Respawn timer     │
└─────────────────────┘                                       └──────────────────────┘
         port 3000                                                       port 3003
                  ▲                                ▲
                  └────────── Caddy :81 ───────────┘
                  (XTransformPort query routes to 3003)
```

The browser never trusts the client for combat — it only sends input intents (`move`, `shoot`) and renders what the server says. This means hit detection, damage, and kills are all computed on the server.

## 🚀 Getting started

### Prerequisites

- Node.js 18+ or [Bun](https://bun.sh/) (recommended)
- A modern browser with WebGL support

### Install

```bash
# from repo root
bun install                          # Next.js deps
cd mini-services/game-server
bun install                          # socket.io server deps
cd ../..
```

### Run

In two terminals:

```bash
# Terminal 1 — game server (port 3003)
cd mini-services/game-server
bun run dev                          # or: bun index.ts

# Terminal 2 — Next.js app (port 3000)
bun run dev
```

Open http://localhost:3000, enter a callsign, click **Deploy**, and click the canvas to lock your mouse.

> In this Z.ai sandbox the project uses a Caddy gateway on port 81 that auto-routes `?XTransformPort=3003` to the game server. In a plain local setup, just run both servers as above and use `io('http://localhost:3003')` in `src/lib/game/socket.ts` instead of the relative path.

### Run game-server as a detached daemon

The repo ships with a helper script that double-forks the game-server so it survives shell exits (useful in CI / sandboxed environments):

```bash
python3 scripts/start_game_server.py start     # start
python3 scripts/start_game_server.py restart   # restart
python3 scripts/start_game_server.py status    # check status
```

## 🎮 Controls

| Key / Input | Action |
| --- | --- |
| `W` `A` `S` `D` or arrow keys | Move (relative to facing direction) |
| Mouse (horizontal) | Rotate / aim |
| Left click | Fire one shot |
| Hold left click | Auto-fire |
| Click canvas | Lock pointer (FPS aim) |
| `Esc` | Release pointer lock |

## 📂 Project structure

```
.
├── mini-services/
│   └── game-server/                # Socket.io authoritative server (port 3003)
│       ├── index.ts                # server entry: world sim, ray-cast hit det., tick loop
│       └── package.json
├── scripts/
│   └── start_game_server.py        # daemon launcher (double-fork)
├── src/
│   ├── app/
│   │   └── page.tsx                # main page: JoinScreen → GameCanvas + Hud
│   ├── components/
│   │   └── game/
│   │       ├── GameCanvas.tsx      # Three.js renderer + input handling
│   │       ├── Hud.tsx             # HP, leaderboard, kill feed, minimap
│   │       └── JoinScreen.tsx      # callsign entry / deploy
│   └── lib/
│       └── game/
│           ├── obstacles-cache.ts  # module-level obstacle cache
│           ├── socket.ts           # socket.io-client hook + emit helpers
│           ├── store.ts            # zustand store: players, HP, kill feed
│           └── types.ts            # shared TS types
└── Caddyfile                       # gateway config (XTransformPort routing)
```

## 🛠️ Tech stack

- **Framework**: Next.js 16 (App Router, Turbopack) + TypeScript 5
- **3D**: Three.js 0.185
- **Realtime**: Socket.io 4.8 (server) + socket.io-client 4.8 (browser)
- **State**: Zustand 5
- **UI**: Tailwind CSS 4 + shadcn/ui
- **Runtime**: Bun

## 🎯 Game design notes

- **Map**: 80 × 80 unit ground plane, 28 procedurally placed crates, 4 outer walls, 4 long cover walls, central building (8 × 8 × 3) with a smaller 4 × 4 × 1 capstone.
- **Player**: capsule body (0.6 radius, 1.8 tall) + head sphere + small gun mesh; moves at 12 units/s.
- **Combat**: 18 damage per hit, 100 HP, 180 ms shot cooldown, 100-unit bullet range, 4 s respawn.
- **Tick rate**: server broadcasts full snapshot at 30 Hz; clients send movement at 20 Hz and interpolate between snapshots for smooth remote-player motion.

## 📈 Possible next steps

- Add a "playable area" shrinking circle (battle-royale zone)
- Pickups: health packs, ammo, weapon upgrades
- Multiple weapons (pistol, rifle, shotgun) with different stats
- Sound effects + spatial audio
- Persistent leaderboard via Prisma/SQLite
- Squad mode (team vs team)

## 📝 License

MIT — do whatever you want.
