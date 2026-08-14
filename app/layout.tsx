import type { Metadata } from 'next'
import { Toaster } from 'sonner'
import { Rocket } from 'lucide-react'
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
          <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-pantheon-yellow flex items-center justify-center shrink-0 shadow-lg">
                <Rocket className="w-5 h-5 text-slate-900" />
              </div>
              <div>
                <h1 className="text-base font-bold text-white leading-tight">MU Deployment</h1>
                <p className="text-slate-400 text-xs">Automated Pantheon pipeline deployments</p>
              </div>
            </div>
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
