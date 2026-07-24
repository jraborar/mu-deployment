// Pure utilities — no Node.js dependencies, safe for client and server

export function computeStages(source: string, destination: string): string[] {
  const all = ['dev', 'test', 'live']
  const destIdx = all.indexOf(destination)
  if (destIdx === -1) return []
  if (['dev', 'test', 'live'].includes(source)) {
    const srcIdx = all.indexOf(source)
    if (destIdx <= srcIdx) return []
    return all.slice(srcIdx + 1, destIdx + 1)
  }
  return all.slice(0, destIdx + 1)
}

// Matches exactly prefix-YYMMDD to avoid accidentally deleting unrelated multidevs
export function findByPrefix(list: string, prefix: string): string | null {
  const re = new RegExp(`^${prefix}-\\d{6}$`)
  for (const line of list.split('\n')) {
    const trimmed = line.trim()
    if (re.test(trimmed)) return trimmed
  }
  return null
}

// ── Schedule date helpers ─────────────────────────────────────────────────────

// Parses the creation date embedded in a multidev name ending in YYMMDD
// e.g. "mu-260722" → Date(2026, 6, 22)
export function parseMuSourceDate(source: string): Date | null {
  const match = source.match(/(\d{2})(\d{2})(\d{2})$/)
  if (!match) return null
  const year  = 2000 + parseInt(match[1], 10)
  const month = parseInt(match[2], 10) - 1   // 0-indexed
  const day   = parseInt(match[3], 10)
  const date  = new Date(year, month, day)
  return isNaN(date.getTime()) ? null : date
}

export function addBusinessDays(start: Date, days: number): Date {
  const result = new Date(start)
  let added = 0
  while (added < days) {
    result.setDate(result.getDate() + 1)
    const dow = result.getDay()
    if (dow !== 0 && dow !== 6) added++   // skip Saturday (6) and Sunday (0)
  }
  return result
}

// Returns the datetime-local input value (YYYY-MM-DDTHH:mm) for a given date at 9 AM.
// Returns '' for invalid dates so the input stays empty rather than showing NaN-NaN-NaN.
export function toDatetimeLocal(date: Date): string {
  if (!date || isNaN(date.getTime())) return ''
  const p = (n: number) => n.toString().padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T09:00`
}
