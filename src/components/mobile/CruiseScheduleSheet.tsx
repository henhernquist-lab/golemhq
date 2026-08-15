'use client'

import { useState } from 'react'
import { Loader2, Check, Lock } from 'lucide-react'
import { BottomSheet } from './BottomSheet'
import { SCANFIX_CATEGORIES, SCANFIX_LABEL, type CruiseAutoRunFrequency, type CruiseScanfixCategory } from '@/lib/cruise/types'
import type { CruiseAutoJob } from '@/app/api/cruise/autos/route'

// Same POST /api/cruise/repos/autorun body shape, fields, and validation as
// the (now removed) desktop auto-run config UI. Only the widget choice
// differs where a mobile touch target beats a desktop <select>: frequency is
// a radio row instead of a dropdown, weekday is a chip row instead of a
// dropdown. tz is auto-derived from the device.

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const FREQUENCY_OPTIONS: { id: CruiseAutoRunFrequency; label: string }[] = [
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'every_n_days', label: 'Every N days' },
]

interface CruiseScheduleSheetProps {
  open: boolean
  onClose: () => void
  job: CruiseAutoJob | null
  onSaved: () => void
}

export function CruiseScheduleSheet({ open, onClose, job, onSaved }: CruiseScheduleSheetProps) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const cfg = job?.auto_run

  const [enabled, setEnabled] = useState(cfg?.auto_run_enabled ?? false)
  const [time, setTime] = useState(cfg?.auto_run_time ?? '03:00')
  const [freq, setFreq] = useState<CruiseAutoRunFrequency>(cfg?.auto_run_frequency ?? 'daily')
  const [weekday, setWeekday] = useState(cfg?.auto_run_weekday ?? 1)
  const [intervalDays, setIntervalDays] = useState(cfg?.auto_run_interval_days ?? 3)
  const [sel, setSel] = useState<Set<CruiseScanfixCategory>>(new Set(cfg?.auto_run_categories ?? []))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset local form state whenever a different job opens the sheet.
  const [openedFor, setOpenedFor] = useState<string | null>(null)
  if (job && job.repo !== openedFor) {
    setOpenedFor(job.repo)
    setEnabled(job.auto_run.auto_run_enabled)
    setTime(job.auto_run.auto_run_time ?? '03:00')
    setFreq(job.auto_run.auto_run_frequency ?? 'daily')
    setWeekday(job.auto_run.auto_run_weekday ?? 1)
    setIntervalDays(job.auto_run.auto_run_interval_days ?? 3)
    setSel(new Set(job.auto_run.auto_run_categories ?? []))
    setError(null)
  }

  const toggleCat = (c: CruiseScanfixCategory) => setSel((prev) => {
    const n = new Set(prev)
    if (n.has(c)) n.delete(c); else n.add(c)
    return n
  })

  const buttonsConfirmed = !!job?.buttons_autofix_confirmed

  const save = async () => {
    if (!job) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/cruise/repos/autorun', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: job.repo,
          enabled: true,
          time, tz, frequency: freq,
          ...(freq === 'weekly' ? { weekday } : {}),
          ...(freq === 'every_n_days' ? { interval_days: intervalDays } : {}),
          categories: [...sel],
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Could not save schedule'); return }
      onSaved()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const turnOff = async () => {
    if (!job) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/cruise/repos/autorun', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: job.repo, enabled: false }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Could not turn off auto-run'); return }
      setEnabled(false)
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={job?.repo ?? 'Schedule'} height="80dvh">
      {job && (
        <div className="space-y-4 p-4">
          <label className="flex items-center justify-between">
            <span className="font-mono text-[11px] text-foreground">Auto-run enabled</span>
            <button
              onClick={() => (enabled ? turnOff() : setEnabled(true))}
              disabled={saving}
              className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-50 ${enabled ? 'bg-primary' : 'bg-surface-elevated'}`}
            >
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
            </button>
          </label>

          {enabled && (
            <>
              <div>
                <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">Time ({tz})</label>
                <input
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className="w-full rounded border border-border bg-surface-base px-3 py-2 font-mono text-[13px] text-foreground focus:border-primary/30 focus:outline-none"
                  style={{ minHeight: 44 }}
                />
              </div>

              <div>
                <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">Frequency</label>
                <div className="grid grid-cols-3 gap-1.5">
                  {FREQUENCY_OPTIONS.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => setFreq(f.id)}
                      className={`rounded border px-2 py-2 font-mono text-[10px] transition-colors ${
                        freq === f.id ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'
                      }`}
                      style={{ minHeight: 44 }}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              {freq === 'weekly' && (
                <div>
                  <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">Day of week</label>
                  <div className="flex gap-1.5">
                    {WEEKDAYS.map((d, i) => (
                      <button
                        key={d}
                        onClick={() => setWeekday(i)}
                        className={`flex-1 rounded border px-1 py-2 font-mono text-[10px] transition-colors ${
                          weekday === i ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'
                        }`}
                        style={{ minHeight: 44 }}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {freq === 'every_n_days' && (
                <div>
                  <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">Every N days</label>
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={intervalDays}
                    onChange={(e) => setIntervalDays(Number(e.target.value))}
                    className="w-24 rounded border border-border bg-surface-base px-3 py-2 font-mono text-[13px] text-foreground focus:border-primary/30 focus:outline-none"
                    style={{ minHeight: 44 }}
                  />
                </div>
              )}

              <div>
                <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">Categories allowed on schedule</label>
                <div className="space-y-1">
                  {SCANFIX_CATEGORIES.map((c) => {
                    const locked = c === 'non_functional_buttons' && !buttonsConfirmed
                    return (
                      <label
                        key={c}
                        className={`flex items-center gap-2 rounded border border-border px-3 py-2 font-mono text-[11px] ${locked ? 'opacity-40' : 'text-foreground/90'}`}
                        style={{ minHeight: 44 }}
                      >
                        <input
                          type="checkbox"
                          checked={sel.has(c)}
                          disabled={locked}
                          onChange={() => toggleCat(c)}
                          className="h-4 w-4 accent-primary"
                        />
                        {locked && <Lock className="h-3 w-3" />}
                        {SCANFIX_LABEL[c]}
                      </label>
                    )
                  })}
                </div>
              </div>

              {error && <p className="font-mono text-[10px] text-destructive">{error}</p>}

              <button
                onClick={save}
                disabled={saving || sel.size === 0}
                className="flex w-full items-center justify-center gap-1.5 rounded border border-primary/40 bg-primary/10 py-2.5 font-mono text-[11px] text-primary transition-colors hover:bg-primary/20 disabled:opacity-40"
                style={{ minHeight: 44 }}
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                Save schedule
              </button>
              <p className="font-mono text-[9px] leading-relaxed text-muted-foreground/70">
                Runs autonomously on schedule, fixing only the checked categories. Opens a PR (draft if the build fails) — never auto-merged. Skipped if a run is already active or the monthly cap ({job.auto_run.auto_run_monthly_cap}) is hit.
              </p>
            </>
          )}

          {!enabled && error && <p className="font-mono text-[10px] text-destructive">{error}</p>}
        </div>
      )}
    </BottomSheet>
  )
}
