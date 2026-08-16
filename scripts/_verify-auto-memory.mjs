import './load-env.mjs'
const { extractAndSaveAutoMemories } = await import('../src/lib/auto-memory.ts')
const { supabase } = await import('../src/lib/supabase.ts')

const RESOURCE_USER_ID = 'ed584571-8d0b-42fd-a871-cb7373638888'
const GOOGLE_ID = '108422475472513497457'
const marker = `QA-${Date.now()}`

console.log('marker:', marker)

const messages = [
  { role: 'user', parts: [{ type: 'text', text: 'What is 2+2? Answer in one word.' }] },
  { role: 'assistant', parts: [{ type: 'text', text: 'Four.' }] },
  { role: 'user', parts: [{ type: 'text', text: 'What is the capital of France? Answer in one word.' }] },
  { role: 'assistant', parts: [{ type: 'text', text: 'Paris.' }] },
  { role: 'user', parts: [{ type: 'text', text: `Just so you know, for this test my callsign is ${marker} and I always want you to remember it as a durable fact about me.` }] },
]

console.log('calling extractAndSaveAutoMemories (real LLM extraction call + real DB write)...')
await extractAndSaveAutoMemories(RESOURCE_USER_ID, GOOGLE_ID, messages)
console.log('extraction call finished')

const { data, error } = await supabase
  .from('resources')
  .select('id, source, title, payload, created_at')
  .eq('user_id', RESOURCE_USER_ID)
  .eq('type', 'memory')
  .order('created_at', { ascending: false })
  .limit(5)

console.log('recent memory rows:', JSON.stringify(data, null, 2))
console.log('error:', error)

const found = (data ?? []).find((r) => JSON.stringify(r.payload).includes(marker))
console.log('MARKER FOUND IN A NEW PENDING RESOURCES ROW:', !!found)
if (found) console.log('found row:', JSON.stringify(found, null, 2))
