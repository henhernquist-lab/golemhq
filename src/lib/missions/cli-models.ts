// Which registry models a given builder CLI can actually be pointed at.
//
// The Agency model selector used to offer every chat-scoped model to every
// builder, which is wrong: `claude --permission-mode acceptEdits` cannot run
// Gemini, and picking one silently did nothing. It also rendered a disabled
// "logic · no CLI" control for Layer 1 and Layer 3 agents, which are logic
// modules with no CLI and no model to assign at all.
//
// Honesty rule: only two of the enabled builders have a family that is
// knowable from this repo — the CLI is the vendor's own and only runs that
// vendor's models. The rest (OpenCode, Hermes, Crush) are multi-provider
// front-ends whose supported list is configured host-side and is NOT
// discoverable from here. For those we say so and fall back to the full
// registry rather than inventing a list or showing a dead placeholder.

import { listModels } from '@/lib/nim'

/** CLI binary → matcher against the registry's `company` field. */
const CLI_FAMILY: { match: RegExp; company: RegExp }[] = [
  { match: /^claude\b/, company: /anthropic/i },
  { match: /^gemini\b/, company: /google/i },
]

export interface CliModelChoices {
  models: { id: string; label: string }[]
  /** True when the list is the whole registry because the CLI's real
   *  supported set cannot be determined programmatically. */
  unfiltered: boolean
}

/**
 * `null` means: this agent takes no model at all (no CLI), so the caller must
 * render no selector — not a disabled one.
 */
export function modelChoicesForCli(cliCommand: string | null | undefined): CliModelChoices | null {
  const cli = cliCommand?.trim()
  if (!cli) return null

  const all = listModels('chat').map((m) => ({ id: m.id, label: m.label, company: m.company ?? '' }))
  const family = CLI_FAMILY.find((f) => f.match.test(cli))
  if (!family) return { models: all.map(({ id, label }) => ({ id, label })), unfiltered: true }

  const matched = all.filter((m) => family.company.test(m.company)).map(({ id, label }) => ({ id, label }))
  // A vendor CLI with nothing matching in the registry is a registry gap, not
  // a reason to offer it models it cannot run.
  return { models: matched, unfiltered: false }
}
