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
        {/* Minimal top bar — just sign out, no branding (matches WP Staging pattern) */}
        <div className="border-b border-slate-700/40 bg-slate-900/60 backdrop-blur-sm sticky top-0 z-10">
          <div className="mx-auto flex max-w-3xl items-center justify-end px-6 py-2">
            <UserMenu />
          </div>
        </div>

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
