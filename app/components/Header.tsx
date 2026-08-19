import type { ReactNode } from 'react'
import { Terminal, Rocket, ScanEye, type LucideIcon } from 'lucide-react'
import { APPS, SWITCHER, type AppKey } from '@/app/components/appNav'

// Shared MU header chrome. Identical across the three apps — only the `current`
// prop (and each app's optional user-menu) differs. Per-app brand mark lives
// here so the family stays consistent: >_ Staging, Rocket Deployment, ScanEye VRT.

const BRAND: Record<AppKey, { icon: LucideIcon; name: string }> = {
  staging:    { icon: Terminal, name: 'WP Staging' },
  deployment: { icon: Rocket,   name: 'Deployment' },
  vrt:        { icon: ScanEye,  name: 'Visual Regression' },
}

export default function Header({
  current,
  userMenu,
}: {
  current: AppKey
  userMenu?: ReactNode
}) {
  const brand = BRAND[current]
  const BrandIcon = brand.icon
  const items = SWITCHER[current]

  return (
    <header className="sticky top-0 z-20 border-b border-slate-700/40 bg-slate-900/60 backdrop-blur-sm">
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-6 py-3">
        {/* Brand — single row, text-sm to match the other apps' header text */}
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-pantheon-yellow text-slate-900 shadow-[inset_0_0_0_1px_var(--color-pantheon-yellow-dark)]">
            <BrandIcon className="h-4 w-4" strokeWidth={2.5} />
          </span>
          <span className="font-mono text-sm font-bold text-pantheon-text">{brand.name}</span>
        </div>

        {/* App switcher */}
        <nav className="ml-1 flex gap-0.5">
          {items.map((key) => {
            const app = APPS[key]
            const active = key === current
            return (
              <a
                key={key}
                href={active ? '#' : app.url}
                aria-current={active ? 'page' : undefined}
                className={[
                  'rounded-md px-3 py-1.5 font-mono text-sm transition-colors',
                  active
                    ? 'border border-pantheon-yellow/35 bg-pantheon-yellow/[0.06] text-pantheon-yellow'
                    : 'border border-transparent text-pantheon-text-muted hover:bg-pantheon-bg-elevated/40 hover:text-pantheon-text',
                ].join(' ')}
              >
                {app.label}
              </a>
            )
          })}
        </nav>

        {/* User menu slot (empty in apps without auth) */}
        <div className="ml-auto flex items-center">{userMenu}</div>
      </div>
    </header>
  )
}
