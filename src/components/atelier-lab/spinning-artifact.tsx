'use client'

import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import type { Group } from 'three'

const MODEL_PATH = '/assets/golem-cube.glb'

interface SpinningArtifactProps {
  speed?: number
}

/** Spinning artifact — loads the golem-cube GLB and rotates it on Y. */
export default function SpinningArtifact({ speed = 0.6 }: SpinningArtifactProps) {
  const groupRef = useRef<Group>(null)
  const { scene } = useGLTF(MODEL_PATH)

  useFrame((_, delta) => {
    if (!groupRef.current) return
    groupRef.current.rotation.y += delta * speed
  })

  return <primitive ref={groupRef} object={scene} />
}

// Preloaded so the model is fetched as soon as this module is imported,
// not on first mount — avoids a pop-in when the artifact enters view.
useGLTF.preload(MODEL_PATH)
