// The voices agents can speak in.
//
// ─── Why a curated list and not all 54 ────────────────────────────────
// hexgrad/Kokoro-82M ships 54 voice packs across nine languages. Almost all of
// them are wrong for this: the agents answer in English, and a Japanese or
// Mandarin voice pack fed English text produces confident nonsense rather than
// an accent. So this is the English set only, and within that the ones that are
// actually distinguishable by ear — picking between eleven American women whose
// packs differ by a few Hz is not a choice, it is a coin flip with extra steps.
//
// ─── The first letter is not decoration ───────────────────────────────
// Kokoro's pipeline is constructed with a lang_code, and it drives
// phonemisation. Running bm_george (British) through lang_code 'a' (American)
// does not produce a British voice reading American phonemes — it produces a
// mispronounced mess, and Kokoro only warns. The prefix of every voice id IS
// its lang_code, which is why langCodeFor derives it rather than trusting a
// caller to pass a matching pair.

export interface VoiceOption {
  id: string
  label: string
  accent: 'british' | 'american'
  /** The voice pack's own gender, as published. */
  gender: 'male' | 'female'
  /** What it sounds like, so the dropdown can be read before it is heard. */
  note: string
}

export const VOICES: VoiceOption[] = [
  { id: 'bm_george', label: 'George', accent: 'british', gender: 'male', note: 'measured British butler — the Jarvis one' },
  { id: 'bm_lewis', label: 'Lewis', accent: 'british', gender: 'male', note: 'lower, drier British male' },
  { id: 'bf_emma', label: 'Emma', accent: 'british', gender: 'female', note: 'warm British female' },
  { id: 'bf_isabella', label: 'Isabella', accent: 'british', gender: 'female', note: 'crisper British female' },
  { id: 'af_heart', label: 'Heart', accent: 'american', gender: 'female', note: 'bright American female' },
  { id: 'af_bella', label: 'Bella', accent: 'american', gender: 'female', note: 'fuller, slower American female' },
  { id: 'af_sarah', label: 'Sarah', accent: 'american', gender: 'female', note: 'neutral American female' },
  { id: 'af_sky', label: 'Sky', accent: 'american', gender: 'female', note: 'lighter, younger American female' },
  { id: 'am_adam', label: 'Adam', accent: 'american', gender: 'male', note: 'plain American male' },
  { id: 'am_michael', label: 'Michael', accent: 'american', gender: 'male', note: 'deeper American male' },
]

const BY_ID = new Map(VOICES.map((v) => [v.id, v]))

/**
 * The rotation new agents are assigned from, in order.
 *
 * Deliberately maximally different from each other rather than "the four best":
 * the point of a per-agent voice is telling agents apart without looking, and
 * two American women in adjacent slots defeats that. British male → American
 * female → American male → British female alternates both axes every step.
 */
export const DEFAULT_ROTATION = ['bm_george', 'af_heart', 'am_adam', 'bf_emma'] as const

export const FALLBACK_VOICE = DEFAULT_ROTATION[0]

export function isVoiceId(value: unknown): value is string {
  return typeof value === 'string' && BY_ID.has(value)
}

export function voiceOption(id: string): VoiceOption | null {
  return BY_ID.get(id) ?? null
}

/**
 * The lang_code Kokoro's pipeline must be built with for this voice.
 *
 * Unknown ids fall back to American English rather than throwing: this is
 * called on a stored value, and a voice id that has since left the catalog
 * should degrade to a working voice, not a 500 on every reply.
 */
export function langCodeFor(voiceId: string): string {
  const prefix = voiceId[0]
  return prefix === 'b' ? 'b' : 'a'
}

/**
 * Which voice an agent speaks in when nobody has chosen one.
 *
 * Round-robin over creation order, so the roster comes out audibly varied
 * before Henry touches anything, and — because creation order never changes —
 * an agent keeps the same default forever. Assigning by a hash of the id would
 * also be stable but would happily give the first three agents the same voice.
 *
 * `agentIdsByCreation` must be every agent, oldest first; passing a filtered
 * list would shift everyone's default when the filter changes.
 */
export function defaultVoiceFor(agentId: string, agentIdsByCreation: string[]): string {
  const index = agentIdsByCreation.indexOf(agentId)
  if (index < 0) return FALLBACK_VOICE
  return DEFAULT_ROTATION[index % DEFAULT_ROTATION.length]
}
