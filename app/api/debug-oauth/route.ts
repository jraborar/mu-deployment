import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

export async function GET() {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN
  const nextPublic = process.env.NEXT_PUBLIC_APP_URL
  const origin = domain ? `https://${domain}` : (nextPublic || 'http://localhost:3000')

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'github',
    options: { redirectTo: `${origin}/auth/callback` },
  })

  return Response.json({
    RAILWAY_PUBLIC_DOMAIN: domain,
    NEXT_PUBLIC_APP_URL: nextPublic,
    computed_origin: origin,
    redirect_to: `${origin}/auth/callback`,
    oauth_url: data?.url ?? null,
    error: error?.message ?? null,
  })
}
