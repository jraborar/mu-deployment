import { NextResponse } from 'next/server'
import { createClient } from '@/utils/supabase/server'

/**
 * OAuth / PKCE callback.
 *
 * Two fixes over the previous version, both already present in mu-staging:
 *
 * 1. ORIGIN. `new URL(request.url).origin` resolves to the INTERNAL container
 *    address behind Railway's proxy (https://localhost:8080), so redirecting to
 *    it sends the visitor's browser to their own machine — the "OAuth sends me
 *    to localhost" bug. RAILWAY_PUBLIC_DOMAIN is a runtime value Railway always
 *    sets to the correct public host, and is never baked at build time.
 *
 * 2. ERRORS. Supabase can redirect here with a provider error and NO code — an
 *    unenabled or misconfigured provider arrives exactly that way. The previous
 *    version collapsed every failure into a generic `auth_callback_failed`,
 *    and the login page did not display even that.
 */
function publicOrigin(request: Request): string {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN
  if (domain) return `https://${domain}`
  return process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const origin = publicOrigin(request)
  const code = searchParams.get('code')

  // Only same-site paths, so ?next=https://evil.example cannot turn the
  // callback into an open redirect.
  const raw = searchParams.get('next') ?? '/'
  const next = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/'

  const providerError = searchParams.get('error_description') || searchParams.get('error')

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) return NextResponse.redirect(`${origin}${next}`)
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error.message)}`)
  }

  const msg = providerError || 'No authorization code was returned from the provider.'
  return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(msg)}`)
}
