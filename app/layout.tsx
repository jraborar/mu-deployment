import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Mu Deployment | Pantheon',
  description: 'Deploy and schedule Pantheon site deployments across environments',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-pantheon-bg text-pantheon-text antialiased">
        <header className="border-b border-pantheon-border bg-pantheon-bg-card">
          <div className="mx-auto flex max-w-5xl items-center gap-3 px-6 py-4">
            <div className="flex h-7 w-7 items-center justify-center rounded bg-pantheon-yellow">
              <span className="font-mono text-xs font-black text-black">P</span>
            </div>
            <span className="font-mono text-sm font-semibold text-pantheon-text">
              Pantheon MU Deployment
            </span>
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
      </body>
    </html>
  )
}
