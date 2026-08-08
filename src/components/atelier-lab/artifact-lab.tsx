'use client'

import { Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import SpinningArtifact from './spinning-artifact'

/**
 * Canvas host for generated artifacts.
 *
 * The `data-artifact-*` attributes exist for the Playwright render check —
 * "the page loaded" and "WebGL actually drew the model" are different claims,
 * and only the second one proves the pipeline. onCreated firing means the
 * renderer got a real context, and Suspense resolving means the .glb parsed.
 */
export function ArtifactLab() {
  return (
    <main className="h-screen w-screen bg-surface-base">
      <div className="absolute left-6 top-6 z-10 font-mono text-xs text-muted-foreground">
        <div className="text-primary">ARTIFACT LAB</div>
        <div>asset: blender → golem-cube.glb</div>
        <div>component: agent-authored SpinningArtifact</div>
      </div>
      <Canvas
        data-testid="artifact-canvas"
        camera={{ position: [4, 3, 4], fov: 45 }}
        onCreated={({ gl }) => {
          gl.domElement.dataset.artifactReady = 'true'
        }}
      >
        <ambientLight intensity={0.6} />
        <directionalLight position={[5, 8, 5]} intensity={1.4} />
        <Suspense fallback={null}>
          <SpinningArtifact speed={0.8} />
        </Suspense>
        <OrbitControls enablePan={false} />
      </Canvas>
    </main>
  )
}
