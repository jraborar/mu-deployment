import type { Metadata } from 'next'
import { Toaster } from 'sonner'
import { createClient } from '@/utils/supabase/server'
import { logout } from '@/app/auth/actions'
import './globals.css'

export const metadata: Metadata = {
  title: 'Mu Deployment | Pantheon',
  description: 'Deploy and schedule Pantheon site deployments across environments',
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-pantheon-bg text-pantheon-text antialiased">
        <header className="border-b border-pantheon-border bg-pantheon-bg-card">
          <div className="mx-auto flex max-w-5xl items-center gap-4 px-6 py-4">
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded bg-pantheon-yellow flex items-center justify-center">
                <span className="text-black font-bold text-xs tracking-tight">P</span>
              </div>
              <span className="font-mono font-semibold text-sm tracking-widest uppercase text-pantheon-text">
                Pantheon
              </span>
            </div>
            <span className="text-pantheon-border">|</span>
            <span className="text-pantheon-text-muted font-mono text-sm tracking-wide">
              MU Deployment
            </span>
            {user && (
              <div className="ml-auto flex items-center gap-4">
                <span className="font-mono text-xs text-pantheon-text-dim">{user.email}</span>
                <form action={logout}>
                  <button
                    type="submit"
                    className="rounded border border-pantheon-border px-3 py-1 font-mono text-xs text-pantheon-text-muted hover:border-pantheon-border-hi hover:text-pantheon-text transition-colors"
                  >
                    Sign out
                  </button>
                </form>
              </div>
            )}
          </div>
        </header>

        <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>

        <footer className="mt-16 border-t border-pantheon-border">
          <div className="mx-auto max-w-5xl px-6 py-4">
            <p className="font-mono text-xs text-pantheon-text-dim">
              Powered by Terminus · Pantheon Platform
            </p>
          </div>
        </footer>

        <Toaster theme="dark" position="bottom-right" />
      </body>
    </html>
  )
}
