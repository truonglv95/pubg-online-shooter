'use client'

import * as THREE from 'three'
import type { WeaponId } from '@/lib/game/types'

// =====================================================================
// Humanoid player model built from primitives.
// Returns a group with named sub-bones so the GameCanvas can animate them
// (walk cycle, idle bob, shoot recoil, death tumble).
// =====================================================================

export interface HumanoidRig {
  group: THREE.Group
  // Bones
  root: THREE.Group           // pivots at feet (y=0)
  hips: THREE.Group           // hip pivot
  spine: THREE.Group          // torso pivot
  head: THREE.Group
  upperArmL: THREE.Group
  lowerArmL: THREE.Group
  upperArmR: THREE.Group
  lowerArmR: THREE.Group
  upperLegL: THREE.Group
  lowerLegL: THREE.Group
  upperLegR: THREE.Group
  lowerLegR: THREE.Group
  // Gun mesh (held in right hand)
  gun: THREE.Mesh
  gunMat: THREE.MeshStandardMaterial
  // Materials (so we can tint per-player color)
  bodyMat: THREE.MeshStandardMaterial
  headMat: THREE.MeshStandardMaterial
  // Per-frame animation state
  walkPhase: number           // accumulates with movement
  recoilTime: number          // 0..1 decay after shooting
  deathTime: number           // 0..1 progression of death animation (0 = alive)
  alive: boolean
  // Muzzle marker (where bullets originate)
  muzzle: THREE.Object3D
  // Cached bounding for billboarded HP bar / name sprite
  nameSpriteAnchor: THREE.Object3D
  hpBarAnchor: THREE.Object3D
  weaponTagAnchor: THREE.Object3D
}

const HUMAN_HEIGHT = 1.8

// Per-weapon gun visual dimensions
const GUN_VISUALS: Record<WeaponId, { size: [number, number, number]; color: number; offset: [number, number, number] }> = {
  pistol:  { size: [0.10, 0.10, 0.35], color: 0x2a2a2a, offset: [0.0, 0.0, 0.15] },
  rifle:   { size: [0.10, 0.12, 0.85], color: 0x222222, offset: [0.0, 0.0, 0.35] },
  shotgun: { size: [0.14, 0.14, 0.95], color: 0x3a2a1a, offset: [0.0, 0.0, 0.35] },
  sniper:  { size: [0.08, 0.10, 1.40], color: 0x1a1a2a, offset: [0.0, 0.02, 0.6] },
}

export function applyGunVisual(rig: HumanoidRig, weapon: WeaponId) {
  const vis = GUN_VISUALS[weapon]
  rig.gun.scale.set(vis.size[0] / 0.1, vis.size[1] / 0.1, vis.size[2] / 0.35)
  rig.gun.position.set(vis.offset[0], vis.offset[1], vis.offset[2])
  rig.gunMat.color.setHex(vis.color)
}

export function createHumanoid(color: string): HumanoidRig {
  const playerColor = new THREE.Color(color)
  const skinColor = playerColor.clone().lerp(new THREE.Color(0xffe0c0), 0.5)
  const darkColor = playerColor.clone().lerp(new THREE.Color(0x000000), 0.4)

  // Reusable materials
  const bodyMat = new THREE.MeshStandardMaterial({
    color: playerColor, roughness: 0.6, metalness: 0.15,
  })
  const limbMat = new THREE.MeshStandardMaterial({
    color: darkColor, roughness: 0.65, metalness: 0.15,
  })
  const headMat = new THREE.MeshStandardMaterial({
    color: skinColor, roughness: 0.55, metalness: 0.05,
  })
  const gunMat = new THREE.MeshStandardMaterial({
    color: 0x222222, roughness: 0.4, metalness: 0.7,
  })

  // === Skeleton hierarchy ===
  const root = new THREE.Group()        // pivots at feet
  const hips = new THREE.Group()        // hip pivot
  hips.position.y = 0.95
  root.add(hips)

  const spine = new THREE.Group()       // torso pivot
  spine.position.y = 0.0
  hips.add(spine)

  // Torso (slightly tapered cylinder)
  const torsoGeo = new THREE.CylinderGeometry(0.22, 0.28, 0.65, 12, 1)
  const torso = new THREE.Mesh(torsoGeo, bodyMat)
  torso.position.y = 0.33
  torso.castShadow = true
  spine.add(torso)

  // Chest detail (smaller cylinder on top for chest definition)
  const chestGeo = new THREE.CylinderGeometry(0.26, 0.22, 0.18, 12, 1)
  const chest = new THREE.Mesh(chestGeo, bodyMat)
  chest.position.y = 0.6
  chest.castShadow = true
  spine.add(chest)

  // Neck
  const neckGeo = new THREE.CylinderGeometry(0.07, 0.08, 0.1, 8)
  const neck = new THREE.Mesh(neckGeo, skinColor.clone().multiplyScalar(0.85) as any)
  ;(neck.material as THREE.MeshStandardMaterial).roughness = 0.6
  neck.position.y = 0.72
  neck.castShadow = true
  spine.add(neck)

  // Head
  const head = new THREE.Group()
  head.position.y = 0.85
  spine.add(head)
  const headGeo = new THREE.SphereGeometry(0.16, 16, 12)
  const headMesh = new THREE.Mesh(headGeo, headMat)
  headMesh.castShadow = true
  head.add(headMesh)

  // Hair / cap (half sphere on top, tinted darker)
  const capGeo = new THREE.SphereGeometry(0.17, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2)
  const capMat = new THREE.MeshStandardMaterial({
    color: darkColor, roughness: 0.7, metalness: 0.1,
  })
  const cap = new THREE.Mesh(capGeo, capMat)
  cap.position.y = 0.02
  cap.castShadow = true
  head.add(cap)

  // Visor (small dark band — eye line) so we can see facing direction
  const visorGeo = new THREE.BoxGeometry(0.22, 0.04, 0.08)
  const visorMat = new THREE.MeshStandardMaterial({
    color: 0x000000, roughness: 0.2, metalness: 0.4, emissive: 0x111122, emissiveIntensity: 0.3,
  })
  const visor = new THREE.Mesh(visorGeo, visorMat)
  visor.position.set(0, 0.02, 0.13)
  head.add(visor)

  // === Arms ===
  // Right arm (gun hand)
  const upperArmR = new THREE.Group()
  upperArmR.position.set(0.32, 0.55, 0)
  spine.add(upperArmR)
  const upperArmRGeo = new THREE.CylinderGeometry(0.07, 0.065, 0.35, 8)
  const upperArmRMesh = new THREE.Mesh(upperArmRGeo, limbMat)
  upperArmRMesh.position.y = -0.175
  upperArmRMesh.castShadow = true
  upperArmR.add(upperArmRMesh)

  const lowerArmR = new THREE.Group()
  lowerArmR.position.y = -0.35
  upperArmR.add(lowerArmR)
  const lowerArmRGeo = new THREE.CylinderGeometry(0.06, 0.055, 0.32, 8)
  const lowerArmRMesh = new THREE.Mesh(lowerArmRGeo, limbMat)
  lowerArmRMesh.position.y = -0.16
  lowerArmRMesh.castShadow = true
  lowerArmR.add(lowerArmRMesh)

  // Gun mesh held in right hand, pointing forward (+Z)
  const gunGeo = new THREE.BoxGeometry(0.1, 0.1, 0.35)
  const gun = new THREE.Mesh(gunGeo, gunMat)
  gun.position.set(0, -0.32, 0.15)
  gun.rotation.x = -Math.PI / 2  // align with arm direction
  gun.castShadow = true
  lowerArmR.add(gun)

  // Muzzle marker (front of gun barrel, in world space after transforms)
  const muzzle = new THREE.Object3D()
  muzzle.position.set(0, -0.32, 0.4)
  lowerArmR.add(muzzle)

  // Left arm
  const upperArmL = new THREE.Group()
  upperArmL.position.set(-0.32, 0.55, 0)
  spine.add(upperArmL)
  const upperArmLGeo = new THREE.CylinderGeometry(0.07, 0.065, 0.35, 8)
  const upperArmLMesh = new THREE.Mesh(upperArmLGeo, limbMat)
  upperArmLMesh.position.y = -0.175
  upperArmLMesh.castShadow = true
  upperArmL.add(upperArmLMesh)

  const lowerArmL = new THREE.Group()
  lowerArmL.position.y = -0.35
  upperArmL.add(lowerArmL)
  const lowerArmLGeo = new THREE.CylinderGeometry(0.06, 0.055, 0.32, 8)
  const lowerArmLMesh = new THREE.Mesh(lowerArmLGeo, limbMat)
  lowerArmLMesh.position.y = -0.16
  lowerArmLMesh.castShadow = true
  lowerArmL.add(lowerArmLMesh)

  // === Legs ===
  const upperLegL = new THREE.Group()
  upperLegL.position.set(-0.13, -0.05, 0)
  hips.add(upperLegL)
  const upperLegLGeo = new THREE.CylinderGeometry(0.09, 0.08, 0.45, 8)
  const upperLegLMesh = new THREE.Mesh(upperLegLGeo, limbMat)
  upperLegLMesh.position.y = -0.225
  upperLegLMesh.castShadow = true
  upperLegL.add(upperLegLMesh)

  const lowerLegL = new THREE.Group()
  lowerLegL.position.y = -0.45
  upperLegL.add(lowerLegL)
  const lowerLegLGeo = new THREE.CylinderGeometry(0.07, 0.05, 0.42, 8)
  const lowerLegLMesh = new THREE.Mesh(lowerLegLGeo, limbMat)
  lowerLegLMesh.position.y = -0.21
  lowerLegLMesh.castShadow = true
  lowerLegL.add(lowerLegLMesh)

  // Foot
  const footLGeo = new THREE.BoxGeometry(0.14, 0.08, 0.28)
  const footLMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5 })
  const footL = new THREE.Mesh(footLGeo, footLMat)
  footL.position.set(0, -0.45, 0.06)
  footL.castShadow = true
  lowerLegL.add(footL)

  const upperLegR = new THREE.Group()
  upperLegR.position.set(0.13, -0.05, 0)
  hips.add(upperLegR)
  const upperLegRGeo = new THREE.CylinderGeometry(0.09, 0.08, 0.45, 8)
  const upperLegRMesh = new THREE.Mesh(upperLegRGeo, limbMat)
  upperLegRMesh.position.y = -0.225
  upperLegRMesh.castShadow = true
  upperLegR.add(upperLegRMesh)

  const lowerLegR = new THREE.Group()
  lowerLegR.position.y = -0.45
  upperLegR.add(lowerLegR)
  const lowerLegRGeo = new THREE.CylinderGeometry(0.07, 0.05, 0.42, 8)
  const lowerLegRMesh = new THREE.Mesh(lowerLegRGeo, limbMat)
  lowerLegRMesh.position.y = -0.21
  lowerLegRMesh.castShadow = true
  lowerLegR.add(lowerLegRMesh)

  const footRGeo = new THREE.BoxGeometry(0.14, 0.08, 0.28)
  const footRMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5 })
  const footR = new THREE.Mesh(footRGeo, footRMat)
  footR.position.set(0, -0.45, 0.06)
  footR.castShadow = true
  lowerLegR.add(footR)

  // === Anchors for sprites (HP bar, name, weapon tag) ===
  // These get added at root level so they stay above the head regardless of bone rotation.
  const nameSpriteAnchor = new THREE.Object3D()
  nameSpriteAnchor.position.y = HUMAN_HEIGHT + 0.55
  root.add(nameSpriteAnchor)

  const hpBarAnchor = new THREE.Object3D()
  hpBarAnchor.position.y = HUMAN_HEIGHT + 0.3
  root.add(hpBarAnchor)

  const weaponTagAnchor = new THREE.Object3D()
  weaponTagAnchor.position.y = HUMAN_HEIGHT + 0.85
  root.add(weaponTagAnchor)

  // Initial pose: arms angled down-forward, gun pointing forward
  upperArmR.rotation.x = -Math.PI / 2.1   // raise right arm forward (gun pointing +Z)
  upperArmR.rotation.z = -0.1
  lowerArmR.rotation.x = -0.05
  upperArmL.rotation.x = -Math.PI / 6
  lowerArmL.rotation.x = -0.3

  const group = new THREE.Group()
  group.add(root)

  return {
    group, root, hips, spine, head,
    upperArmL, lowerArmL, upperArmR, lowerArmR,
    upperLegL, lowerLegL, upperLegR, lowerLegR,
    gun, gunMat, bodyMat, headMat,
    walkPhase: 0,
    recoilTime: 0,
    deathTime: 0,
    alive: true,
    muzzle,
    nameSpriteAnchor, hpBarAnchor, weaponTagAnchor,
  }
}

// =====================================================================
// Per-frame animation update for a humanoid rig.
// `dt` is seconds. `moving` indicates the player is moving this frame.
// `shooting` triggers a recoil animation (one-shot).
// =====================================================================
export function animateHumanoid(
  rig: HumanoidRig,
  dt: number,
  moving: boolean,
  speed01: number, // 0..1 normalized walk speed for blend
) {
  if (!rig.alive) {
    // Death animation: fall over and sink
    rig.deathTime = Math.min(1, rig.deathTime + dt * 1.5)
    const t = rig.deathTime
    // Rotate whole body to fall backward
    rig.root.rotation.x = -t * Math.PI / 2.2
    rig.root.position.y = -t * 0.4  // sink into ground
    // Limbs relax
    rig.upperArmL.rotation.x = THREE.MathUtils.lerp(rig.upperArmL.rotation.x, -Math.PI / 2, t * 0.3)
    rig.upperArmR.rotation.x = THREE.MathUtils.lerp(rig.upperArmR.rotation.x, -Math.PI / 2, t * 0.3)
    rig.upperLegL.rotation.x = THREE.MathUtils.lerp(rig.upperLegL.rotation.x, 0.3, t * 0.3)
    rig.upperLegR.rotation.x = THREE.MathUtils.lerp(rig.upperLegR.rotation.x, 0.3, t * 0.3)
    return
  }

  // Reset death state if reviving
  if (rig.deathTime > 0) {
    rig.deathTime = 0
    rig.root.rotation.x = 0
    rig.root.position.y = 0
  }

  // Walk cycle: phase advances with movement
  const walkSpeed = moving ? 8 + speed01 * 4 : 0
  rig.walkPhase += dt * walkSpeed
  const phase = rig.walkPhase

  // Idle bob (subtle vertical oscillation when not moving)
  const idleBob = moving ? 0 : Math.sin(phase * 0.5) * 0.02

  // Hips bob up/down with walk cycle
  if (moving) {
    rig.hips.position.y = 0.95 + Math.abs(Math.sin(phase * 2)) * 0.05 * speed01 + idleBob
  } else {
    rig.hips.position.y = 0.95 + idleBob
  }

  // Spine lean forward slightly when moving
  const targetLean = moving ? 0.12 * speed01 : 0
  rig.spine.rotation.x = THREE.MathUtils.lerp(rig.spine.rotation.x, targetLean, dt * 8)

  // Legs swing opposite each other
  const swing = moving ? 0.6 * speed01 : 0
  rig.upperLegL.rotation.x = Math.sin(phase) * swing
  rig.upperLegR.rotation.x = Math.sin(phase + Math.PI) * swing
  // Lower legs bend when lifted forward
  rig.lowerLegL.rotation.x = Math.max(0, -Math.sin(phase) * 0.6 * speed01)
  rig.lowerLegR.rotation.x = Math.max(0, -Math.sin(phase + Math.PI) * 0.6 * speed01)

  // Left arm swings opposite to right leg (natural counterbalance)
  // Keep right arm raised (holding gun) — small swing only
  const armSwing = moving ? 0.3 * speed01 : 0
  rig.upperArmL.rotation.x = -Math.PI / 6 + Math.sin(phase + Math.PI) * armSwing
  rig.lowerArmL.rotation.x = -0.3 + Math.abs(Math.sin(phase + Math.PI)) * 0.3 * speed01

  // Right arm: mostly stable (holding gun forward), tiny sway
  rig.upperArmR.rotation.x = -Math.PI / 2.1 + Math.sin(phase) * 0.05 * speed01
  rig.upperArmR.rotation.z = -0.1 + Math.sin(phase) * 0.03 * speed01

  // Recoil decay (one-shot kickback after shooting)
  if (rig.recoilTime > 0) {
    rig.recoilTime = Math.max(0, rig.recoilTime - dt * 6)  // ~166ms decay
    const r = rig.recoilTime
    // Kick the right arm up + back
    const kick = r * 0.35
    rig.upperArmR.rotation.x -= kick
    rig.lowerArmR.rotation.x -= kick * 0.5
    // Whole body lurches back slightly
    rig.spine.rotation.x -= kick * 0.15
  }

  // Subtle head movement tracking forward
  rig.head.rotation.x = THREE.MathUtils.lerp(rig.head.rotation.x, moving ? 0.05 * speed01 : 0, dt * 4)
}

// Trigger a recoil animation (called on shoot).
export function triggerRecoil(rig: HumanoidRig) {
  if (!rig.alive) return
  rig.recoilTime = 1
}

// Set alive/dead state. When set to false, death animation begins.
export function setAlive(rig: HumanoidRig, alive: boolean) {
  if (rig.alive && !alive) {
    rig.alive = false
    rig.deathTime = 0
  } else if (!rig.alive && alive) {
    rig.alive = true
    rig.deathTime = 0
    rig.root.rotation.x = 0
    rig.root.position.y = 0
  }
}

// Update player color (e.g., on respawn with new tint).
export function setPlayerColor(rig: HumanoidRig, color: string) {
  const c = new THREE.Color(color)
  rig.bodyMat.color.copy(c)
  const dark = c.clone().lerp(new THREE.Color(0x000000), 0.4)
  const armMesh = rig.upperArmL.children[0] as THREE.Mesh
  if (armMesh && armMesh.material) {
    ;(armMesh.material as THREE.MeshStandardMaterial).color.copy(dark)
  }
  // Update head skin tone
  const skin = c.clone().lerp(new THREE.Color(0xffe0c0), 0.5)
  rig.headMat.color.copy(skin)
}
