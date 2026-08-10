'use client'

// Hire and edit workers.
//
// The first write surface in the missions UI, so it says out loud what it is
// doing. The two modes are not cosmetic: registering an existing CLI and
// creating an instructions-driven worker have different required fields and
// different failure modes, and one form pretending to do both would let you
// save a layer-2 agent with no cli_command — a row the Scheduler can pick and
// the adapter then refuses.

import { useState } from 'react'
import { Loader2, Plus, X } from 'lucide-react'

import { AGENT_LAYER_LABELS, type AgentLayer } from '@/lib/missions/types'
import { VoicePicker } from './voice-picker'

export interface EditableAgent {
  id: string
  name: string
  layer: AgentLayer
  cliCommand: string | null
  enabled: boolean
  instructions: string | null
  /** Null means nobody has chosen — the rotation decides. */
  voiceId: string | null
  /** What the rotation would give it, so the form can name the current default. */
  defaultVoiceId?: string | null
}

type Mode = 'cli' | 'custom'

const LAYERS: AgentLayer[] = [1, 2, 3]

const inputClass =
  'w-full rounded border border-border bg-surface-base px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:border-primary/50'

export function HireWorkerPanel({
  agent,
  onClose,
  onSaved,
}: {
  /** Editing an existing agent, or undefined to hire a new one. */
  agent?: EditableAgent
  onClose: () => void
  onSaved: () => void
}) {
  const editing = !!agent
  const [mode, setMode] = useState<Mode>(agent ? (agent.cliCommand ? 'cli' : 'custom') : 'cli')
  const [name, setName] = useState(agent?.name ?? '')
  const [layer, setLayer] = useState<AgentLayer>(agent?.layer ?? 2)
  const [cliCommand, setCliCommand] = useState(agent?.cliCommand ?? '')
  const [instructions, setInstructions] = useState(agent?.instructions ?? '')
  const [voiceId, setVoiceId] = useState<string | null>(agent?.voiceId ?? null)
  const [enabled, setEnabled] = useState(agent?.enabled ?? true)
  const [detect, setDetect] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const body = {
        name,
        layer,
        // Mode decides what is sent, so switching to "custom" genuinely clears
        // the CLI rather than leaving a stale one behind the form.
        cliCommand: mode === 'cli' ? cliCommand : null,
        instructions: instructions.trim() ? instructions : null,
        // null is meaningful, not "unset": it hands the agent back to the
        // rotation, which is the only way to undo a choice.
        voiceId,
        enabled,
        detect: detect && mode === 'cli',
      }
      const res = await fetch(editing ? `/api/missions/agents/${agent.id}` : '/api/missions/agents', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)

      if (data.detection?.ran) setNotice('saved — CLI detection swept the builder host')
      else if (data.detection?.error) setNotice(`saved, but detection failed: ${data.detection.error}`)

      onSaved()
      if (!data.detection?.error) onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mb-4 rounded-lg border border-primary/30 bg-surface-secondary p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-mono text-xs text-foreground">{editing ? `edit ${agent.name}` : 'hire worker'}</h3>
        <button onClick={onClose} className="text-muted-foreground hover:text-primary">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mb-3 flex gap-1">
        {(['cli', 'custom'] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`rounded border px-2 py-1 font-mono text-[10px] transition-colors ${
              mode === m ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground'
            }`}
          >
            {m === 'cli' ? 'register a CLI' : 'custom worker'}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase text-muted-foreground">name</span>
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Gemini CLI" />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase text-muted-foreground">layer</span>
          <select
            className={inputClass}
            value={layer}
            onChange={(e) => setLayer(Number(e.target.value) as AgentLayer)}
            disabled={editing}
          >
            {LAYERS.map((l) => (
              <option key={l} value={l}>
                {l} · {AGENT_LAYER_LABELS[l]}
              </option>
            ))}
          </select>
        </label>

        {mode === 'cli' && (
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="font-mono text-[10px] uppercase text-muted-foreground">cli command</span>
            <input
              className={inputClass}
              value={cliCommand}
              onChange={(e) => setCliCommand(e.target.value)}
              placeholder="gemini --skip-trust --approval-mode auto_edit -p"
            />
            {/* This is the single most misconfigured field on the roster — a
                trailing prompt flag here is what made opencode receive whole
                task descriptions as a password. */}
            <span className="font-mono text-[10px] text-muted-foreground">
              everything up to but NOT including the prompt — the adapter appends the prompt itself
            </span>
          </label>
        )}

        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="font-mono text-[10px] uppercase text-muted-foreground">
            standing instructions {mode === 'custom' && '(what makes this worker custom)'}
          </span>
          <textarea
            className={`${inputClass} min-h-[80px]`}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Always add a comment header with your name to files you create."
          />
          <span className="font-mono text-[10px] text-muted-foreground">
            prepended to every task prompt this agent runs
          </span>
        </label>
        <VoicePicker value={voiceId} onChange={setVoiceId} fallbackVoice={agent?.defaultVoiceId ?? null} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          enabled
        </label>
        {mode === 'cli' && (
          <label className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
            <input type="checkbox" checked={detect} onChange={(e) => setDetect(e.target.checked)} />
            run CLI detection on save (~10s)
          </label>
        )}
        <button
          onClick={save}
          disabled={saving || !name.trim()}
          className="ml-auto inline-flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-3 py-1.5 font-mono text-xs text-primary transition-colors hover:bg-primary/20 disabled:opacity-40"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          {editing ? 'save' : 'hire'}
        </button>
      </div>

      {error && <p className="mt-2 font-mono text-[10px] text-red-400">{error}</p>}
      {notice && <p className="mt-2 font-mono text-[10px] text-warning">{notice}</p>}
    </div>
  )
}
