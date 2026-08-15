'use client'

// Standalone route for the mission spine. See src/components/missions/
// missions-workspace.tsx for the actual view — it's also embedded as a tab
// panel in the unified /forge workspace (Batch 8.5), so the logic lives
// there rather than here, keeping this route a thin deep-link.

import { MissionsWorkspace } from '@/components/missions/missions-workspace'

export default function MissionsPage() {
  return <MissionsWorkspace />
}
