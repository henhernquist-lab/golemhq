'use client'

import Link from 'next/link'
import { MessageSquare, Swords, ListTree, Smartphone, Wand2 } from 'lucide-react'
import { Card } from '@/components/card'

const MODES = [
  { href: '/missions', label: 'Missions', desc: 'Mission, task and agent state', icon: ListTree },
  { href: '/forge', label: 'The Forge', desc: 'Autonomous coding agent', icon: Swords },
  { href: '/scribe', label: 'Prompt Engineer', desc: 'Prompt engineering lab', icon: Wand2 },
  { href: '/m/chat', label: 'Shard', desc: 'Mobile chat', icon: Smartphone },
  { href: '/chat', label: 'Chat', desc: 'Ask Golem anything', icon: MessageSquare },
]

export function ModeLauncher() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {MODES.map((mode) => (
        <Link key={mode.href} href={mode.href}>
          <Card
            padding="md"
            className="group relative h-full overflow-hidden border-border/60 bg-surface-secondary/40 transition-all duration-300 hover:border-primary/30 hover:bg-surface-elevated hover:shadow-[0_0_20px_rgba(184,147,90,0.06)]"
          >
            {/* Subtle card texture — warm stone gradient lift */}
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/[0.03] to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />

            <div className="relative z-10">
              <div className="mb-2.5 flex h-9 w-9 items-center justify-center rounded border border-border/50 bg-surface-base/60 transition-all duration-300 group-hover:border-primary/40 group-hover:bg-primary/[0.08]">
                <mode.icon className="h-4.5 w-4.5 text-primary transition-transform duration-300 group-hover:scale-110" />
              </div>
              <h3 className="font-display text-[13px] font-semibold tracking-tight text-foreground transition-colors group-hover:text-primary">
                {mode.label}
              </h3>
              <p className="mt-1 font-mono text-[10px] leading-relaxed text-muted-foreground/70 transition-colors group-hover:text-muted-foreground">
                {mode.desc}
              </p>
            </div>

            {/* Bottom border accent glow on hover */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-primary/20 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
          </Card>
        </Link>
      ))}
    </div>
  )
}
