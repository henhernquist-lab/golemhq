import './load-env.mjs'
const { supabase } = await import('../src/lib/supabase.ts')
const { data: profiles } = await supabase.from('profiles').select('id, google_id, email').limit(5)
console.log('profiles:', JSON.stringify(profiles))
