#!/bin/bash
# Wrapper that respawns the game server if it dies.
# Catches crashes / OOM kills and restarts up to 10 times.
cd "$(dirname "$0")"

MAX_RESTARTS=10
RESTART_DELAY=2
count=0

while [ $count -lt $MAX_RESTARTS ]; do
  count=$((count + 1))
  echo "[wrapper] starting game-server (attempt $count/$MAX_RESTARTS)..."
  bun index.ts
  exit_code=$?
  echo "[wrapper] game-server exited with code $exit_code"
  if [ $count -lt $MAX_RESTARTS ]; then
    echo "[wrapper] waiting ${RESTART_DELAY}s before restart..."
    sleep $RESTART_DELAY
  fi
done

echo "[wrapper] giving up after $MAX_RESTARTS attempts"
