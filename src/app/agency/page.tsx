'use client'

// Standalone route for the Agency org chart. See
// src/components/agency/agency-workspace.tsx for the actual view — it's also
// embedded as a tab panel in the unified /forge workspace (Batch 8.5), so the
// logic lives there rather than here, keeping this route a thin deep-link.

import { AgencyWorkspace } from '@/components/agency/agency-workspace'

export default function AgencyPage() {
  return <AgencyWorkspace />
}
