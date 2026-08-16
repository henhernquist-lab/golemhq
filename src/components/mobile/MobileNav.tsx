'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { Bell, Activity, Grid3X3, type LucideIcon } from 'lucide-react'

interface Tab {
  label: string
  path: string
  icon: LucideIcon
  badge?: number
}

const TABS: Tab[] = [
  { label: 'Inbox', path: '/m/inbox', icon: Bell },
  { label: 'Status', path: '/m/status', icon: Activity },
  { label: 'Tools', path: '/m/tools', icon: Grid3X3 },
]

export function MobileNav({ inboxBadge }: { inboxBadge?: number }) {
  const pathname = usePathname()

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-surface-secondary/95 backdrop-blur"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div className="mx-auto flex max-w-lg items-center justify-around">
        {TABS.map((tab) => {
          const Icon = tab.icon
          const active = pathname === tab.path
          const badge = tab.label === 'Inbox' ? inboxBadge : tab.badge
          return (
            <Link
              key={tab.path}
              href={tab.path}
              className={`relative flex flex-col items-center gap-0.5 px-3 py-2 transition-colors ${
                active ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
              }`}
              style={{ minHeight: 44, minWidth: 44, justifyContent: 'center' }}
            >
              <div className="relative">
                <Icon className="h-5 w-5" />
                {badge && badge > 0 ? (
                  <span className="absolute -right-2 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-destructive px-1 font-mono text-[9px] font-bold text-destructive-foreground">
                    {badge > 9 ? '9+' : badge}
                  </span>
                ) : null}
              </div>
              <span className="font-mono text-[10px] uppercase tracking-wider">
                {tab.label}
              </span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
