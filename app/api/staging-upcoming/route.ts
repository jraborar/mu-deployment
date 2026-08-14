export const runtime = 'nodejs'

export async function GET() {
  const stagingUrl = process.env.MU_STAGING_URL
  if (!stagingUrl) {
    return Response.json({ error: 'MU_STAGING_URL not configured' }, { status: 503 })
  }

  try {
    const res = await fetch(`${stagingUrl}/api/upcoming`, {
      next: { revalidate: 60 }, // cache 1 min
    })
    if (!res.ok) return Response.json([], { status: 200 })
    const data = await res.json()
    return Response.json(data)
  } catch {
    return Response.json([], { status: 200 })
  }
}
