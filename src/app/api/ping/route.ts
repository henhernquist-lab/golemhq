export const maxDuration = 10
export const dynamic = 'force-dynamic'

export async function GET() {
  return Response.json({ pong: true }, { status: 200 })
}
