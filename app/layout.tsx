import type { Metadata } from 'next'
import { Toaster } from 'sonner'
import UserMenu from '@/app/components/UserMenu'
import Header from '@/app/components/Header'
import Footer from '@/app/components/Footer'
import './globals.css'

export const metadata: Metadata = {
  title: 'Mu Deployment | Pantheon',
  description: 'Deploy and schedule Pantheon site deployments across environments',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen text-pantheon-text antialiased">
        <Header current="deployment" userMenu={<UserMenu />} />

        <main className="mx-auto max-w-3xl px-6 py-8">{children}</main>

        <Footer />

        <Toaster theme="dark" position="bottom-right" />
      </body>
    </html>
  )
}
