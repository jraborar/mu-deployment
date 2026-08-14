import { type NextRequest, NextResponse } from 'next/server'

// Pass-through proxy — no blocking calls.
// Auth gating will be added here when enabled.
export function proxy(_request: NextRequest) {
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
