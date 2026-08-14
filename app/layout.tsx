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
        <header className="border-b border-slate-700/60 bg-slate-900/80 backdrop-blur-sm sticky top-0 z-10">
          <div className="mx-auto flex max-w-3xl items-center gap-4 px-6 py-4">
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-lg bg-pantheon-yellow flex items-center justify-center shadow-lg">
                <span className="text-slate-900 font-bold text-xs tracking-tight">P</span>
              </div>
              <span className="font-semibold text-sm tracking-widest uppercase text-slate-200">
                Pantheon
              </span>
            </div>
            <span className="text-slate-600">|</span>
            <span className="text-slate-400 text-sm tracking-wide">
              MU Deployment
            </span>
            <UserMenu />
          </div>
        </header>

        <main className="mx-auto max-w-3xl px-6 py-8">{children}</main>

        <footer className="mt-16 border-t border-slate-700/60">
          <div className="mx-auto max-w-3xl px-6 py-4">
            <p className="font-mono text-xs text-slate-500">
              Powered by Terminus · Pantheon Platform
            </p>
          </div>
        </footer>

        <Toaster theme="dark" position="bottom-right" />
      </body>
    </html>
  )
}
