export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-pantheon-yellow flex items-center justify-center shadow-lg">
            <span className="text-slate-900 font-bold text-sm">P</span>
          </div>
          <span className="font-semibold text-sm tracking-widest uppercase text-slate-200">
            MU Deployment
          </span>
        </div>
        {children}
      </div>
    </div>
  )
}
