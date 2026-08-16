'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import { Settings, ArrowLeft, Mail, Loader2, CheckCircle2, AlertTriangle, Link2Off, User, Sliders, Cpu, Puzzle, Search, Globe, Bot, GraduationCap, School, Key, X, Brain } from 'lucide-react'
import Link from 'next/link'
import { loadGolemVisible, saveGolemVisible } from '@/lib/golem-mascot'
import { MemoryTab } from '@/components/settings/memory-tab'

type ComposioToolkit = 'gmail' | 'firecrawl'
type ConnectionStatus = 'disconnected' | 'pending' | 'connected' | 'error'

// Toolkits that don't need any auth at all — always available, no connect button.
const ALWAYS_AVAILABLE_TOOLKITS = new Set(['composio_search'])

interface ComposioConnection {
  toolkit: string
  status: ConnectionStatus
  error: string | null
  connected_at: string | null
}

const TOOLKIT_META: Record<string, { label: string; desc: string; icon: typeof Mail }> = {
  gmail: { label: 'Gmail', desc: 'Read-only: search and read email through chat.', icon: Mail },
  composio_search: { label: 'Web Search', desc: 'Transactional lookups: prices, flights, finance, e-commerce, and page scraping. No auth needed — always available.', icon: Search },
  firecrawl: { label: 'Firecrawl', desc: 'Advanced web scraping, site crawling, structured data extraction, and site mapping.', icon: Globe },
}

// Placeholder card for a settings section that's ready for wiring.
function SettingsSectionCard({
  icon: Icon,
  title,
  description,
  delay = 0,
}: {
  icon: typeof User
  title: string
  description: string
  delay?: number
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay }}
      className="flex items-center gap-3 rounded-lg border border-border bg-surface-secondary p-4"
    >
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded border border-border bg-background">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[12px] font-medium text-foreground">{title}</p>
        <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{description}</p>
      </div>
      <span className="flex-shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/50">
        Soon
      </span>
    </motion.div>
  )
}

// "Show Golem" — the mascot's on/off switch. Persisted to localStorage like
// the theme; saving broadcasts on the shared event so the globally-mounted
// mascot unmounts (and stops its rAF loop) the moment this flips.
function MascotToggleCard({ delay = 0 }: { delay?: number }) {
  const [enabled, setEnabled] = useState(true)

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setEnabled(loadGolemVisible()) }, [])

  const toggle = () => {
    const next = !enabled
    setEnabled(next)
    saveGolemVisible(next)
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay }}
      className="flex items-center gap-3 rounded-lg border border-border bg-surface-secondary p-4"
    >
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded border border-border bg-background">
        <Bot className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[12px] font-medium text-foreground">Show Golem</p>
        <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
          The mascot drifts around the app. Turn off to hide it everywhere.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Show Golem"
        onClick={toggle}
        className={`relative h-5 w-9 flex-shrink-0 rounded-full border transition-colors ${
          enabled ? 'border-primary/40 bg-primary/25' : 'border-border bg-surface-elevated'
        }`}
      >
        <span
          className={`absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full transition-all ${
            enabled ? 'left-[18px] bg-primary' : 'left-[2px] bg-muted-foreground'
          }`}
        />
      </button>
    </motion.div>
  )
}

function GeneralTab() {
  return (
    <div className="space-y-5">
      <MascotToggleCard delay={0.05} />
      <SettingsSectionCard icon={User} title="Account" description="Profile details, email, and password management." delay={0.1} />
      <SettingsSectionCard icon={Sliders} title="Preferences" description="Theme, notifications, default behaviors, and keyboard shortcuts." delay={0.15} />
      <SettingsSectionCard icon={Cpu} title="AI & Model Settings" description="Default model, effort level, focus mode, and reasoning trace depth." delay={0.2} />
    </div>
  )
}

// Connectors: connect/disconnect cards for Composio-backed tools (Gmail,
// Firecrawl). Tokens never touch this app — Composio hosts the OAuth
// consent screen and custodies the resulting credential; this UI only reads/
// writes connection status. composio_search is always available (no auth).
function ConnectorsSection() {
  const searchParams = useSearchParams()
  const [connections, setConnections] = useState<Record<string, ComposioConnection | null>>({
    gmail: null,
    firecrawl: null,
  })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    const res = await fetch('/api/composio/connections')
    const data = await res.json()
    const map: Record<string, ComposioConnection | null> = { gmail: null, firecrawl: null }
    for (const c of (data.connections ?? []) as ComposioConnection[]) map[c.toolkit] = c
    setConnections(map)
    setLoading(false)
  }, [])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [load])

  // Surface the redirect result from /api/composio/callback once, then drop
  // it from view (the connections list itself is the source of truth after).
  useEffect(() => {
    const connected = searchParams.get('composio_connected')
    const err = searchParams.get('composio_error')
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (connected) setBanner({ ok: true, text: `${TOOLKIT_META[connected]?.label ?? connected} connected.` })
    else if (err) setBanner({ ok: false, text: `Connection failed (${err}). Try again.` })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [lastDiagnostic, setLastDiagnostic] = useState<Record<string, unknown> | null>(null)
  const [diagnosing, setDiagnosing] = useState(false)

  const runDiagnostic = async (toolkit: string) => {
    setDiagnosing(true); setBanner(null); setLastDiagnostic(null)
    try {
      const res = await fetch('/api/composio/diagnose', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolkit }),
      })
      const data = await res.json()
      setLastDiagnostic(data.report ?? data)
    } catch (e) {
      setLastDiagnostic({ error: String(e) })
    } finally {
      setDiagnosing(false)
    }
  }

  const connect = async (toolkit: ComposioToolkit) => {
    setBusy(toolkit); setBanner(null); setLastDiagnostic(null)
    try {
      const res = await fetch('/api/composio/connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolkit }),
      })
      const data = await res.json()
      if (!res.ok) {
        setBanner({ ok: false, text: data.error ?? 'Could not start connection' })
        if (data.diagnostic) setLastDiagnostic(data.diagnostic)
        setBusy(null)
        return
      }
      window.location.assign(data.redirect_url)
    } catch {
      setBanner({ ok: false, text: 'Could not start connection' }); setBusy(null)
    }
  }

  const disconnect = async (toolkit: ComposioToolkit) => {
    setBusy(toolkit); setBanner(null)
    try {
      const res = await fetch('/api/composio/disconnect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolkit }),
      })
      const data = await res.json()
      if (!res.ok) { setBanner({ ok: false, text: data.error ?? 'Could not disconnect' }); return }
      await load()
    } finally { setBusy(null) }
  }

  return (
    <div>
      {banner && (
        <div className={`mb-3 flex items-start gap-2 rounded border px-3 py-2 ${banner.ok ? 'border-primary/30 bg-primary/5' : 'border-destructive/40 bg-destructive/10'}`}>
          {banner.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-primary" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-destructive" />}
          <span className={`font-mono text-[11px] ${banner.ok ? 'text-foreground/90' : 'text-destructive'}`}>{banner.text}</span>
        </div>
      )}

      {lastDiagnostic && (
        <div className="mb-3 rounded border border-destructive/40 bg-destructive/5 p-2">
          <p className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-destructive">Diagnostic</p>
          <pre className="max-h-40 overflow-auto font-mono text-[9px] leading-relaxed text-destructive/90 whitespace-pre-wrap break-all">
            {JSON.stringify(lastDiagnostic, null, 2)}
          </pre>
        </div>
      )}

      <div className="space-y-2">
        {(Object.keys(TOOLKIT_META) as string[]).map((tk) => {
          const meta = TOOLKIT_META[tk]
          if (!meta) return null
          const Icon = meta.icon
          const isAlwaysAvailable = ALWAYS_AVAILABLE_TOOLKITS.has(tk)
          const conn = connections[tk]
          const status: ConnectionStatus = conn?.status ?? 'disconnected'
          const isBusy = busy === tk

          return (
            <div key={tk} className="flex items-center gap-3 rounded-lg border border-border bg-surface-secondary p-4">
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded border border-border bg-background">
                <Icon className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="font-mono text-[12px] text-foreground">{meta.label}</p>
                  {loading ? (
                    <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                  ) : isAlwaysAvailable ? (
                    <span className="flex items-center gap-1 rounded border border-primary/30 bg-primary/5 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-primary"><CheckCircle2 className="h-2.5 w-2.5" /> always available</span>
                  ) : status === 'connected' ? (
                    <span className="flex items-center gap-1 rounded border border-primary/30 bg-primary/5 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-primary"><CheckCircle2 className="h-2.5 w-2.5" /> connected</span>
                  ) : status === 'pending' ? (
                    <span className="flex items-center gap-1 rounded border border-warning/30 bg-warning/5 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-warning"><Loader2 className="h-2.5 w-2.5 animate-spin" /> pending</span>
                  ) : status === 'error' ? (
                    <span className="flex items-center gap-1 rounded border border-destructive/30 bg-destructive/5 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-destructive"><AlertTriangle className="h-2.5 w-2.5" /> error</span>
                  ) : null}
                </div>
                <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{meta.desc}</p>
              </div>
              <div className="flex flex-shrink-0 items-center gap-2">
                {!isAlwaysAvailable && (
                  <>
                    <button onClick={() => runDiagnostic(tk)} disabled={diagnosing || isBusy || loading}
                      className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40">
                      {diagnosing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Diagnose
                    </button>
                    {status === 'connected' ? (
                      <button onClick={() => disconnect(tk as ComposioToolkit)} disabled={isBusy}
                        className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-destructive disabled:opacity-40">
                        {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2Off className="h-3.5 w-3.5" />} Disconnect
                      </button>
                    ) : (
                      <button onClick={() => connect(tk as ComposioToolkit)} disabled={isBusy || loading}
                        className="flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-3 py-1.5 font-mono text-[11px] text-primary transition-colors hover:bg-primary/20 disabled:opacity-40">
                        {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Connect
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <p className="mt-3 font-mono text-[9px] leading-relaxed text-muted-foreground/70">
        Gmail and Firecrawl use Composio for connection management — credentials never pass through Golem. Web Search is always available and requires no authentication.
      </p>
    </div>
  )
}

// ── School credentials section ──────────────────────────────────────────────

function SchoolSection() {
  const searchParams = useSearchParams()
  const [icBusy, setIcBusy] = useState(false)
  const [classroomBusy, setClassroomBusy] = useState(false)
  const [icHasCreds, setIcHasCreds] = useState(false)
  const [classroomConnected, setClassroomConnected] = useState(false)
  const [icUsername, setIcUsername] = useState('')
  const [icPassword, setIcPassword] = useState('')
  const [icShowForm, setIcShowForm] = useState(false)
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    fetch('/api/settings/ic-credentials')
      .then((r) => r.json())
      .then((d) => setIcHasCreds(d.has_credentials))
      .catch(() => {})

    fetch('/api/settings/classroom-status')
      .then((r) => r.json())
      .then((d) => setClassroomConnected(d.connected))
      .catch(() => {})
  }, [])

  useEffect(() => {
    const connected = searchParams.get('classroom_connected')
    const err = searchParams.get('classroom_error')
    if (connected) {
      setClassroomConnected(true)
      setBanner({ ok: true, text: 'Google Classroom connected successfully.' })
    } else if (err) {
      setBanner({ ok: false, text: `Classroom connection failed (${err}). Try again.` })
    }
  }, [searchParams])

  const saveIC = async () => {
    if (!icUsername.trim() || !icPassword.trim()) return
    setIcBusy(true)
    try {
      const res = await fetch('/api/settings/ic-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: icUsername, password: icPassword }),
      })
      if (res.ok) {
        setIcHasCreds(true)
        setIcShowForm(false)
        setIcPassword('')
        setBanner({ ok: true, text: 'Infinite Campus credentials saved.' })
      } else {
        const d = await res.json()
        setBanner({ ok: false, text: d.error ?? 'Failed to save credentials.' })
      }
    } catch {
      setBanner({ ok: false, text: 'Failed to save credentials.' })
    } finally {
      setIcBusy(false)
    }
  }

  const removeIC = async () => {
    setIcBusy(true)
    try {
      await fetch('/api/settings/ic-credentials', { method: 'DELETE' })
      setIcHasCreds(false)
      setBanner({ ok: true, text: 'Infinite Campus credentials removed.' })
    } catch {
      setBanner({ ok: false, text: 'Failed to remove credentials.' })
    } finally {
      setIcBusy(false)
    }
  }

  const connectClassroom = async () => {
    setClassroomBusy(true)
    try {
      const res = await fetch('/api/settings/classroom-connect', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        setBanner({ ok: false, text: data.error ?? 'Could not start connection.' })
        setClassroomBusy(false)
        return
      }
      window.location.assign(data.redirect_url)
    } catch {
      setBanner({ ok: false, text: 'Could not start connection.' })
      setClassroomBusy(false)
    }
  }

  return (
    <div>
      {banner && (
        <div className={`mb-3 flex items-start gap-2 rounded border px-3 py-2 ${banner.ok ? 'border-primary/30 bg-primary/5' : 'border-destructive/40 bg-destructive/10'}`}>
          {banner.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-primary" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-destructive" />}
          <span className={`font-mono text-[11px] ${banner.ok ? 'text-foreground/90' : 'text-destructive'}`}>{banner.text}</span>
        </div>
      )}

      <div className="space-y-2">
        {/* Infinite Campus */}
        <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-secondary p-4">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded border border-border bg-background">
            <School className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="font-mono text-[12px] text-foreground">Infinite Campus</p>
              {icHasCreds ? (
                <span className="flex items-center gap-1 rounded border border-primary/30 bg-primary/5 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-primary"><CheckCircle2 className="h-2.5 w-2.5" /> configured</span>
              ) : null}
            </div>
            <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
              APS student portal — assignments, grades, announcements. Your login is encrypted at rest.
            </p>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            {icHasCreds ? (
              <button onClick={removeIC} disabled={icBusy}
                className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-destructive disabled:opacity-40">
                {icBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />} Remove
              </button>
            ) : icShowForm ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="Username"
                  value={icUsername}
                  onChange={(e) => setIcUsername(e.target.value)}
                  className="w-28 rounded border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground placeholder:text-muted-foreground/50"
                />
                <input
                  type="password"
                  placeholder="Password"
                  value={icPassword}
                  onChange={(e) => setIcPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveIC()}
                  className="w-28 rounded border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground placeholder:text-muted-foreground/50"
                />
                <button onClick={saveIC} disabled={icBusy}
                  className="flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-3 py-1.5 font-mono text-[11px] text-primary transition-colors hover:bg-primary/20 disabled:opacity-40">
                  {icBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Key className="h-3.5 w-3.5" />} Save
                </button>
              </div>
            ) : (
              <button onClick={() => setIcShowForm(true)}
                className="flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-3 py-1.5 font-mono text-[11px] text-primary transition-colors hover:bg-primary/20">
                <Key className="h-3.5 w-3.5" /> Configure
              </button>
            )}
          </div>
        </div>

        {/* Google Classroom */}
        <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-secondary p-4">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded border border-border bg-background">
            <GraduationCap className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="font-mono text-[12px] text-foreground">Google Classroom</p>
              {classroomConnected ? (
                <span className="flex items-center gap-1 rounded border border-primary/30 bg-primary/5 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-primary"><CheckCircle2 className="h-2.5 w-2.5" /> connected</span>
              ) : null}
            </div>
            <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
              Assignments, due dates, and announcements. Read-only — Golem never modifies anything.
            </p>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <button onClick={connectClassroom} disabled={classroomBusy}
              className={`flex items-center gap-1.5 rounded border px-3 py-1.5 font-mono text-[11px] transition-colors disabled:opacity-40 ${
                classroomConnected
                  ? 'border-border text-muted-foreground hover:text-foreground'
                  : 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
              }`}>
              {classroomBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {classroomConnected ? 'Reconnect' : 'Connect'}
            </button>
          </div>
        </div>
      </div>
      <p className="mt-3 font-mono text-[9px] leading-relaxed text-muted-foreground/70">
        Each user connects their own school accounts. Credentials are encrypted at rest and never exposed to other users or the client. Golem only reads — no submissions or modifications.
      </p>
    </div>
  )
}

// ── Tabs (Batch: Memory+Settings merge) ─────────────────────────────────────
// Same pattern as /resources/saved: a TABS array driving role="tab" buttons,
// active tab synced to a `?tab=` query param via router.replace.

type SettingsTabId = 'general' | 'memory' | 'connectors' | 'school'

const TABS: { id: SettingsTabId; label: string; icon: typeof Settings }[] = [
  { id: 'general', label: 'General', icon: Sliders },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'connectors', label: 'Connectors', icon: Puzzle },
  { id: 'school', label: 'School', icon: GraduationCap },
]

function SettingsPageContent() {
  const searchParams = useSearchParams()
  const router = useRouter()

  const rawTab = searchParams.get('tab')
  const validTabs = new Set<string>(TABS.map((t) => t.id))
  const activeTab = (validTabs.has(rawTab ?? '') ? rawTab : 'general') as SettingsTabId

  return (
    <div className="relative flex min-h-screen flex-col bg-transparent">
      <div className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute inset-0 grid-overlay opacity-30" />
        <div
          className="absolute inset-0"
          style={{
            background: 'radial-gradient(ellipse at center, transparent 0%, rgba(8,8,8,0.6) 100%)',
          }}
        />
      </div>

      <div className="relative z-10 mx-auto w-full max-w-2xl px-6 py-12">
        <Link
          href="/"
          className="mb-8 inline-flex items-center gap-2 font-mono text-xs text-muted-foreground transition-colors hover:text-primary"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          back to golem
        </Link>

        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6"
        >
          <div className="flex items-center gap-3 mb-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-primary/30 bg-primary/10">
              <Settings className="h-4 w-4 text-primary" />
            </div>
            <div>
              <h1 className="font-display text-2xl font-bold leading-tight text-foreground">Settings</h1>
              <p className="font-mono text-xs text-muted-foreground">Account, preferences, connectors, and memory</p>
            </div>
          </div>
        </motion.div>

        <div
          className="mb-6 flex overflow-x-auto border-b border-border/50 scrollbar-hidden"
          role="tablist"
          aria-label="Settings sections"
          onKeyDown={(e) => {
            const idx = TABS.findIndex((t) => t.id === activeTab)
            let next = idx
            if (e.key === 'ArrowRight') next = (idx + 1) % TABS.length
            else if (e.key === 'ArrowLeft') next = (idx - 1 + TABS.length) % TABS.length
            else return
            e.preventDefault()
            router.replace(`/settings?tab=${TABS[next].id}`)
          }}
        >
          {TABS.map((tab) => {
            const Icon = tab.icon
            const active = activeTab === tab.id
            return (
              <button
                key={tab.id}
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={() => router.replace(`/settings?tab=${tab.id}`)}
                className={`relative flex flex-shrink-0 items-center gap-1.5 px-4 py-2.5 font-mono text-[11px] whitespace-nowrap transition-colors duration-200 ${
                  active ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon className="h-3 w-3" />
                {tab.label}
                {active && (
                  <motion.div
                    layoutId="settings-tab-indicator"
                    className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary"
                    transition={{ type: 'spring', stiffness: 300, damping: 28 }}
                  />
                )}
              </button>
            )
          })}
        </div>

        {activeTab === 'general' && <GeneralTab />}
        {activeTab === 'memory' && <MemoryTab />}
        {activeTab === 'connectors' && <ConnectorsSection />}
        {activeTab === 'school' && <SchoolSection />}
      </div>
    </div>
  )
}

export default function SettingsPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    }>
      <SettingsPageContent />
    </Suspense>
  )
}
