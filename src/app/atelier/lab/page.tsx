import { ArtifactLab } from '@/components/atelier-lab/artifact-lab'

export const metadata = {
  title: 'Artifact Lab — Golem',
  description: 'Renders agent-generated R3F components against agent-generated 3D assets',
}

/**
 * The proving ground for the asset pipeline: a Blender-generated .glb loaded by
 * an agent-authored R3F component. Standalone rather than wired into The
 * Atelier because a broken generated component should not be able to take down
 * the real scene.
 */
export default function ArtifactLabPage() {
  return <ArtifactLab />
}
