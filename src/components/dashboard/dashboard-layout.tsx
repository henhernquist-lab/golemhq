'use client'

import { LeftSidebar } from '@/components/left-sidebar'
import { TopBar } from '@/components/top-bar'

interface DashboardLayoutProps {
  children: React.ReactNode
}

export function DashboardLayout({ children }: DashboardLayoutProps) {
  return (
    <div className="relative flex h-screen w-full overflow-hidden bg-transparent">
      <div className="relative z-10 flex h-full w-full flex-col">
        <TopBar />
        <div className="flex min-h-0 w-full flex-1">
          <LeftSidebar agentStatus="online" />
          <main className="min-w-0 flex-1 overflow-y-auto p-4 lg:p-6">
            {children}
          </main>
        </div>
      </div>
    </div>
  )
}
