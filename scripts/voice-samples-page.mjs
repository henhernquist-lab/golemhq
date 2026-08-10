#!/usr/bin/env -S npx tsx
// Build a self-contained page of voice samples, for judging by ear.
//
// The measurements in scripts/verify-voices.mjs are the objective half of the
// claim; this is the other half. A fingerprint can put two clips far apart in
// mel space without a listener being able to tell them apart, so the samples
// ship as playable audio and the verdict stays with the person listening.
//
// Every number on the page comes from report.json, which verify-voices.mjs
// writes as it measures. Nothing here is typed by hand — a listening page
// quoting figures nobody took would defeat its own purpose.
//
// Audio is embedded as data: URIs rather than linked, so the page survives
// being opened somewhere that cannot reach /tmp.
//
// Usage (after KEEP=1 ./scripts/verify-voices.mjs):
//   ./scripts/voice-samples-page.mjs [outfile.html]

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const { VOICES } = await import('../src/lib/voice/voices.ts')

const DIR = '/tmp/golem-voice-samples'
const OUT = process.argv[2] ?? '/tmp/golem-voice-samples/index.html'

const report = JSON.parse(await readFile(join(DIR, 'report.json'), 'utf8'))

const files = (await readdir(DIR)).filter((f) => f.endsWith('.wav'))
if (files.length === 0) throw new Error(`no .wav files in ${DIR} — run KEEP=1 ./scripts/verify-voices.mjs first`)

const clips = await Promise.all(
  files.map(async (file) => {
    const [id, tag] = file.replace('.wav', '').split(/-(?=[ab]$)/)
    const bytes = await readFile(join(DIR, file))
    return { id, tag, file, kb: Math.round(bytes.byteLength / 1024), data: bytes.toString('base64') }
  }),
)

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

// Bars are scaled against the largest distance on the page, so within and
// between share one axis — the comparison is the entire argument, and two
// independently scaled charts would flatter it.
const maxDistance = Math.max(...report.within.map((w) => w.d), ...report.between.map((b) => b.d))
const bar = (d, kind) =>
  `<div class="bar"><span class="fill ${kind}" style="width:${((d / maxDistance) * 100).toFixed(1)}%"></span></div><span class="num">${d.toFixed(3)}</span>`

const panels = report.voices
  .map(({ id, medianF0, seconds }) => {
    const meta = VOICES.find((v) => v.id === id)
    const mine = clips.filter((c) => c.id === id).sort((a, b) => a.tag.localeCompare(b.tag))
    const players = mine
      .map(
        (c) => `
        <div class="clip">
          <p class="line">${esc(report.lines[c.tag] ?? '')}</p>
          <audio controls preload="none" src="data:audio/wav;base64,${c.data}"></audio>
          <p class="file">${esc(c.file)} · ${c.kb} KB</p>
        </div>`,
      )
      .join('')
    return `
      <article>
        <header>
          <h2>${esc(id)}</h2>
          <p class="desc">${esc(meta ? `${meta.label} · ${meta.accent} ${meta.gender} — ${meta.note}` : 'not in the catalog')}</p>
          <dl class="readout">
            <div><dt>median pitch</dt><dd>${medianF0 ? `${medianF0.toFixed(0)} Hz` : '—'}</dd></div>
            <div><dt>length</dt><dd>${seconds.toFixed(2)} s</dd></div>
          </dl>
        </header>
        ${players}
      </article>`
  })
  .join('')

const html = `<title>Agent voices — listen and decide</title>
<style>
  /* Dark-first: this is a panel from a dark terminal UI, and the light theme is
     a considered translation of it rather than an inversion. Every colour is a
     token so no rule depends on which theme resolved. */
  :root {
    color-scheme: light dark;
    --ground: #f5f8f3;
    --panel: #ffffff;
    --rule: #dae3d6;
    --ink: #11170f;
    --dim: #576053;
    --signal: #12793f;
    --signal-soft: rgba(18, 121, 63, 0.12);
    --contrast: #7c5cd6;
    --contrast-soft: rgba(124, 92, 214, 0.14);
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    --prose: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ground: #0a0d09;
      --panel: #11160f;
      --rule: #212c1e;
      --ink: #dce5d8;
      --dim: #7d8c78;
      --signal: #4ade80;
      --signal-soft: rgba(74, 222, 128, 0.14);
      --contrast: #b39dff;
      --contrast-soft: rgba(179, 157, 255, 0.16);
    }
  }
  :root[data-theme="dark"] {
    --ground: #0a0d09;
    --panel: #11160f;
    --rule: #212c1e;
    --ink: #dce5d8;
    --dim: #7d8c78;
    --signal: #4ade80;
    --signal-soft: rgba(74, 222, 128, 0.14);
    --contrast: #b39dff;
    --contrast-soft: rgba(179, 157, 255, 0.16);
  }

  * { box-sizing: border-box; }
  body {
    background: var(--ground);
    color: var(--ink);
    font: 15px/1.65 var(--prose);
    margin: 0;
    padding: 3rem 1.25rem 5rem;
  }
  main { max-width: 40rem; margin: 0 auto; display: flex; flex-direction: column; gap: 1rem; }

  .masthead { display: flex; flex-direction: column; gap: .6rem; margin-bottom: .5rem; }
  .eyebrow {
    font: 500 .68rem/1 var(--mono);
    letter-spacing: .14em;
    text-transform: uppercase;
    color: var(--signal);
    margin: 0;
  }
  h1 { font: 600 1.55rem/1.25 var(--prose); margin: 0; text-wrap: balance; letter-spacing: -.015em; }
  .lede { color: var(--dim); margin: 0; max-width: 34rem; }

  article {
    background: var(--panel);
    border: 1px solid var(--rule);
    border-radius: 4px;
    padding: 1.1rem 1.2rem 1.2rem;
    display: flex;
    flex-direction: column;
    gap: .85rem;
  }
  article header { display: flex; flex-direction: column; gap: .3rem; }
  h2 { font: 600 1.05rem/1.2 var(--mono); margin: 0; color: var(--signal); letter-spacing: -.01em; }
  .desc { margin: 0; color: var(--dim); font-size: .85rem; }

  .readout { display: flex; gap: 1.5rem; margin: .35rem 0 0; }
  .readout div { display: flex; flex-direction: column; gap: .1rem; }
  .readout dt {
    font: .62rem/1 var(--mono);
    letter-spacing: .1em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .readout dd { margin: 0; font: .95rem/1.2 var(--mono); font-variant-numeric: tabular-nums; }

  .clip { display: flex; flex-direction: column; gap: .35rem; padding-top: .85rem; border-top: 1px solid var(--rule); }
  .line { margin: 0; font-size: .9rem; }
  .line::before, .line::after { content: '"'; color: var(--dim); }
  .file { margin: 0; font: .68rem/1 var(--mono); color: var(--dim); }
  audio { width: 100%; height: 2.1rem; }

  .evidence { background: var(--panel); border: 1px solid var(--rule); border-radius: 4px; padding: 1.1rem 1.2rem 1.2rem; }
  .evidence h2 { color: var(--ink); font-family: var(--prose); font-size: 1rem; margin-bottom: .3rem; }
  .evidence p { color: var(--dim); font-size: .85rem; margin: 0 0 1rem; }
  .rows { display: grid; grid-template-columns: minmax(0, 1fr) 6rem auto; gap: .45rem .7rem; align-items: center; }
  .rows .label { font: .72rem/1.3 var(--mono); color: var(--dim); overflow-wrap: anywhere; }
  .bar { height: .5rem; border-radius: 1px; background: var(--signal-soft); overflow: hidden; }
  .fill { display: block; height: 100%; }
  .fill.within { background: var(--contrast); }
  .fill.between { background: var(--signal); }
  .num { font: .72rem/1 var(--mono); font-variant-numeric: tabular-nums; color: var(--ink); }

  .key { display: flex; gap: 1.1rem; margin-top: 1rem; flex-wrap: wrap; }
  .key span { display: inline-flex; align-items: center; gap: .4rem; font: .7rem/1 var(--mono); color: var(--dim); }
  .swatch { width: .7rem; height: .7rem; border-radius: 1px; }

  .verdict {
    margin-top: 1.1rem;
    padding-top: .9rem;
    border-top: 1px solid var(--rule);
    font-size: .88rem;
    color: var(--ink);
  }
  .verdict strong { color: var(--signal); font-family: var(--mono); font-variant-numeric: tabular-nums; }
  footer { color: var(--dim); font: .68rem/1.5 var(--mono); text-align: center; margin-top: .5rem; }
  :focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
</style>
<main>
  <div class="masthead">
    <p class="eyebrow">kokoro · local tts</p>
    <h1>Three agent voices. Same two sentences.</h1>
    <p class="lede">
      Play them and decide for yourself whether they are actually different voices.
      Each voice says both lines, which is what lets &ldquo;these sound different from each other&rdquo;
      be checked against &ldquo;this one sounds different from itself&rdquo;.
    </p>
  </div>

  ${panels}

  <section class="evidence">
    <h2>The measurement, for what it is worth</h2>
    <p>
      Distance combines median pitch and long-term spectral shape. The comparison is the point:
      a voice saying two different sentences sets the floor, and any two voices have to clear it.
    </p>
    <div class="rows">
      ${report.within.map((w) => `<span class="label">${esc(w.id)} — two sentences</span>${bar(w.d, 'within')}`).join('\n      ')}
      ${report.between.map((b) => `<span class="label">${esc(b.pair)}</span>${bar(b.d, 'between')}`).join('\n      ')}
    </div>
    <div class="key">
      <span><i class="swatch" style="background: var(--contrast)"></i>one voice, different words</span>
      <span><i class="swatch" style="background: var(--signal)"></i>different voices, same words</span>
    </div>
    <p class="verdict">
      The closest pair of voices is <strong>${report.margin.toFixed(1)}×</strong> further apart than
      any single voice drifts from itself.
    </p>
  </section>

  <footer>measured ${esc(report.measuredAt)} · scripts/verify-voices.mjs</footer>
</main>
`

await writeFile(OUT, html)
console.log(`${OUT}  (${Math.round(Buffer.byteLength(html) / 1024)} KB, ${clips.length} clips)`)
