'use client'

// Merged into Settings > Memory (src/components/settings/memory-tab.tsx) —
// this two-textarea form used to be the only Memory UI reachable from the
// sidebar, but it only ever wrote to the legacy embeddings table and never
// showed auto-captured facts. Redirect rather than delete outright, so any
// existing bookmark/link still lands somewhere useful.

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'

export default function LegacyMemoryRedirect() {
  const router = useRouter()

  useEffect(() => {
    router.replace('/settings?tab=memory')
  }, [router])

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  )
}
