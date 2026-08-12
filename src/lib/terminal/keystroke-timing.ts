'use client'

// Per-keystroke latency instrumentation for the terminal input path.
//
// ─── Why this exists as code rather than a one-off script ─────────────
// The interesting number is not "how long does a POST take" — it is how long
// passes between a key going down and the character the shell echoed appearing
// on screen. That spans xterm, a fetch, a lambda, a WebSocket, a PTY, and an
// SSE stream back, and no single tool sees all of it. Measuring it from
// outside means correlating logs across a lambda boundary by wall clock, which
// is guesswork. So the path records its own timestamps against one clock.
//
// ─── Cost when off ────────────────────────────────────────────────────
// Disabled unless localStorage golem:termtiming is set, and every entry point
// is a no-op returning immediately in that case. Enabled, it holds a bounded
// ring of samples in memory and writes nothing to the network.
//
// Read the results from the browser console:  __golemTermTiming.report()

export interface KeystrokeSample {
  seq: number
  /** What was typed, for matching the echo. Printable ASCII only. */
  ch: string
  /** t0: xterm's onData fired. All other marks are deltas from this, in ms. */
  t0: number
  /** t1: the POST was dispatched. */
  dispatch?: number
  /** t2: the POST's response landed. */
  response?: number
  /** t3: a matching byte arrived on the SSE stream. */
  echo?: number
  /** t4: xterm finished writing it to the screen. */
  painted?: number
  /** Server's own breakdown, from the Server-Timing header. */
  server?: Record<string, number>
}

const MAX_SAMPLES = 500

class TimingRecorder {
  enabled = false
  private samples: KeystrokeSample[] = []
  private pending: KeystrokeSample[] = []

  constructor() {
    try {
      this.enabled = typeof localStorage !== 'undefined' && !!localStorage.getItem('golem:termtiming')
    } catch {
      this.enabled = false
    }
  }

  start(seq: number, ch: string): KeystrokeSample | null {
    if (!this.enabled) return null
    const sample: KeystrokeSample = { seq, ch, t0: performance.now() }
    this.samples.push(sample)
    if (this.samples.length > MAX_SAMPLES) this.samples.shift()
    // Only single printable characters can be matched against an echo; a
    // paste or an escape sequence has no one-to-one relationship with what
    // comes back, and pretending otherwise would invent numbers.
    if (ch.length === 1 && ch >= ' ' && ch <= '~') this.pending.push(sample)
    return sample
  }

  /**
   * Match an SSE chunk against the oldest unresolved keystroke.
   *
   * Deliberately naive: it only claims a match when the chunk actually
   * contains the character that was typed. A shell that reprints the whole
   * line, or output arriving for another reason, leaves the sample unresolved
   * rather than being credited with a fast echo it did not produce.
   */
  echo(text: string): KeystrokeSample | null {
    if (!this.enabled || this.pending.length === 0) return null
    const now = performance.now()
    for (let i = 0; i < this.pending.length; i++) {
      const sample = this.pending[i]
      if (sample.echo === undefined && text.includes(sample.ch)) {
        sample.echo = now - sample.t0
        this.pending.splice(i, 1)
        return sample
      }
    }
    return null
  }

  painted(sample: KeystrokeSample | null) {
    if (!sample || !this.enabled) return
    sample.painted = performance.now() - sample.t0
  }

  all(): KeystrokeSample[] {
    return this.samples.slice()
  }

  clear() {
    this.samples = []
    this.pending = []
  }

  /** Median rather than mean: one GC pause should not define the number. */
  private static median(values: number[]): number | null {
    if (values.length === 0) return null
    const sorted = values.slice().sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }

  report() {
    const s = this.samples
    const pick = (f: (x: KeystrokeSample) => number | undefined) =>
      TimingRecorder.median(s.map(f).filter((v): v is number => typeof v === 'number'))

    const serverKeys = new Set<string>()
    for (const x of s) for (const k of Object.keys(x.server ?? {})) serverKeys.add(k)
    const server: Record<string, number | null> = {}
    for (const k of serverKeys) {
      server[k] = TimingRecorder.median(
        s.map((x) => x.server?.[k]).filter((v): v is number => typeof v === 'number'),
      )
    }

    return {
      samples: s.length,
      echoed: s.filter((x) => x.echo !== undefined).length,
      median: {
        t0_to_t1_dispatch: pick((x) => x.dispatch),
        t1_to_t2_roundtrip: pick((x) => (x.response !== undefined && x.dispatch !== undefined ? x.response - x.dispatch : undefined)),
        t0_to_t2_response: pick((x) => x.response),
        t0_to_t3_echo: pick((x) => x.echo),
        t0_to_t4_painted: pick((x) => x.painted),
      },
      serverMedian: server,
    }
  }
}

export const keystrokeTiming = new TimingRecorder()

if (typeof window !== 'undefined') {
  // Exposed so a real browser session can be measured from the console
  // without a build flag or a rebuild.
  ;(window as unknown as { __golemTermTiming: TimingRecorder }).__golemTermTiming = keystrokeTiming
}
