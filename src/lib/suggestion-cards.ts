// The homepage suggestion pool — 7 sets of 4, one set per weekday.
//
// Extracted from center-panel.tsx so the mascot's click-to-fire can draw from
// the same 28 cards the homepage rotates through, rather than keeping a second
// copy that drifts out of sync.

export interface SuggestionCard {
  label: string
  glyph: string
  prompt: string
  description: string
}

export const CARDS_PER_DAY = 4

export const SUGGESTION_CARD_POOL: SuggestionCard[] = [
  // Set 0 — Mon
  { label: 'Explain a concept', glyph: '?', prompt: 'Explain ', description: 'Break down complex topics into simple explanations' },
  { label: 'Research a topic', glyph: '🔍', prompt: 'Research and summarize: ', description: 'Deep-dive into any topic with cited sources' },
  { label: 'Write code', glyph: '<>', prompt: 'Write code to build a todo app', description: 'Generate, refactor, and debug code in any language' },
  { label: 'Debug my code', glyph: '🐛', prompt: 'Debug this code: ', description: 'Find and fix bugs with detailed explanations' },
  // Set 1 — Tue
  { label: 'Search the web', glyph: '/', prompt: 'Search the web for the latest AI news', description: 'Find real-time information from across the internet' },
  { label: 'Summarize a URL', glyph: '↗', prompt: 'Summarize the content at this URL: ', description: 'Extract key insights from any webpage' },
  { label: 'Refactor code', glyph: '♻', prompt: 'Refactor this code to ', description: 'Improve code structure without changing behavior' },
  { label: 'Plan my week', glyph: '📅', prompt: 'Help me plan my week. I need to: ', description: 'Organize tasks and schedule your week efficiently' },
  // Set 2 — Wed
  { label: 'Analyze data', glyph: '📊', prompt: 'Analyze this data: ', description: 'Find patterns and insights in your data' },
  { label: 'Check my email', glyph: '@', prompt: 'Check my email for new messages', description: 'Read and draft email responses' },
  { label: 'Draft an email', glyph: '✉', prompt: 'Draft an email that ', description: 'Compose professional or personal emails quickly' },
  { label: 'Extract action items', glyph: '✓', prompt: 'Extract the action items from: ', description: 'Pull to-dos and next steps out of any text' },
  // Set 3 — Thu
  { label: 'Write a blog post', glyph: '📝', prompt: 'Write a blog post about ', description: 'Draft engaging long-form content on any topic' },
  { label: 'Design a system', glyph: '🏗', prompt: 'Design a system architecture for ', description: 'Plan scalable, maintainable system designs' },
  { label: 'Compare options', glyph: '⚖', prompt: 'Compare ', description: 'Evaluate trade-offs between different approaches' },
  { label: 'Review my code', glyph: '👀', prompt: 'Review this code for issues: ', description: 'Get a thorough code review with actionable feedback' },
  // Set 4 — Fri
  { label: 'Write tests', glyph: '🧪', prompt: 'Write tests for this code: ', description: 'Generate unit and integration test coverage' },
  { label: 'Translate code', glyph: '🔄', prompt: 'Translate this code from ', description: 'Port code between languages or frameworks' },
  { label: 'Optimize performance', glyph: '⚡', prompt: 'Optimize the performance of: ', description: 'Profile and speed up slow code or queries' },
  { label: 'Brainstorm ideas', glyph: '💡', prompt: 'Brainstorm ideas for ', description: 'Generate creative approaches to any problem' },
  // Set 5 — Sat
  { label: 'Summarize a paper', glyph: '📄', prompt: 'Summarize this research paper: ', description: 'Extract key findings from academic papers' },
  { label: 'Learn a new skill', glyph: '🎯', prompt: 'Teach me the basics of ', description: 'Get a structured crash course on any topic' },
  { label: 'Create a workout', glyph: '🏋', prompt: 'Create a workout plan for ', description: 'Design a training program tailored to your goals' },
  { label: 'Write documentation', glyph: '📚', prompt: 'Write documentation for ', description: 'Generate clear, structured docs for any codebase' },
  // Set 6 — Sun
  { label: 'Audit my codebase', glyph: '🔬', prompt: 'Audit this codebase for ', description: 'Scan for security, performance, and style issues' },
  { label: 'Generate a script', glyph: '📜', prompt: 'Write a script that ', description: 'Create automation scripts for any task' },
  { label: 'Mock an interview', glyph: '🎤', prompt: 'Mock interview me for ', description: 'Practice technical or behavioral interviews' },
  { label: 'Plan a project', glyph: '🗺', prompt: 'Help me plan a project to ', description: 'Break down goals into milestones and tasks' },
]

/** The 4 cards the homepage is showing today. */
export function getDailySuggestionCards(now: number = Date.now()): SuggestionCard[] {
  const dayIndex = Math.floor(now / 86400000) % 7
  return SUGGESTION_CARD_POOL.slice(dayIndex * CARDS_PER_DAY, dayIndex * CARDS_PER_DAY + CARDS_PER_DAY)
}

/** Any card from the full pool — what clicking Golem fires. */
export function randomSuggestionCard(): SuggestionCard {
  return SUGGESTION_CARD_POOL[Math.floor(Math.random() * SUGGESTION_CARD_POOL.length)]
}
