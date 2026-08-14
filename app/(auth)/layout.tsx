export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-pantheon-bg flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <div className="h-8 w-8 rounded bg-pantheon-yellow flex items-center justify-center">
            <span className="text-black font-bold text-sm">P</span>
          </div>
          <span className="font-mono text-sm tracking-widest uppercase text-pantheon-text">
            MU Deployment
          </span>
        </div>
        {children}
      </div>
    </div>
  )
}
