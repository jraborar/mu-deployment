'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/utils/supabase/client'
import { logout } from '@/app/auth/actions'

export default function UserMenu() {
  const [email, setEmail] = useState<string | null>(null)

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
    })
  }, [])

  if (!email) return null

  return (
    <div className="ml-auto flex items-center gap-4">
      <span className="font-mono text-xs text-pantheon-text-dim">{email}</span>
      <form action={logout}>
        <button
          type="submit"
          className="rounded border border-pantheon-border px-3 py-1 font-mono text-xs text-pantheon-text-muted hover:border-pantheon-border-hi hover:text-pantheon-text transition-colors"
        >
          Sign out
        </button>
      </form>
    </div>
  )
}
