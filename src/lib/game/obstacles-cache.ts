import type { Obstacle } from './types'

// Simple module-level cache for the static map obstacles.
// Populated once when the server sends the 'welcome' payload, then read
// by the Three.js canvas at mount time to build the world geometry.
let cache: Obstacle[] | null = null

export function setObstaclesCache(o: Obstacle[]) {
  cache = o
}

export function getObstaclesCache(): Obstacle[] | null {
  return cache
}
