'use client'

import { useEffect, useState } from 'react'
import { logout } from '@/app/auth/actions'

export default function UserMenu() {
  const [display, setDisplay] = useState<string | null>(null)
  const [loaded, setLoaded]   = useState(false)

  useEffect(() => {
    fetch('/api/me')
      .then(r => r.json())
      .then(({ display }) => { setDisplay(display); setLoaded(true) })
      .catch(() => setLoaded(true))
  }, [])

  if (!loaded) return null

  return (
    <div className="ml-auto flex items-center gap-4">
      {display && (
        <span className="text-sm font-medium text-slate-300 hidden sm:block">{display}</span>
      )}
      <form action={logout}>
        <button
          type="submit"
          className="rounded-lg bg-pantheon-yellow hover:bg-pantheon-yellow-dark px-3 py-1.5 text-xs font-semibold text-slate-900 transition-colors"
        >
          Sign out
        </button>
      </form>
    </div>
  )
}
