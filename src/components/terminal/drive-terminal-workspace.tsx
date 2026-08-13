'use client'

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { GripVertical, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, Plus, RotateCcw, Search, TerminalSquare, Trash2, X } from 'lucide-react'
import { TerminalPane } from './terminal-pane'

export interface DriveTerminalWorkspaceHandle {
  createTerminal: () => void
}

interface TerminalRecord {
  id: string
  name: string
  cwd: string
  createdAt: number
  autoName: boolean
}

type SplitDirection = 'vertical' | 'horizontal'
type PaneNode = { kind: 'pane'; id: string; terminalIds: string[]; activeId: string }
type SplitNode = { kind: 'split'; id: string; direction: SplitDirection; ratio: number; first: LayoutNode; second: LayoutNode; collapsed?: 'first' | 'second' }
type LayoutNode = PaneNode | SplitNode

interface PersistedWorkspace {
  version: 3
  records: TerminalRecord[]
  closed: TerminalRecord[]
  layout: LayoutNode | null
  focusedPaneId: string | null
}

const STORAGE_KEY = 'golem.drive.terminals.v3'
const LEGACY_STORAGE_KEY = 'golem.drive.terminals.v2'
const MIN_RATIO = 0.16
const MAX_RATIO = 0.84
const MAX_CLOSED = 20

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function isRecord(value: unknown): value is TerminalRecord {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<TerminalRecord>
  return typeof v.id === 'string' && typeof v.name === 'string' && typeof v.cwd === 'string'
}

function isLayout(value: unknown): value is LayoutNode {
  if (!value || typeof value !== 'object') return false
  const v = value as { kind?: string; id?: unknown; activeId?: unknown; terminalIds?: unknown; terminalId?: unknown; first?: unknown; second?: unknown }
  if (v.kind === 'pane') return typeof v.id === 'string' && Array.isArray(v.terminalIds) && v.terminalIds.every((id) => typeof id === 'string') && typeof v.activeId === 'string'
  if (v.kind === 'leaf') return typeof v.terminalId === 'string'
  return v.kind === 'split' && typeof v.id === 'string' && isLayout(v.first) && isLayout(v.second)
}

function paneIds(node: LayoutNode | null, out: string[] = []): string[] {
  if (!node) return out
  if (node.kind === 'pane') out.push(node.id)
  else {
    paneIds(node.first, out)
    paneIds(node.second, out)
  }
  return out
}

function paneForTerminal(node: LayoutNode | null, terminalId: string): PaneNode | null {
  if (!node) return null
  if (node.kind === 'pane') return node.terminalIds.includes(terminalId) ? node : null
  return paneForTerminal(node.first, terminalId) ?? paneForTerminal(node.second, terminalId)
}

function firstPane(node: LayoutNode | null): PaneNode | null {
  if (!node) return null
  return node.kind === 'pane' ? node : firstPane(node.first)
}

function findPane(node: LayoutNode | null, id: string): PaneNode | null {
  if (!node) return null
  if (node.kind === 'pane') return node.id === id ? node : null
  return findPane(node.first, id) ?? findPane(node.second, id)
}

function updatePane(node: LayoutNode | null, paneId: string, update: (pane: PaneNode) => PaneNode): LayoutNode | null {
  if (!node) return null
  if (node.kind === 'pane') return node.id === paneId ? update(node) : node
  return { ...node, first: updatePane(node.first, paneId, update)!, second: updatePane(node.second, paneId, update)! }
}

function updateSplit(node: LayoutNode | null, splitId: string, update: (split: SplitNode) => SplitNode): LayoutNode | null {
  if (!node) return null
  if (node.kind === 'pane') return node
  if (node.id === splitId) return update(node)
  return { ...node, first: updateSplit(node.first, splitId, update)!, second: updateSplit(node.second, splitId, update)! }
}

function addTerminalToPane(node: LayoutNode | null, paneId: string | null, terminalId: string): LayoutNode | null {
  if (!node || !paneId) return node
  return updatePane(node, paneId, (pane) => ({ ...pane, terminalIds: [...pane.terminalIds.filter((id) => id !== terminalId), terminalId], activeId: terminalId }))
}

function setPaneActive(node: LayoutNode | null, paneId: string, terminalId: string): LayoutNode | null {
  return updatePane(node, paneId, (pane) => pane.terminalIds.includes(terminalId) ? { ...pane, activeId: terminalId } : pane)
}

function splitPane(node: LayoutNode | null, paneId: string | null, terminalId: string, direction: SplitDirection, newPaneId = makeId('pane')): LayoutNode {
  if (!node) return { kind: 'pane', id: newPaneId, terminalIds: [terminalId], activeId: terminalId }
  if (node.kind === 'pane') {
    if (node.id !== paneId) return node
    return {
      kind: 'split',
      id: makeId('split'),
      direction,
      ratio: 0.5,
      first: node,
      second: { kind: 'pane', id: newPaneId, terminalIds: [terminalId], activeId: terminalId },
    }
  }
  if (paneId && findPane(node.first, paneId)) return { ...node, first: splitPane(node.first, paneId, terminalId, direction, newPaneId) }
  return { ...node, second: splitPane(node.second, paneId, terminalId, direction, newPaneId) }
}

function removeTerminal(node: LayoutNode | null, terminalId: string): LayoutNode | null {
  if (!node) return null
  if (node.kind === 'pane') {
    if (!node.terminalIds.includes(terminalId)) return node
    const terminalIds = node.terminalIds.filter((id) => id !== terminalId)
    if (terminalIds.length === 0) return null
    return { ...node, terminalIds, activeId: node.activeId === terminalId ? terminalIds[0] : node.activeId }
  }
  const first = removeTerminal(node.first, terminalId)
  const second = removeTerminal(node.second, terminalId)
  return first && second ? { ...node, first, second } : first ?? second
}

function removePane(node: LayoutNode | null, paneId: string): LayoutNode | null {
  if (!node) return null
  if (node.kind === 'pane') return node.id === paneId ? null : node
  const first = node.first.kind === 'pane' && node.first.id === paneId ? null : removePane(node.first, paneId)
  const second = node.second.kind === 'pane' && node.second.id === paneId ? null : removePane(node.second, paneId)
  return first && second ? { ...node, first, second } : first ?? second
}

function collapseContaining(node: LayoutNode | null, paneId: string): LayoutNode | null {
  if (!node || node.kind === 'pane') return node
  if (findPane(node.first, paneId)) return { ...node, collapsed: 'first' }
  if (findPane(node.second, paneId)) return { ...node, collapsed: 'second' }
  return { ...node, first: collapseContaining(node.first, paneId)!, second: collapseContaining(node.second, paneId)! }
}

function restoreSplit(node: LayoutNode | null, splitId: string): LayoutNode | null {
  return updateSplit(node, splitId, (split) => ({ ...split, collapsed: undefined }))
}

function normalizeLayout(node: LayoutNode | null, validIds: Set<string>, seen = new Set<string>()): LayoutNode | null {
  if (!node) return null
  if (node.kind === 'pane') {
    const terminalIds = node.terminalIds.filter((id) => validIds.has(id) && !seen.has(id))
    terminalIds.forEach((id) => seen.add(id))
    if (terminalIds.length === 0) return null
    return { ...node, terminalIds, activeId: terminalIds.includes(node.activeId) ? node.activeId : terminalIds[0] }
  }
  const first = normalizeLayout(node.first, validIds, seen)
  const second = normalizeLayout(node.second, validIds, seen)
  if (!first) return second
  if (!second) return first
  return {
    ...node,
    ratio: Math.max(MIN_RATIO, Math.min(MAX_RATIO, typeof node.ratio === 'number' ? node.ratio : 0.5)),
    first,
    second,
    collapsed: node.collapsed === 'first' || node.collapsed === 'second' ? node.collapsed : undefined,
  }
}

function migrateLegacyLayout(value: unknown, validIds: Set<string>, order: string[]): LayoutNode | null {
  if (!value || typeof value !== 'object') return null
  const v = value as { kind?: string; id?: string; terminalId?: string; first?: unknown; second?: unknown; direction?: SplitDirection; ratio?: number; collapsed?: 'first' | 'second' }
  if (v.kind === 'leaf' && typeof v.terminalId === 'string') {
    return { kind: 'pane', id: makeId('pane'), terminalIds: [v.terminalId], activeId: v.terminalId }
  }
  if (v.kind === 'pane' && isLayout(value)) return value
  if (v.kind === 'split') {
    const first = migrateLegacyLayout(v.first, validIds, order)
    const second = migrateLegacyLayout(v.second, validIds, order)
    if (!first) return second
    if (!second) return first
    return { kind: 'split', id: typeof v.id === 'string' ? v.id : makeId('split'), direction: v.direction === 'horizontal' ? 'horizontal' : 'vertical', ratio: typeof v.ratio === 'number' ? v.ratio : 0.5, first, second, collapsed: v.collapsed }
  }
  return validIds.size > 0 ? { kind: 'pane', id: makeId('pane'), terminalIds: order.filter((id) => validIds.has(id)), activeId: order.find((id) => validIds.has(id)) ?? [...validIds][0] } : null
}

function ensureAllRecordsInLayout(node: LayoutNode | null, records: TerminalRecord[], order: string[]): LayoutNode | null {
  const existing = new Set<string>()
  function collect(current: LayoutNode | null) {
    if (!current) return
    if (current.kind === 'pane') current.terminalIds.forEach((id) => existing.add(id))
    else { collect(current.first); collect(current.second) }
  }
  collect(node)
  const missing = order.filter((id) => records.some((record) => record.id === id) && !existing.has(id))
  if (missing.length === 0) return node
  const target = firstPane(node)
  if (target) return updatePane(node, target.id, (pane) => ({ ...pane, terminalIds: [...pane.terminalIds, ...missing] }))
  return records.length > 0 ? { kind: 'pane', id: makeId('pane'), terminalIds: missing, activeId: missing[0] } : null
}

async function createBackendSession(cwd?: string): Promise<{ id: string; cwd: string }> {
  const res = await fetch('/api/terminal/pty', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cols: 80, rows: 24, ...(cwd ? { cwd } : {}) }),
  })
  const data = await res.json().catch(() => ({})) as { id?: string; cwd?: string; error?: string }
  if (!res.ok || !data.id) throw new Error(data.error || `Terminal failed to open (HTTP ${res.status})`)
  return { id: data.id, cwd: data.cwd ?? cwd ?? '' }
}

function ResizableSplit({ node, renderNode, onRatio, onExpand }: {
  node: SplitNode
  renderNode: (node: LayoutNode) => ReactNode
  onRatio: (ratio: number) => void
  onExpand: () => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const vertical = node.direction === 'vertical'
  useEffect(() => {
    if (!dragging) return
    const move = (event: PointerEvent) => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      const position = vertical ? event.clientX - rect.left : event.clientY - rect.top
      const size = vertical ? rect.width : rect.height
      if (size > 0) onRatio(Math.max(MIN_RATIO, Math.min(MAX_RATIO, position / size)))
    }
    const up = () => setDragging(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = vertical ? 'col-resize' : 'row-resize'
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [dragging, onRatio, vertical])
  if (node.collapsed) {
    return (
      <div ref={rootRef} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {renderNode(node.collapsed === 'first' ? node.second : node.first)}
        <button onClick={onExpand} title="Restore collapsed pane" className="absolute bottom-2 right-2 z-10 flex items-center gap-1 rounded border border-primary/30 bg-surface-elevated/95 px-2 py-1 font-mono text-[9px] text-primary shadow-lg">
          <PanelLeftOpen className="h-3 w-3" /> Restore pane
        </button>
      </div>
    )
  }
  return (
    <div ref={rootRef} className={`flex min-h-0 min-w-0 flex-1 overflow-hidden ${vertical ? 'flex-row' : 'flex-col'}`}>
      <div className="flex min-h-0 min-w-0 overflow-hidden" style={{ flex: `0 0 ${node.ratio * 100}%` }}>{renderNode(node.first)}</div>
      <div
        role="separator"
        aria-orientation={vertical ? 'vertical' : 'horizontal'}
        aria-label="Resize terminal panes"
        tabIndex={0}
        onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
          event.preventDefault()
          setDragging(true)
        }}
        onKeyDown={(event) => {
          const delta = vertical
            ? (event.key === 'ArrowRight' ? 0.03 : event.key === 'ArrowLeft' ? -0.03 : 0)
            : (event.key === 'ArrowDown' ? 0.03 : event.key === 'ArrowUp' ? -0.03 : 0)
          if (delta) {
            event.preventDefault()
            onRatio(Math.max(MIN_RATIO, Math.min(MAX_RATIO, node.ratio + delta)))
          }
        }}
        className={`group relative z-10 flex shrink-0 items-center justify-center border-border bg-surface-secondary transition-colors focus:outline-none focus:ring-1 focus:ring-primary ${vertical ? 'w-2 cursor-col-resize border-x' : 'h-2 cursor-row-resize border-y'} ${dragging ? 'bg-primary/20' : 'hover:bg-primary/10'}`}
      >
        <GripVertical className={`${vertical ? 'h-4 w-4' : 'h-3 w-5 rotate-90'} text-muted-foreground/60 group-hover:text-primary`} />
      </div>
      <div className="flex min-h-0 min-w-0 overflow-hidden" style={{ flex: `0 0 ${(1 - node.ratio) * 100}%` }}>{renderNode(node.second)}</div>
    </div>
  )
}

export const DriveTerminalWorkspace = forwardRef<DriveTerminalWorkspaceHandle, { onCountChange?: (count: number) => void }>(function DriveTerminalWorkspace({ onCountChange }, ref) {
  const [records, setRecords] = useState<TerminalRecord[]>([])
  const [closed, setClosed] = useState<TerminalRecord[]>([])
  const [layout, setLayout] = useState<LayoutNode | null>(null)
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [hydrated, setHydrated] = useState(false)
  const [maximizedPaneId, setMaximizedPaneId] = useState<string | null>(null)
  const [clearSignals, setClearSignals] = useState<Record<string, number>>({})
  const [status, setStatus] = useState<Record<string, 'idle' | 'active'>>({})
  const [fullscreen, setFullscreen] = useState(false)

  const recordById = useMemo(() => new Map(records.map((record) => [record.id, record])), [records])
  const focusedPane = useMemo(() => findPane(layout, focusedPaneId ?? '') ?? firstPane(layout), [focusedPaneId, layout])
  const activeTerminalId = focusedPane?.activeId ?? null

  const visibleIds = useMemo(() => {
    const q = search.trim().toLowerCase()
    return new Set(records.filter((record) => !q || record.name.toLowerCase().includes(q) || record.cwd.toLowerCase().includes(q)).map((record) => record.id))
  }, [records, search])

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY)
      if (raw) {
        const saved = JSON.parse(raw) as Partial<PersistedWorkspace> & { order?: unknown[] }
        const savedRecords = Array.isArray(saved.records) ? saved.records.filter(isRecord) : []
        const ids = new Set(savedRecords.map((record) => record.id))
        const order = Array.isArray(saved.order) ? saved.order.filter((id): id is string => typeof id === 'string' && ids.has(id)) : savedRecords.map((record) => record.id)
        const migrated = migrateLegacyLayout(saved.layout, ids, [...order, ...savedRecords.map((record) => record.id).filter((id) => !order.includes(id))])
        const normalized = normalizeLayout(migrated, ids)
        // Hydration intentionally seeds several state atoms from external
        // localStorage state in one pass.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setRecords(savedRecords)
        setClosed(Array.isArray(saved.closed) ? saved.closed.filter(isRecord) : [])
        setLayout(ensureAllRecordsInLayout(normalized, savedRecords, [...order, ...savedRecords.map((record) => record.id).filter((id) => !order.includes(id))]))
        setFocusedPaneId(typeof saved.focusedPaneId === 'string' ? saved.focusedPaneId : firstPane(normalized)?.id ?? null)
      }
    } catch {
      /* malformed or inaccessible local state is treated as a fresh workspace */
    }
    setHydrated(true)
  }, [])

  // Reconnect persisted PTYs without invalidating the layout if only one
  // session disappeared. Each replacement is applied to records and panes.
  useEffect(() => {
    if (!hydrated || records.length === 0) return
    let cancelled = false
    void (async () => {
      const replacements = new Map<string, { id: string; cwd: string }>()
      for (const record of records) {
        try {
          const probe = await fetch(`/api/terminal/pty/${encodeURIComponent(record.id)}?probe=1`)
          if (!probe.ok) replacements.set(record.id, await createBackendSession(record.cwd))
        } catch {
          /* transient failures leave the existing id for EventSource retry */
        }
      }
      if (cancelled || replacements.size === 0) return
      setRecords((current) => current.map((record) => {
        const replacement = replacements.get(record.id)
        return replacement ? { ...record, id: replacement.id, cwd: replacement.cwd } : record
      }))
      setLayout((current) => {
        let next = current
        for (const [from, replacement] of replacements) {
          next = updatePane(next, paneForTerminal(next, from)?.id ?? '', (pane) => ({ ...pane, terminalIds: pane.terminalIds.map((id) => id === from ? replacement.id : id), activeId: pane.activeId === from ? replacement.id : pane.activeId }))
        }
        return next
      })
    })()
    return () => { cancelled = true }
  // The probe effect intentionally keys on the record count: record IDs are
  // replaced inside the effect, and including the full array would retrigger
  // probes indefinitely after each successful reconnect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, records.length])

  useEffect(() => { onCountChange?.(records.length) }, [onCountChange, records.length])

  useEffect(() => {
    if (!hydrated) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 3, records, closed, layout, focusedPaneId } satisfies PersistedWorkspace))
    } catch {
      /* optional persistence */
    }
  }, [closed, focusedPaneId, hydrated, layout, records])

  const createTerminal = useCallback(async (options?: { cwd?: string; name?: string; autoName?: boolean; split?: SplitDirection; paneId?: string }) => {
    try {
      const created = await createBackendSession(options?.cwd)
      const record: TerminalRecord = { id: created.id, name: options?.name ?? 'bash', cwd: created.cwd, createdAt: Date.now(), autoName: options?.autoName ?? true }
      const targetPaneId = options?.paneId ?? focusedPane?.id ?? firstPane(layout)?.id ?? null
      const newPaneId = options?.split ? makeId('pane') : null
      setRecords((current) => [...current, record])
      setLayout((current) => {
        if (options?.split) return splitPane(current, targetPaneId, record.id, options.split, newPaneId ?? undefined)
        return targetPaneId ? addTerminalToPane(current, targetPaneId, record.id) : { kind: 'pane', id: newPaneId ?? makeId('pane'), terminalIds: [record.id], activeId: record.id }
      })
      setFocusedPaneId(newPaneId ?? targetPaneId)
    } catch (error) {
      console.error('[drive terminals] create failed:', error)
    }
  }, [focusedPane, layout])

  useImperativeHandle(ref, () => ({ createTerminal: () => { void createTerminal() } }), [createTerminal])

  const closeTerminal = useCallback((id: string) => {
    const record = recordById.get(id)
    if (!record) return
    setClosed((current) => [record, ...current.filter((item) => item.id !== id)].slice(0, MAX_CLOSED))
    setRecords((current) => current.filter((item) => item.id !== id))
    const nextLayout = removeTerminal(layout, id)
    setLayout(nextLayout)
    if (focusedPaneId && !findPane(nextLayout, focusedPaneId)) setFocusedPaneId(firstPane(nextLayout)?.id ?? null)
    void fetch(`/api/terminal/pty/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
  }, [focusedPaneId, layout, recordById])

  const closePane = useCallback((paneId: string) => {
    const pane = findPane(layout, paneId)
    if (!pane) return
    const otherPane = paneIds(layout).filter((id) => id !== paneId)[0]
    if (!otherPane) {
      window.alert('This is the only pane. Use Reset Layout to return it to the default workspace.')
      return
    }
    if (pane.terminalIds.length > 1 && !window.confirm(`Close this pane? Its ${pane.terminalIds.length} terminal tabs will move to the neighboring pane.`)) return
    const withoutPane = removePane(layout, paneId)
    const target = firstPane(withoutPane)
    const nextLayout = target ? updatePane(withoutPane, target.id, (current) => ({ ...current, terminalIds: [...current.terminalIds, ...pane.terminalIds], activeId: pane.activeId })) : withoutPane
    setLayout(nextLayout)
    setFocusedPaneId(target?.id ?? null)
    if (maximizedPaneId === paneId) setMaximizedPaneId(null)
  }, [layout, maximizedPaneId])

  const resetLayout = useCallback(() => {
    const keepId = activeTerminalId ?? records[0]?.id
    if (!keepId) return
    const keep = recordById.get(keepId)
    if (!keep) return
    const toClose = records.filter((record) => record.id !== keepId)
    if (toClose.length > 0 && !window.confirm(`Reset layout to one terminal? This closes ${toClose.length} other terminal sessions.`)) return
    for (const record of toClose) void fetch(`/api/terminal/pty/${encodeURIComponent(record.id)}`, { method: 'DELETE' }).catch(() => {})
    const paneId = makeId('pane')
    setRecords([keep])
    setClosed((current) => [...toClose, ...current.filter((item) => item.id !== keepId)].slice(0, MAX_CLOSED))
    setLayout({ kind: 'pane', id: paneId, terminalIds: [keep.id], activeId: keep.id })
    setFocusedPaneId(paneId)
    setMaximizedPaneId(null)
  }, [activeTerminalId, recordById, records])

  const resetWorkspace = useCallback(() => {
    if (records.length === 0) return
    if (!window.confirm(`Reset Command Workspace? This closes all ${records.length} terminal sessions.`)) return
    for (const record of records) void fetch(`/api/terminal/pty/${encodeURIComponent(record.id)}`, { method: 'DELETE' }).catch(() => {})
    setRecords([])
    setClosed([])
    setLayout(null)
    setFocusedPaneId(null)
    setMaximizedPaneId(null)
  }, [records])

  const reopenLast = useCallback(() => {
    const item = closed[0]
    if (!item) return
    setClosed((current) => current.slice(1))
    void createTerminal({ cwd: item.cwd, name: item.name, autoName: item.autoName })
  }, [closed, createTerminal])

  const restartTerminal = useCallback(async (id: string) => {
    const record = recordById.get(id)
    if (!record) return
    try {
      await fetch(`/api/terminal/pty/${encodeURIComponent(id)}`, { method: 'DELETE' })
      const created = await createBackendSession(record.cwd)
      setRecords((current) => current.map((item) => item.id === id ? { ...item, id: created.id, cwd: created.cwd, createdAt: Date.now() } : item))
      setLayout((current) => {
        const pane = paneForTerminal(current, id)
        return pane ? updatePane(current, pane.id, (currentPane) => ({ ...currentPane, terminalIds: currentPane.terminalIds.map((item) => item === id ? created.id : item), activeId: currentPane.activeId === id ? created.id : currentPane.activeId })) : current
      })
    } catch (error) {
      console.error('[drive terminals] restart failed:', error)
    }
  }, [recordById])

  const renameTerminal = useCallback((id: string) => {
    const record = recordById.get(id)
    if (!record) return
    const name = window.prompt('Terminal name', record.name)?.trim()
    if (name) setRecords((current) => current.map((item) => item.id === id ? { ...item, name, autoName: false } : item))
  }, [recordById])

  const duplicateTerminal = useCallback((id: string) => {
    const record = recordById.get(id)
    if (record) void createTerminal({ cwd: record.cwd, name: `${record.name} copy`, autoName: false })
  }, [createTerminal, recordById])

  const moveTerminalToNewPane = useCallback((id: string, direction: SplitDirection = 'vertical') => {
    const source = paneForTerminal(layout, id)
    if (!source) return
    if (source.terminalIds.length === 1) {
      // A lone terminal cannot be moved into a new pane without leaving an
      // empty pane. If a sibling exists, close the empty source pane and split
      // the remaining workspace around the moved terminal instead.
      const otherPaneId = paneIds(layout).find((paneId) => paneId !== source.id)
      if (!otherPaneId) return
      const without = removePane(layout, source.id)
      const next = splitPane(without, otherPaneId, id, direction)
      setLayout(next)
      setFocusedPaneId(paneForTerminal(next, id)?.id ?? otherPaneId)
      return
    }
    const without = removeTerminal(layout, id)
    const next = splitPane(without, source.id, id, direction)
    setLayout(next)
    setFocusedPaneId(paneForTerminal(next, id)?.id ?? source.id)
  }, [layout])

  const markActive = useCallback((paneId: string, terminalId?: string) => {
    setFocusedPaneId(paneId)
    if (terminalId) setLayout((current) => setPaneActive(current, paneId, terminalId))
    if (terminalId) {
      setStatus((current) => ({ ...current, [terminalId]: 'active' }))
      window.setTimeout(() => setStatus((current) => ({ ...current, [terminalId]: 'idle' })), 1200)
    }
  }, [])

  const splitTerminal = useCallback((paneId: string, direction: SplitDirection) => {
    if (!findPane(layout, paneId)) return
    void createTerminal({ split: direction, paneId })
  }, [createTerminal, layout])

  const updateRatio = useCallback((id: string, ratio: number) => {
    setLayout((current) => updateSplit(current, id, (split) => ({ ...split, ratio })))
  }, [])

  const collapsePane = useCallback((paneId: string) => setLayout((current) => collapseContaining(current, paneId)), [])
  const expandSplit = useCallback((splitId: string) => setLayout((current) => restoreSplit(current, splitId)), [])

  // Pane-maximize only reclaims space from sibling panes — the workspace itself
  // is still boxed in by the Forge header and the 240px sidebar, which is what
  // "fullscreen doesn't work" means. This escapes both.
  //
  // Two mechanisms on purpose: requestFullscreen() for the real thing, plus a
  // fixed-inset overlay because the Fullscreen API is refused outright in
  // sandboxed iframes and some PWA shells, and a refused promise would
  // otherwise leave the button doing nothing at all. The overlay alone already
  // fills the viewport, so the fallback is not a degraded mode — it just keeps
  // the browser chrome.
  const rootRef = useRef<HTMLDivElement>(null)
  const nativeFullscreenRef = useRef(false)

  const toggleFullscreen = useCallback(() => {
    const element = rootRef.current
    if (!element) return
    if (fullscreen) {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
      setFullscreen(false)
    } else {
      // Must stay inside the click's user-gesture window or the request is denied.
      void element.requestFullscreen?.().catch(() => {})
      setFullscreen(true)
    }
  }, [fullscreen])

  useEffect(() => {
    const onFullscreenChange = () => {
      const isNative = document.fullscreenElement === rootRef.current
      // Esc leaves native fullscreen without routing through the toggle. Only
      // react to *our* element leaving it, or an unrelated fullscreen exit
      // elsewhere on the page would tear down the fallback overlay.
      if (nativeFullscreenRef.current && !isNative) setFullscreen(false)
      nativeFullscreenRef.current = isNative
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  // Esc out of the fallback overlay. Native fullscreen already handles Esc
  // itself and never reaches here.
  useEffect(() => {
    if (!fullscreen) return
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.fullscreenElement) return
      event.preventDefault()
      setFullscreen(false)
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [fullscreen])

  // Maximizing a pane reclaims space from its SIBLINGS. With one pane there
  // are none, so both maximize buttons are literally no-ops — measured in a
  // real browser, the xterm screen stayed at exactly 1015x540 across the
  // click, while the workspace fullscreen button took it to 1253x594. Three
  // controls in the same toolbar row carry a maximize icon and two of them do
  // nothing in the common single-pane case; that is what "the fullscreen
  // button does nothing" was. So when there is nothing to maximize against,
  // fall through to the one control that can still make the terminal bigger.
  const paneCount = useMemo(() => paneIds(layout).length, [layout])
  const maximizePane = useCallback((paneId: string) => {
    if (paneCount < 2) {
      toggleFullscreen()
      return
    }
    setMaximizedPaneId((current) => current === paneId ? null : paneId)
  }, [paneCount, toggleFullscreen])

  const activeIdRef = useRef<string | null>(null)
  const focusedPaneRef = useRef<string | null>(null)
  const createRef = useRef(createTerminal)
  const closeRef = useRef(closeTerminal)
  const splitRef = useRef(splitTerminal)
  const fullscreenToggleRef = useRef(toggleFullscreen)
  useEffect(() => {
    activeIdRef.current = activeTerminalId
    focusedPaneRef.current = focusedPane?.id ?? null
    createRef.current = createTerminal
    closeRef.current = closeTerminal
    splitRef.current = splitTerminal
    fullscreenToggleRef.current = toggleFullscreen
  }, [activeTerminalId, closeTerminal, createTerminal, focusedPane?.id, splitTerminal, toggleFullscreen])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable
      const inXterm = target?.classList.contains('xterm-helper-textarea') || target?.classList.contains('xterm-helper')
      if ((!event.ctrlKey && !event.metaKey) || (inField && !inXterm)) return
      const key = event.key.toLowerCase()
      if (!event.shiftKey) return
      event.preventDefault()
      if (key === 't') void createRef.current()
      else if (key === 'w' && activeIdRef.current) closeRef.current(activeIdRef.current)
      else if (key === '5' && focusedPaneRef.current) splitRef.current(focusedPaneRef.current, 'vertical')
      else if (key === '9' && focusedPaneRef.current) splitRef.current(focusedPaneRef.current, 'horizontal')
      else if (key === 'enter') fullscreenToggleRef.current()
      else if (key === 'f') {
        setSearch((current) => current.trim() ? '' : ' ')
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-drive-terminal-search]')?.focus())
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const renderPane = (pane: PaneNode): ReactNode => {
    const active = pane.activeId
    const activeRecord = recordById.get(active)
    if (!activeRecord) return null
    const q = search.trim()
    const tabs = pane.terminalIds.filter((id) => visibleIds.has(id))
    return (
      <div className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-1 ${focusedPane?.id === pane.id ? 'ring-1 ring-inset ring-primary/20' : ''}`} onMouseDown={() => markActive(pane.id)}>
        <div className="flex min-h-7 shrink-0 items-center gap-1 rounded-t border border-border bg-surface-secondary px-1">
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto scrollbar-hidden">
            {tabs.map((id) => {
              const record = recordById.get(id)
              if (!record) return null
              return (
                <button key={id} onClick={() => markActive(pane.id, id)} onDoubleClick={() => renameTerminal(id)} title="Double-click to rename" className={`flex shrink-0 items-center gap-1 rounded px-2 py-1 font-mono text-[9px] ${id === active ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-surface-elevated hover:text-foreground'}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${status[id] === 'active' ? 'animate-pulse bg-primary' : 'bg-muted-foreground/40'}`} />
                  {record.name}
                  <span onClick={(event) => { event.stopPropagation(); closeTerminal(id) }} title="Close terminal" className="ml-0.5 rounded p-0.5 hover:bg-destructive/15 hover:text-destructive"><X className="h-2.5 w-2.5" /></span>
                </button>
              )
            })}
            {q && tabs.length === 0 && <span className="px-2 font-mono text-[9px] text-muted-foreground/50">No matching tabs</span>}
          </div>
          <button onClick={() => { void createTerminal() }} title="New terminal tab in this pane" className="rounded p-1 text-primary hover:bg-primary/10"><Plus className="h-3 w-3" /></button>
          <button onClick={() => splitTerminal(pane.id, 'vertical')} title="Split pane vertically" className="rounded px-1 font-mono text-[9px] text-muted-foreground hover:bg-primary/10 hover:text-primary">V</button>
          <button onClick={() => splitTerminal(pane.id, 'horizontal')} title="Split pane horizontally" className="rounded px-1 font-mono text-[9px] text-muted-foreground hover:bg-primary/10 hover:text-primary">H</button>
          <button onClick={() => moveTerminalToNewPane(active, 'vertical')} title="Move active terminal to a new pane" className="rounded p-1 text-muted-foreground hover:bg-primary/10 hover:text-primary"><PanelLeftOpen className="h-3 w-3" /></button>
          <button onClick={() => maximizePane(pane.id)} title={paneCount < 2 ? (fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen workspace — nothing to maximize against with one pane') : maximizedPaneId === pane.id ? 'Restore the other panes' : 'Maximize pane within the workspace'} className="rounded p-1 text-muted-foreground hover:bg-primary/10 hover:text-primary">{(paneCount < 2 ? fullscreen : maximizedPaneId === pane.id) ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}</button>
          <button onClick={() => closePane(pane.id)} title="Close pane; move its tabs to a neighboring pane" className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><PanelLeftClose className="h-3 w-3" /></button>
        </div>
        <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <TerminalPane
            id={activeRecord.id}
            cwd={activeRecord.cwd}
            name={activeRecord.name}
            clearSignal={clearSignals[activeRecord.id] ?? 0}
            onClose={() => closeTerminal(activeRecord.id)}
            onClosePane={() => closePane(pane.id)}
            onCommand={(command) => {
              const executable = command.trim().split(/\s+/)[0]
              if (executable) setRecords((current) => current.map((item) => item.id === activeRecord.id && item.autoName ? { ...item, name: executable } : item))
              markActive(pane.id, activeRecord.id)
            }}
            onOutput={() => markActive(pane.id, activeRecord.id)}
            onRename={() => renameTerminal(activeRecord.id)}
            onDuplicate={() => duplicateTerminal(activeRecord.id)}
            onRestart={() => { void restartTerminal(activeRecord.id) }}
            onKill={() => { void fetch(`/api/terminal/pty/${encodeURIComponent(activeRecord.id)}/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: '\u0003' }) }) }}
            onClear={() => setClearSignals((current) => ({ ...current, [activeRecord.id]: (current[activeRecord.id] ?? 0) + 1 }))}
            onSplitVertical={() => splitTerminal(pane.id, 'vertical')}
            onSplitHorizontal={() => splitTerminal(pane.id, 'horizontal')}
            onMoveToPane={() => moveTerminalToNewPane(activeRecord.id)}
            onCollapse={() => collapsePane(pane.id)}
            onMaximize={() => maximizePane(pane.id)}
            isMaximized={paneCount < 2 ? fullscreen : maximizedPaneId === pane.id}
            status={status[activeRecord.id] === 'active' ? 'active' : 'idle'}
          />
        </div>
      </div>
    )
  }

  const renderNode = (node: LayoutNode): ReactNode => {
    if (node.kind === 'pane') return renderPane(node)
    return <ResizableSplit node={node} renderNode={renderNode} onRatio={(ratio) => updateRatio(node.id, ratio)} onExpand={() => expandSplit(node.id)} />
  }

  if (!hydrated) {
    return <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center border-l border-border bg-[#0a0b0d]"><div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground/50"><span className="h-2 w-2 animate-pulse rounded-full bg-primary/60" /> restoring workspace…</div></div>
  }

  if (records.length === 0) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-border bg-[#0a0b0d]">
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6">
          <TerminalSquare className="h-8 w-8 text-primary/30" />
          <div className="text-center"><p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground/70">Command Workspace</p><p className="mt-1 max-w-[320px] font-mono text-[10px] leading-relaxed text-muted-foreground/40">New Terminal opens a tab. Use V/H or Split to create a pane. All sessions are real PTYs.</p></div>
          <button onClick={() => { void createTerminal() }} className="flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-3 py-1.5 font-mono text-[10px] text-primary hover:bg-primary/20"><Plus className="h-3 w-3" /> New Terminal</button>
        </div>
        <div className="flex h-6 shrink-0 items-center border-t border-border bg-surface-secondary px-3 font-mono text-[9px] text-muted-foreground/50">0 terminals <span className="ml-auto">Ctrl⇧T new · Ctrl⇧W close · Ctrl⇧5/9 split</span></div>
      </div>
    )
  }

  const maximizedPane = maximizedPaneId ? findPane(layout, maximizedPaneId) : null
  return (
    <div
      ref={rootRef}
      className={`flex min-h-0 min-w-0 flex-col bg-[#0a0b0d] ${
        fullscreen ? 'fixed inset-0 z-50 h-screen w-screen' : 'flex-1 border-l border-border'
      }`}
    >
      <div className="flex min-h-8 shrink-0 items-center gap-1 border-b border-border bg-surface-secondary px-1.5">
        <TerminalSquare className="ml-1 h-3.5 w-3.5 text-primary" />
        <span className="mr-2 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60">Command Workspace</span>
        <div className="relative hidden items-center sm:flex"><Search className="pointer-events-none absolute left-1.5 h-3 w-3 text-muted-foreground/50" /><input data-drive-terminal-search value={search.trim() === ' ' ? '' : search} onChange={(event) => setSearch(event.target.value)} placeholder="find tabs" aria-label="Search terminal tabs" className="w-24 rounded border border-border bg-surface-base py-1 pl-5 pr-1 font-mono text-[9px] text-foreground outline-none focus:border-primary/40" /></div>
        <div className="ml-auto flex items-center gap-0.5">
          {closed.length > 0 && <button onClick={reopenLast} title="Reopen last closed terminal" className="rounded p-1 text-muted-foreground hover:bg-surface-elevated hover:text-primary"><RotateCcw className="h-3.5 w-3.5" /></button>}
          <button onClick={toggleFullscreen} title={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen workspace — escapes the header and sidebar (Ctrl⇧Enter)'} className="rounded p-1 text-muted-foreground hover:bg-primary/10 hover:text-primary">{fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}</button>
          <button onClick={resetLayout} title="Reset Layout: keep one terminal fullscreen" className="flex items-center gap-1 rounded px-1.5 py-1 font-mono text-[9px] text-muted-foreground hover:bg-surface-elevated hover:text-primary"><RotateCcw className="h-3 w-3" /> Reset Layout</button>
          <button onClick={resetWorkspace} title="Reset Workspace: close all terminals and panes" className="flex items-center gap-1 rounded px-1.5 py-1 font-mono text-[9px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 className="h-3 w-3" /> Reset Workspace</button>
          <button onClick={() => { void createTerminal() }} title="New terminal tab in the focused pane" className="rounded p-1 text-primary hover:bg-primary/10"><Plus className="h-3.5 w-3.5" /></button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {maximizedPane ? renderPane(maximizedPane) : layout ? renderNode(layout) : null}
      </div>
      <div className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-surface-secondary px-3 font-mono text-[9px] text-muted-foreground/60"><span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-primary/70" />{records.length} terminal{records.length === 1 ? '' : 's'}</span>{focusedPane && <><span className="text-muted-foreground/40">·</span><span className="max-w-[240px] truncate text-foreground/80">{recordById.get(focusedPane.activeId)?.name ?? 'pane'}</span></>}<span className="ml-auto hidden sm:inline">Ctrl⇧T tab · Ctrl⇧W close terminal · Ctrl⇧5/9 split · Ctrl⇧F find · Ctrl⇧⏎ fullscreen</span></div>
    </div>
  )
})

DriveTerminalWorkspace.displayName = 'DriveTerminalWorkspace'
