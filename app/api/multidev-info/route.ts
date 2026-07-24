import { run } from '@/lib/terminus'

export const runtime = 'nodejs'

const INPUT_RE = /^[a-z0-9.\-_]+$/i

const DATE_FIELDS = [
  'created', 'Created',
  'date_created', 'Date_Created',
  'created_at', 'Created_At',
  'creation_date', 'initialized',
]

// Terminus plugins sometimes emit PHP deprecation/warning lines to stdout.
// Strip those before attempting JSON parse.
function cleanTerminusOutput(raw: string): string {
  return raw
    .split('\n')
    .filter(l => !l.match(/^\s*(Deprecated|Warning|Notice|PHP):/i))
    .join('\n')
    .trim()
}

// Find and parse the first JSON object or array in the output,
// tolerating any leading junk lines.
function parseTerminusJSON(raw: string): Record<string, unknown> | Record<string, unknown>[] | null {
  const cleaned = cleanTerminusOutput(raw)
  const start = cleaned.search(/[{[]/)
  if (start === -1) return null
  try {
    return JSON.parse(cleaned.slice(start))
  } catch {}
  return null
}

function extractDate(obj: Record<string, unknown>): string | null {
  for (const field of DATE_FIELDS) {
    const val = obj[field]
    if (!val) continue

    let date: Date
    if (typeof val === 'number') {
      // Unix timestamp — try seconds then milliseconds
      date = new Date(val > 1e10 ? val : val * 1000)
    } else if (typeof val === 'string') {
      // Terminus returns "YYYY-MM-DD HH:MM:SS" — normalize space to T for ISO 8601
      date = new Date(val.replace(' ', 'T'))
    } else continue

    if (!isNaN(date.getTime())) return date.toISOString()
  }
  return null
}

function findInList(raw: string, source: string): string | null {
  const parsed = parseTerminusJSON(raw)
  if (!parsed) return null
  const items = (Array.isArray(parsed)
    ? parsed
    : Object.values(parsed)) as Record<string, unknown>[]
  const entry = items.find((e: Record<string, unknown>) =>
    e.id === source || e.name === source ||
    e.Name === source || e.ID === source ||
    e.environment === source
  )
  if (entry) {
    console.log(`[multidev-info] matched entry keys:`, Object.keys(entry))
    return extractDate(entry as Record<string, unknown>)
  }
  return null
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const site   = searchParams.get('site')?.trim()
  const source = searchParams.get('source')?.trim()

  if (!site || !source || !INPUT_RE.test(site) || !INPUT_RE.test(source)) {
    return Response.json({ error: 'Invalid params' }, { status: 400 })
  }

  // 1. terminus env:info — capture stderr too so PHP warnings don't pollute stdout check
  const infoResult = await run(`terminus env:info ${site}.${source} --format=json 2>&1`)
  console.log(`[multidev-info] env:info exit=${infoResult.code} raw=${infoResult.stdout.slice(0, 200)}`)
  const infoData = parseTerminusJSON(infoResult.stdout)
  if (infoData && !Array.isArray(infoData)) {
    console.log(`[multidev-info] env:info keys:`, Object.keys(infoData))
    const created = extractDate(infoData)
    if (created) return Response.json({ created })
  }

  // 2. terminus multidev:list
  const multidevResult = await run(`terminus multidev:list ${site} --format=json 2>&1`)
  console.log(`[multidev-info] multidev:list exit=${multidevResult.code}`)
  if (multidevResult.stdout) {
    const created = findInList(multidevResult.stdout, source)
    if (created) return Response.json({ created })
  }

  // 3. terminus env:list — covers all envs including autopilot
  const envListResult = await run(`terminus env:list ${site} --format=json 2>&1`)
  console.log(`[multidev-info] env:list exit=${envListResult.code} raw=${envListResult.stdout.slice(0, 300)}`)
  if (envListResult.stdout) {
    const created = findInList(envListResult.stdout, source)
    if (created) return Response.json({ created })
    // Log first entry shape so we know what fields terminus actually returns
    const parsed = parseTerminusJSON(envListResult.stdout)
    if (parsed) {
      const items = Array.isArray(parsed) ? parsed : Object.values(parsed)
      if (items[0]) console.log(`[multidev-info] env:list first entry:`, JSON.stringify(items[0]).slice(0, 300))
    }
  }

  console.log(`[multidev-info] no creation date found for ${site}.${source}`)
  return Response.json({ created: null })
}
