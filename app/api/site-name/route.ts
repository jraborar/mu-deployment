import { run } from '@/lib/terminus'

export const runtime = 'nodejs'

const INPUT_RE = /^[a-z0-9.\-_]+$/i

function cleanTerminusOutput(raw: string): string {
  return raw
    .split('\n')
    .filter(l => !l.match(/^\s*(Deprecated|Warning|Notice|PHP):/i))
    .join('\n')
    .trim()
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const site = searchParams.get('site')?.trim()

  if (!site || !INPUT_RE.test(site)) {
    return Response.json({ error: 'Invalid site' }, { status: 400 })
  }

  const result = await run(`terminus site:info ${site} --format=json 2>&1`)
  const cleaned = cleanTerminusOutput(result.stdout)
  const start = cleaned.search(/[{[]/)
  if (start === -1) return Response.json({ label: null })

  try {
    const data = JSON.parse(cleaned.slice(start))
    const label = data?.label ?? data?.name ?? null
    return Response.json({ label })
  } catch {
    return Response.json({ label: null })
  }
}
