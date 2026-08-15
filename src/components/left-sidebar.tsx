'use client'

import { motion, AnimatePresence } from 'framer-motion'
import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  MessageSquarePlus,
  MessageSquare,
  Trash2,
  Wrench,
  BookMarked,
  Swords,
  FlaskConical,
  Brain,
  Settings,
  BarChart3,
  Box,
  Home,
  Wand2,
  GitBranch,
  ListTree,
  ChevronDown,
  Network,
  type LucideIcon,
} from 'lucide-react'
import { GolemLogo } from './golem-logo'
import { StatusIndicator } from './status-indicator'
import { CreateRepoModal } from './create-repo-modal'
import type { Conversation } from '@/lib/chat-history'

interface LeftSidebarProps {
  agentStatus: 'online' | 'thinking' | 'streaming' | 'idle'
  conversations: Conversation[]
  activeId: string
  onNewChat: () => void
  onSelectConversation: (id: string) => void
  onDeleteConversation: (id: string) => void
}

interface NavItem {
  href: string
  icon: LucideIcon
  label: string
  desc: string
}

const SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Platform',
    items: [
      { href: '/', icon: Home, label: 'Home', desc: 'Dashboard overview' },
      { href: '/chat', icon: MessageSquare, label: 'Chat', desc: 'Ask Golem anything' },
      { href: '/usage', icon: BarChart3, label: 'Usage', desc: 'Track tokens, cost, and alerts' },
    ],
  },
  {
    // Batch 8.5: Forge, Missions, and Agency are one tabbed workspace now
    // (see src/app/forge/page.tsx's `primaryTab`) — these three entries all
    // deep-link into it via `?tab=`, they no longer visit separate pages.
    title: 'Workspace',
    items: [
      { href: '/forge', icon: Swords, label: 'The Forge', desc: 'Coding agent, missions, and agency — one workspace' },
      { href: '/forge?tab=missions', icon: ListTree, label: 'Missions', desc: 'The real mission spine — tasks, roster, evidence' },
      { href: '/forge?tab=agency', icon: Network, label: 'Agency', desc: 'Org chart, pause/resume, real functional audits' },
      { href: '/scribe', icon: Wand2, label: 'Prompt Engineer', desc: 'Prompt engineering lab' },
      { href: '/lab', icon: FlaskConical, label: 'Lab', desc: 'Experiments and overnight runs' },
    ],
  },
  {
    title: 'Library',
    items: [
      { href: '/resources', icon: Wrench, label: 'Tools', desc: 'Built-in tools and resources' },
      { href: '/prompts', icon: BookMarked, label: 'Prompts', desc: 'Saved prompts and recipes' },
      { href: '/resources/memory', icon: Brain, label: 'Memory', desc: 'Saved facts and context' },
    ],
  },
  {
    title: 'System',
    items: [
      { href: '/settings', icon: Settings, label: 'Settings', desc: 'Account and integrations' },
      { href: '#', icon: GitBranch, label: 'New Repo', desc: 'Create a GitHub repository' },
    ],
  },
]

/** Demoted, low-traffic destinations — present but not competing for primary attention. */
const MORE_SECTION: { title: string; items: NavItem[] } = {
  title: 'More',
  items: [{ href: '/atelier', icon: Box, label: 'The Atelier', desc: '3D headquarters view' }],
}

function NavLink({ item, isActive }: { item: NavItem; isActive: boolean }) {
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      className={`group flex items-start gap-3 rounded-md px-2 py-2 transition-colors ${
        isActive
          ? 'bg-surface-elevated text-foreground'
          : 'text-muted-foreground hover:bg-surface-elevated/60 hover:text-foreground'
      }`}
    >
      <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${isActive ? 'text-primary' : 'text-muted-foreground/70 group-hover:text-foreground'}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium">{item.label}</span>
          {isActive && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
        </div>
        <p className="truncate text-[10px] text-muted-foreground/70">{item.desc}</p>
      </div>
    </Link>
  )
}

function formatRelativeTime(ts: number): string {
  const diffMs = Date.now() - ts
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function LeftSidebar({
  agentStatus,
  conversations,
  activeId,
  onNewChat,
  onSelectConversation,
  onDeleteConversation,
}: LeftSidebarProps) {
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // Batch 8.5: /forge, /forge?tab=missions, /forge?tab=agency all share one
  // path — pathname alone can't tell them apart, so active-state matching
  // also has to compare the `tab` query param (absent == 'forge', the
  // workspace's default tab).
  const isNavItemActive = (href: string): boolean => {
    const [hrefPath, hrefQuery] = href.split('?')
    if (pathname !== hrefPath) return false
    const hrefTab = new URLSearchParams(hrefQuery ?? '').get('tab') ?? 'forge'
    const currentTab = pathname === '/forge' ? (searchParams.get('tab') ?? 'forge') : 'forge'
    return hrefPath !== '/forge' || hrefTab === currentTab
  }

  const [createRepoOpen, setCreateRepoOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)

  return (
    <aside className="flex h-full w-[260px] flex-col border-r border-border bg-surface-secondary">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border p-4">
        <GolemLogo size="sm" />
        <StatusIndicator status={agentStatus} />
      </div>

      {/* New Chat */}
      <div className="p-3">
        <button
          onClick={onNewChat}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
        >
          <MessageSquarePlus className="h-4 w-4" />
          New Chat
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-4 scrollbar-hidden">
        {/* Nav sections */}
        <nav className="space-y-5">
          {SECTIONS.map((section) => (
            <div key={section.title}>
              <h3 className="mb-2 px-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                {section.title}
              </h3>
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const isActive = isNavItemActive(item.href)
                  if (item.href === '#') {
                    return (
                      <button
                        key={item.label}
                        onClick={() => setCreateRepoOpen(true)}
                        className="group flex w-full items-start gap-3 rounded-md px-2 py-2 transition-colors text-muted-foreground hover:bg-surface-elevated/60 hover:text-foreground"
                      >
                        <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 flex-shrink-0 fill-muted-foreground/70 group-hover:fill-foreground" xmlns="http://www.w3.org/2000/svg">
                          <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
                        </svg>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium">{item.label}</span>
                          </div>
                          <p className="truncate text-[10px] text-muted-foreground/70">{item.desc}</p>
                        </div>
                      </button>
                    )
                  }
                  return <NavLink key={item.href} item={item} isActive={isActive} />
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Secondary / demoted nav — present but out of the way */}
        <div>
          <button
            onClick={() => setMoreOpen((v) => !v)}
            className="flex w-full items-center justify-between px-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            {MORE_SECTION.title}
            <ChevronDown className={`h-3 w-3 transition-transform ${moreOpen ? 'rotate-180' : ''}`} />
          </button>
          <AnimatePresence initial={false}>
            {moreOpen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <div className="mt-2 space-y-0.5">
                  {MORE_SECTION.items.map((item) => (
                    <NavLink key={item.href} item={item} isActive={isNavItemActive(item.href)} />
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="border-t border-border" />

        {/* Chat History */}
        <div>
          <h3 className="mb-2 px-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            Chat History
          </h3>
          {conversations.length === 0 ? (
            <p className="px-2 text-xs text-muted-foreground">No saved chats yet.</p>
          ) : (
            <div className="space-y-0.5">
              <AnimatePresence>
                {conversations.map((conv, index) => (
                  <motion.div
                    key={conv.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ delay: Math.min(index * 0.03, 0.3) }}
                    className={`group flex items-center gap-2 rounded-md px-2 py-2 cursor-pointer ${
                      conv.id === activeId ? 'bg-surface-elevated' : 'hover:bg-surface-elevated/60'
                    }`}
                    onClick={() => onSelectConversation(conv.id)}
                  >
                    <MessageSquare
                      className={`h-3.5 w-3.5 flex-shrink-0 ${conv.id === activeId ? 'text-primary' : 'text-muted-foreground'}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className={`truncate text-xs ${conv.id === activeId ? 'text-foreground' : 'text-muted-foreground'}`}>
                        {conv.title}
                      </p>
                      <p className="font-mono text-[10px] text-muted-foreground">
                        {formatRelativeTime(conv.updatedAt)}
                      </p>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onDeleteConversation(conv.id)
                      }}
                      className="rounded p-1 opacity-0 transition-opacity hover:bg-surface-secondary group-hover:opacity-100"
                    >
                      <Trash2 className="h-3 w-3 text-muted-foreground" />
                    </button>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>
      <CreateRepoModal open={createRepoOpen} onClose={() => setCreateRepoOpen(false)} />
    </aside>
  )
}
