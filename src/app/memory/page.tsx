'use client'

// Merged into Settings > Memory (src/components/settings/memory-tab.tsx) —
// this was the richer memory UI (search, import, edit, delete) but was never
// linked from the sidebar. Redirect rather than delete outright, so any
// existing bookmark/link still lands somewhere useful.

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'

export default function LegacyMemoryPageRedirect() {
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
