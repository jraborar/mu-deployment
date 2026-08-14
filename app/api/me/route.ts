import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    return Response.json({ email: user?.email ?? null })
  } catch {
    return Response.json({ email: null })
  }
}
