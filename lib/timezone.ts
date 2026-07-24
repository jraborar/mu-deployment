const TZ = 'America/Los_Angeles'

export function getPacificYYMMDD(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: '2-digit', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const get = (t: string) => parts.find(p => p.type === t)!.value
  return `${get('year')}${get('month')}${get('day')}`
}

export function getPacificDisplay(): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date()).replace(',', ' ·')
}
