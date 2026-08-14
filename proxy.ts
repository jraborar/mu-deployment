import { type NextRequest, NextResponse } from 'next/server'

// Minimal pass-through middleware — no blocking Supabase calls.
// Session refresh is handled client-side via UserMenu.
// Auth gating will be added here once enabled.
export function middleware(_request: NextRequest) {
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
