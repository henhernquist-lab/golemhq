// Without this the script read NEXTAUTH_SECRET out of an environment nothing
// had populated and failed inside hkdf with `"ikm" must be an instance of
// Uint8Array or a string` — an error that names the crypto argument, not the
// missing variable. Same shared loader the app uses; never a hand-rolled one.
import './load-env.mjs'

import { encode } from '/workspaces/enry.agent/node_modules/.pnpm/@auth+core@0.41.2/node_modules/@auth/core/jwt.js'

const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET
if (!secret) throw new Error('mint-session: neither AUTH_SECRET nor NEXTAUTH_SECRET is set in .env.local')
const token = await encode({
  token: { googleId: '108422475472513497457', email: 'hhernqui9241@apsk12.org', name: 'Henry', sub: '108422475472513497457' },
  secret,
  salt: 'authjs.session-token',
})
console.log(token)
