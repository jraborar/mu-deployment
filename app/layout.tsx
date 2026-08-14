import type { Metadata } from 'next'
import { Toaster } from 'sonner'
import UserMenu from '@/app/components/UserMenu'
import './globals.css'

export const metadata: Metadata = {
  title: 'Mu Deployment | Pantheon',
  description: 'Deploy and schedule Pantheon site deployments across environments',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen text-pantheon-text antialiased">
        <div className="border-b border-slate-700/40 bg-slate-900/60 backdrop-blur-sm sticky top-0 z-10">
          <div className="mx-auto flex max-w-3xl items-center justify-end px-6 py-2">
            <UserMenu />
          </div>
        </div>

        <main className="mx-auto max-w-3xl px-6 py-8">{children}</main>

        <footer className="mt-16 border-t border-slate-700/60">
          <div className="mx-auto max-w-3xl px-6 py-5 space-y-1">
            <p className="font-mono text-xs text-white">
              Powered by{' '}
              <span className="text-pantheon-yellow">Next.js 16</span>
              {' · '}
              <span className="text-pantheon-yellow">Terminus</span>
              {' · '}
              <span className="text-pantheon-yellow">Supabase</span>
              {' · '}
              <span className="text-pantheon-yellow">Tailwind v4</span>
              {' · '}
              <span className="text-pantheon-yellow">Pantheon Platform</span>
            </p>
            <p className="font-mono text-xs text-white">
              Created by and for{' '}
              <span className="text-pantheon-yellow">PS MU Team</span>
              {' · '}
              © 2026
            </p>
          </div>
        </footer>

        <Toaster theme="dark" position="bottom-right" />
      </body>
    </html>
  )
}
