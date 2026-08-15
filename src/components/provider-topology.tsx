'use client'

import Link from 'next/link'
import { Mail, Globe, Search, Database, Cpu } from 'lucide-react'

const NODES = [
  { id: 'gmail', label: 'Gmail', icon: Mail, color: 'bg-red-500/10 text-red-400 border-red-500/30' },
  { id: 'firecrawl', label: 'Firecrawl', icon: Globe, color: 'bg-orange-500/10 text-orange-400 border-orange-500/30' },
  { id: 'web-search', label: 'Web Search', icon: Search, color: 'bg-blue-500/10 text-blue-400 border-blue-500/30' },
  { id: 'monid', label: 'Monid', icon: Database, color: 'bg-purple-500/10 text-purple-400 border-purple-500/30' },
  { id: 'models', label: 'Models', icon: Cpu, color: 'bg-primary/10 text-primary border-primary/30' },
]

export function ProviderTopology() {
  return (
    <div className="rounded-xl border border-border/60 bg-surface-secondary p-5">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-foreground">Provider Topology</h2>
        <p className="text-[11px] text-muted-foreground">Connected services routing through Golem.</p>
      </div>
      <div className="relative flex h-[180px] w-full items-center justify-center">
        {/* Center node */}
        <div className="z-10 flex h-14 w-14 flex-col items-center justify-center rounded-full border border-primary/40 bg-surface-elevated shadow-lg">
          <span className="text-[10px] font-semibold text-primary">Golem</span>
        </div>

        {/* Orbiting nodes */}
        {NODES.map((node, idx) => {
          const Icon = node.icon
          const angle = (idx / NODES.length) * Math.PI * 2
          const radius = 70
          const x = Math.cos(angle) * radius
          const y = Math.sin(angle) * radius
          return (
            <div
              key={node.id}
              className="absolute flex flex-col items-center"
              style={{ transform: `translate(${x}px, ${y}px)` }}
            >
              {/* Connection line */}
              <div
                className="absolute h-px bg-border/60"
                style={{
                  width: `${radius}px`,
                  transform: `rotate(${angle}rad)`,
                  transformOrigin: 'left center',
                }}
              />
              <Link
                href="/settings"
                className={`flex h-10 w-10 flex-col items-center justify-center rounded-full border ${node.color} bg-surface-elevated transition-transform hover:scale-110`}
              >
                <Icon className="h-4 w-4" />
              </Link>
              <span className="mt-1.5 whitespace-nowrap text-[9px] text-muted-foreground">{node.label}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
