# Golem HQ — Design Canon

Single reference for Golem HQ's visual identity. Every UI batch starts here
instead of re-deriving the design language from the code.

Status markers used throughout:

- **[decided]** — a settled decision. Changes require an explicit override.
- **[open]** — a known open question, waiting on a decision. Do NOT silently
  resolve it in code; pick it here first.
- **[proposed]** — the planned build direction. Grounded in current code, not
  yet implemented.

---

## 1. Branding

**[decided]** The user-facing name is **Golem HQ**. Never "Golem.AGENT",
never "Golem", never a variant casing.

- The repo, package, and internal identifiers are `enry.agent` by design.
  That is expected, not a bug — do not "fix" it (see AGENTS.md).
- The mascot / assistant character is **Golem**.
- "Golem.AGENT" was found wrong in multiple places and the rebrand to
  "Golem HQ" landed in commit `ad0e5a3` (`fix(hq): rebrand Golem.AGENT →
  Golem HQ`). Current audit (Aug 2026): zero remaining `Golem.AGENT` strings
  in the tree. The login page renders "Golem HQ" (`src/app/login/page.tsx:114`).
- Page title metadata is `Golem | Autonomous AI Operating System`
  (`src/app/layout.tsx:34`) — this is a functional title, not a brand lockup.

Rule: any new UI copy uses "Golem HQ". If "Golem.AGENT" appears anywhere
again, that is a bug.

---

## 2. Themes

**[decided — not yet built]** Two themes going forward, not three.

Today the app ships **three** themes. The decision is to collapse Light and OG
into one new monochrome + cyan theme, leaving **Midnight (unchanged)** and the
**new theme** as the only two. This is a decision recorded here to be
implemented, not a description of what exists.

### 2.1 Current state (audited from `src/app/globals.css`, Aug 2026)

Themes are selected by `data-theme` on `<html>`. The `og` theme has **no**
dedicated CSS block — selecting it removes the attribute, which resolves to
the `:root` defaults (`src/components/top-bar.tsx:47-55`,
`src/app/layout.tsx:66-72`). The theme type is `'og' | 'midnight' | 'light'`
(`src/components/top-bar.tsx:41`).

| Token | OG = `:root` (warm, Grimoire × Clay) | Midnight `[data-theme='midnight']` | Light `[data-theme='light']` |
| --- | --- | --- | --- |
| `--background` | `#1a1614` | `#0b1221` | `#ffffff` |
| `--foreground` | `#f5f0e8` | `#ffffff` | `#0b1221` |
| `--card` / `--popover` | `#1f1a17` | `#111d33` | `#ffffff` |
| `--primary` | `#b8935a` (gold) | `#60a5fa` (light blue) | `#2563eb` (blue) |
| `--primary-dim` | `#9a7d4a` | `#3b82f6` | `#1d4ed8` |
| `--secondary` / `--muted` | `#25201c` | `#1a2942` | `#f1f5f9` |
| `--muted-foreground` | `#a89880` | `#94a3b8` | `#64748b` |
| `--accent` | `#a85c3f` (rust) | `#3b82f6` | `#3b82f6` |
| `--destructive` | `#c44d4d` | `#ff4d4d` | `#ef4444` |
| `--warning` | `#d4a83c` | `#ffb800` | `#f59e0b` |
| `--border` | `#2d2824` | `#2a3b5a` | `#e2e8f0` |
| `--input` | `#25201c` | `#1a2942` | `#e2e8f0` |
| `--ring` | `#b8935a` | `#60a5fa` | `#2563eb` |
| `--radius` | `0.375rem` (all) | `0.375rem` | `0.375rem` |
| `--surface-base` | `#1a1614` | `#0b1221` | `#ffffff` |
| `--surface-secondary` | `#1f1a17` | `#111d33` | `#f8fafc` |
| `--surface-elevated` | `#25201c` | `#1a2942` | `#f1f5f9` |
| `--grid-line` | `rgba(45,40,36,0.3)` | `rgba(42,59,90,0.3)` | `rgba(226,232,240,1)` |
| chart 1–5 | gold/rust/amber/red/tan | — (inherits :root) | — (inherits :root) |

Chart colors are defined only on `:root` (`--chart-1..5`) and are NOT
overridden per theme — Midnight and Light currently inherit the OG warm
palette for charts, an inconsistency worth noting when the collapse happens.

Light also carries a one-off override for the mascot palette
(`globals.css:157-162`): the generic `--golem-*` derivation washes Golem out
on the near-white surface, so Light mixes toward `--primary` over `#e8f0fd`
instead. The new theme must carry its own verified `--golem-*` derivation for
the same reason.

### 2.2 The target

**[decided]** One new theme replaces both Light and OG:

- Monochrome base — graphite in the dark variant, white/off-white in the
  light variant. No warm brown (`#b8935a`/`#a85c3f`) and no blue
  (`#2563eb`/`#3b82f6`/`#60a5fa`) heritage.
- **Cyan is the single accent color**, used sparingly for active/status
  states — not splashed across every interactive element. Same discipline as
  today's "glow reserved for rare emphasis" rule (`globals.css:342`).
- Midnight stays byte-for-byte as-is. It is not part of the collapse.

**[open]** Theme name. Proposed: **Graphite** (id `graphite`), carrying both a
dark and a light variant. "OG" is a bad label for a monochrome theme and is
replaced. Do not invent a permanent name in code before this doc has one; the
theme toggle (`top-bar.tsx`) and the inline theme script (`layout.tsx`) are
the two places the theme set is hardcoded and must change together. Also
[open]: how the Graphite light/dark variant is selected — today the toggle is
three flat options (`'og' | 'midnight' | 'light'`), and two themes where one
has two variants is a different interaction (follow `prefers-color-scheme` vs
an explicit in-theme toggle).

Token surface to preserve: `--surface-*`, `--golem-*` (mascot), chart tokens,
sidebar tokens, `--radius`, `--grid-line`. The mascot swatches are derived
from palette tokens via `color-mix()` and re-derive automatically on a new
theme (`globals.css:141-149`) — do not hardcode a new swatch set.

### 2.3 The new theme — proposed tokens

**[proposed — Henry confirms hex before build]** Concrete values for
Graphite, both variants, matching §2.1's row structure exactly. The cyan ramp
is Tailwind-aligned (`cyan-400` `#22d3ee` for dark, `cyan-700` `#0e7490` for
light); the graphite ramp is a cool near-black / near-white pair with no warm
or blue heritage. `--primary` and `--accent` are deliberately the same hue —
cyan is the single accent.

| Token | Graphite dark `[data-theme='graphite']` | Graphite light |
| --- | --- | --- |
| `--background` | `#0e1012` | `#ffffff` |
| `--foreground` | `#f2f5f7` | `#17191c` |
| `--card` / `--popover` | `#14171b` | `#ffffff` |
| `--primary` | `#22d3ee` (cyan-400) | `#0e7490` (cyan-700) |
| `--primary-dim` | `#0e7490` (cyan-700) | `#155e75` (cyan-800) |
| `--secondary` / `--muted` | `#1a1e24` | `#f1f3f5` |
| `--muted-foreground` | `#8b949e` | `#5b6470` |
| `--accent` | `#22d3ee` | `#0e7490` |
| `--destructive` | `#f87171` | `#dc2626` |
| `--warning` | `#ffb800` | `#b45309` |
| `--border` | `#262b31` | `#e2e5e9` |
| `--input` | `#1a1e24` | `#e2e5e9` |
| `--ring` | `#22d3ee` | `#0e7490` |
| `--radius` | `0.375rem` | `0.375rem` |
| `--surface-base` | `#0e1012` | `#ffffff` |
| `--surface-secondary` | `#14171b` | `#f7f8fa` |
| `--surface-elevated` | `#1a1e24` | `#f1f3f5` |
| `--grid-line` | `rgba(38,43,49,0.3)` | `rgba(226,229,233,1)` |
| chart 1–5 | `#22d3ee` `#0e7490` `#67e8f9` `#8b949e` `#f2f5f7` | `#0e7490` `#22d3ee` `#155e75` `#5b6470` `#94a3b8` |

Supplementary tokens §2.1 omits but a real implementation needs — foreground
variants (dark / light): `--primary-foreground` `#04222a` / `#ffffff`,
`--secondary-foreground` `#f2f5f7` / `#17191c`, `--accent-foreground`
`#04222a` / `#ffffff`, `--destructive-foreground` `#0e1012` / `#ffffff`,
`--warning-foreground` `#0e1012` / `#ffffff`. Sidebar tokens mirror the
surfaces: dark `#14171b` / fg `#f2f5f7` / primary `#22d3ee` / accent
`#1a1e24` / border `#262b31`; light `#f7f8fa` / fg `#17191c` / primary
`#0e7490` / accent `#e2e5e9` / border `#e2e5e9`.

**Chart overrides.** The new theme defines `--chart-1..5` per variant (table
above) — the current `:root`-only chart block (`globals.css:37-42`) is what
makes Midnight inherit OG's warm charts today. **[open]** Midnight's charts
are deliberately NOT proposed here because Midnight is frozen; re-tinting
Midnight's charts (blue-family overrides to stop the warm inheritance) is a
separate decision.

**Verified `--golem-*` mascot derivation.** Dark Graphite needs no override —
the generic `:root` derivation (`globals.css:141-149`) resolves to a graphite
body with a cyan cast. Light Graphite has the same washing-out problem Light
has today (`globals.css:157-162`), so it carries the analogous verified
override, swapping the current light-blue base for soft cyan:

```css
/* light variant — mirrors the existing verified light override (globals.css:157-162), blue → cyan */
--golem-clay: color-mix(in srgb, var(--primary) 30%, #e8f4f7);
--golem-body: color-mix(in srgb, var(--primary) 22%, var(--golem-clay));
--golem-body-shade: color-mix(in srgb, var(--golem-body) 74%, #0a3b47);
--golem-body-light: color-mix(in srgb, var(--golem-body) 82%, #fff);
```

**The brown Golem goes away with the OG collapse.** The mascot body is
palette-derived: on OG, gold `#b8935a` primary + rust `#a85c3f` accent mix
into the brown/tan Golem Henry called out (see the warm `FALLBACK` in
`golem-colors.ts:30-37`). Under Graphite the body becomes graphite + cyan
cast, not brown. The per-model accent tint (`--golem-model-tint` /
`golemTintForModel`) is a separate provider-identity system and survives the
collapse — it is the accent on a monochrome body, not the body itself. Do not
treat the brown Golem as intentional brand.

### 2.4 Contrast / accessibility

**[decided]** WCAG AA is the floor: **4.5:1** for normal text, **3:1** for
large text and for UI components / graphical objects (WCAG 1.4.11).

- **Cyan is accent/state, not body text.** Cyan text only where it passes
  contrast on the surface directly behind it. Solid-cyan fills never carry
  cyan text — status presentation is tinted (e.g. `bg-primary/10` +
  `border-primary/40` + `text-primary`, the pattern already used across
  badges), which keeps cyan read as state, not surface.
- Measured against the §2.3 proposal (all pass): dark `#22d3ee` on card
  `#14171b` = **9.95:1**; dark `#22d3ee` on background `#0e1012` = **10.55:1**;
  light `#0e7490` on `#ffffff` = **5.36:1**; light `#0e7490` on
  `#f7f8fa` = **5.04:1**; dark muted `#8b949e` on `#0e1012` = **6.20:1**;
  light muted `#5b6470` on white = **6.00:1**. The reason the light primary is
  cyan-700 and not cyan-600: `#0891b2` on white is **3.68:1** — below the
  floor. The warning token was deepened for the same reason (`#b45309` on
  white = **5.02:1**; today's amber-500-style warning fails as text on light).
- Any token change to §2.3 must be re-measured against these targets before
  landing — do not ship a hex because it "looks fine".

---

## 3. Typography

**[open]** The current type system is a three-family mix that reads as
inconsistent. Flagged during the Batch 8.5 UI audit; deliberately left as an
open decision here, not silently resolved.

### 3.1 Current state (audited, Aug 2026)

Loaded in `src/app/layout.tsx:14-31` and mapped in `globals.css:259-264`:

| Font role | Family | Token | Use |
| --- | --- | --- | --- |
| Body / UI (sans) | Inter | `--font-sans` | Default body (`layout.tsx:75`) |
| Display / headings (serif) | Lora | `--font-display` (`--font-serif` is the same stack) | Page h1s across routes, `golem-logo`, `agent-mark`, markdown h1–h3 (`markdown-message.tsx:49-55`) |
| Labels / stats / values (mono) | IBM Plex Mono | `--font-mono` | Pervasive: labels, model names, timestamps, buttons, badges at `8–13px` (100+ sites) |

So the real pattern is **serif-display hero titles + sans body + tiny mono
labels**, not serif-hero + mono-body. The three voices fight: Lora's
illuminated-manuscript warmth is at odds with the heavy mono "instrument
panel" density, and Inter sits between them as the default without a role.

The `docs/typography-recommendation.md` file is **stale** — it describes
Space Grotesk / Geist / green-on-`#080808`, none of which exist in the
current implementation. Ignore it as a source of truth.

### 3.2 The decision to make

Pick one of two directions and record it here before implementing:

1. **Full-mono technical identity** — IBM Plex Mono (or a deliberate mono
   replacement) as the dominant voice: headings, labels, values all mono;
   serif display dropped. Strongest fit for the current UI texture; largest
   churn in headings and markdown rendering.
2. **A deliberate resolved pairing** — keep a two- or three-family system
   with an explicit hierarchy (e.g. serif display reserved for page-level
   hero moments only, mono strictly for data/labels, Inter for body) and
   enforce it. Keeps the Grimoire warmth; requires a typography lint pass.

Do not silently pick one during a UI batch — this is the kind of decision that
re-derives differently every time someone touches a heading.

---

## 4. Component Patterns

**[proposed]** The planned UI-overhaul direction for the unified workspace
(Forge / Missions / Agency) built up in Batch 8.5. Grounded in what the code
does today; the shared primitives do not exist yet.

### 4.1 Current duplication (audited, Aug 2026)

- **Workspace shell / tab strip.** The unified workspace bar is hand-rolled
  inline in `src/app/forge/page.tsx:1076-1097` (Forge / Missions / Agency),
  and Forge's Chat / Terminals sub-switcher repeats the same pattern at
  `forge/page.tsx:1109-1124`. Both are `font-mono text-[11px]` buttons with
  active state `bg-primary/15 text-primary`. Identical logic, zero sharing.
  All tabs stay mounted (CSS-hidden, not unmounted) so live state survives
  tab switches — that invariant must survive any extraction.
- **Status badges.** `Badge` is a **local** component in
  `src/components/missions/missions-workspace.tsx:100-106`, fed by
  `TASK_TONE` / `MISSION_TONE` tone maps (lines 80-98). The Agency tab
  (`src/components/agency/agency-workspace.tsx`) hand-rolls the same visual
  as `AuditBadge` (74-97) and an inline active/paused span (132-134). Three
  copies of one pattern.
- **Roster.** Missions renders the agent roster as a `<table>` (min-w 720px,
  `missions-workspace.tsx:516`); Agency renders the same data as cards
  (`agency-workspace.tsx:110-156`, flex-wrapped per layer, lines 311-329).
  Two renderings of the same source, maintained separately.
- **Org chart.** The Agency "org chart" today is cards grouped by layer — no
  connector lines. The data for a real hierarchy already exists:
  `agents.parent_id uuid references public.agents(id) on delete set null`
  with `idx_agents_parent`
  (`supabase/migrations/20260806030000_mission_spine.sql:40,49`). The
  `parentId` field is unused by any UI.

### 4.2 Planned primitives

- **`WorkspaceShell`** — the extracted unified workspace frame: tab bar +
  mounted-panel container (CSS-hidden panels preserving state). Replaces the
  inline bar at `forge/page.tsx:1076` and standardizes the `embedded` prop
  pattern already used by `MissionsWorkspace` / `AgencyWorkspace`.
- **`TabStrip`** — the one tab-bar primitive (primary Forge/Missions/Agency
  bar and Forge's Chat/Terminals sub-bar both consume it). Active state,
  icon+label, mono labels, per-tab `title` tooltips.
- **Shared status-badge system** — one badge component + one tone map,
  replacing the local `Badge` in `missions-workspace.tsx`, `AuditBadge` in
  `agency-workspace.tsx`, and the inline active/paused span. Tones stay
  token-derived (`border-*/bg-*/text-*` over tokens only — see the "Tokens
  only" rule at `missions-workspace.tsx:80`).
- **Org-chart connector lines** — render `parent_id` as real connecting
  lines between agent cards (or a dedicated node layout), upgrading the
  layer-grouped card grid in `agency-workspace.tsx:311-329`. The column and
  index exist; nothing reads them yet.

### 4.3 Phased build order

1. **Extract shared primitives with zero visual change.** `WorkspaceShell`
   + `TabStrip` + shared `Badge` first, byte-identical output. The `Badge`
   extraction is the safest first win (pure presentational, local scope).
2. **Org-chart connectors.** Turn the layer-grouped Agency cards into a
   real hierarchy using `parent_id`. This is the only phase with visible
   layout change.
3. **Merge roster table/cards.** One roster rendering for both Missions and
   Agency, deleting the second copy.
4. **Color / motion pass last.** Only after the structure is settled — this
   is where the two-theme collapse and the typography decision land.

Ordering is deliberate: phase 1 ships no visual diff (low risk, high
trust), and the color/motion pass is last so it runs against a single
settled component set instead of chasing moving markup.

---

## 5. What Not To Do

**[decided]**

- **No full-screen blur / backdrop overlays for panels.** The Grimoire
  quick-notes panel used a fixed blurred backdrop; Batch 8.5 removed it
  (`44e12aa`) in favor of a non-modal mousedown click-outside listener
  (`src/components/grimoire-floating-panel.tsx`), matching the sidebar's
  existing non-modal dropdown pattern. Panels stay dismissible without a
  modal overlay. Reintroducing a blurred full-screen backdrop is a
  regression.
- **Blender is 3D-mascot / Atelier only — never a 2D UI tool.** Blender
  renders the Golem mascot and Atelier assets, branched on backend and
  streamed back over the exec layer. It is not a 2D UI tool and must never
  be used as one.
- **No fourth theme without an explicit decision to add one.** The canonical
  count is two after the collapse. Adding a theme (or keeping Light/OG as
  permanent) is a product decision to record here first — not something a UI
  batch picks up as a side effect.
- **No raw Tailwind color classes** for design tokens — use the token system
  (`bg-primary`, `text-muted-foreground`, `border-border`, `surface-*`). See
  `src/lib/missions/` conventions and the "Tokens only" comment at
  `missions-workspace.tsx:80`.

---

## 6. Canonical Sources

- Theme tokens: `src/app/globals.css` (the only place tokens are defined).
- Theme switching: `src/components/top-bar.tsx` + the inline script in
  `src/app/layout.tsx` (both must change together on the two-theme collapse).
- Font loading / families: `src/app/layout.tsx:14-31`, mapping in
  `globals.css:259-264`.
- Workspace shell / tabs: `src/app/forge/page.tsx` (Batch 8.5, commit
  `44e12aa`).
- Roster / badges: `src/components/missions/missions-workspace.tsx`,
  `src/components/agency/agency-workspace.tsx`.
- Org-chart data: `agents.parent_id`
  (`supabase/migrations/20260806030000_mission_spine.sql:40,49`).
- Mascot palette: `src/components/golem/golem-colors.ts` (theme-token → WebGL
  bridge, `FALLBACK` warm swatches at lines 30-37) and the `--golem-*`
  derivation in `globals.css:141-175`.
- Naming rule: `AGENTS.md` ("Naming" section).