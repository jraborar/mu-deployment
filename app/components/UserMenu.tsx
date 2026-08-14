'use client'

import { useEffect, useState } from 'react'
import { logout } from '@/app/auth/actions'

export default function UserMenu() {
  const [email, setEmail] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    fetch('/api/me')
      .then(r => r.json())
      .then(({ email }) => { setEmail(email); setLoaded(true) })
      .catch(() => setLoaded(true))
  }, [])

  if (!loaded) return null

  return (
    <div className="ml-auto flex items-center gap-4">
      {email && (
        <span className="font-mono text-xs text-pantheon-yellow hidden sm:block">{email}</span>
      )}
      <form action={logout}>
        <button
          type="submit"
          className="rounded-lg border border-pantheon-yellow/60 px-3 py-1.5 text-xs text-pantheon-yellow hover:bg-pantheon-yellow/10 transition-colors"
        >
          Sign out
        </button>
      </form>
    </div>
  )
}
