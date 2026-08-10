/**
 * /api/voice — is voice mode actually usable right now?
 *
 * Exists so the UI can decide before the user commits to anything. The venv
 * lives on /tmp and a Codespace restart wipes it, so "unavailable" is a normal
 * state; a mic button that records into a void because nothing checked first
 * is the failure this endpoint prevents.
 */

import { requireHenryOwner } from '@/lib/auth-owner'
import { voiceStatus } from '@/lib/voice'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

export async function GET() {
  const gate = await requireHenryOwner()
  if (gate.response) return gate.response

  return Response.json(await voiceStatus())
}
