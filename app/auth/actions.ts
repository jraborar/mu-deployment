'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/utils/supabase/server'

export async function login(formData: FormData) {
  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({
    email:    formData.get('email') as string,
    password: formData.get('password') as string,
  })
  if (error) return { error: error.message }
  redirect('/')
}

export async function signup(formData: FormData) {
  const supabase = await createClient()
  const { error } = await supabase.auth.signUp({
    email:    formData.get('email') as string,
    password: formData.get('password') as string,
    options: {
      data: {
        full_name: formData.get('full_name') as string,
      },
    },
  })
  if (error) return { error: error.message }
  return { success: 'Check your email for a confirmation link.' }
}

export async function forgotPassword(formData: FormData) {
  const supabase = await createClient()
  const { error } = await supabase.auth.resetPasswordForEmail(
    formData.get('email') as string,
    { redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/confirm?type=recovery` },
  )
  if (error) return { error: error.message }
  return { success: 'Check your email for a reset link.' }
}

export async function resetPassword(formData: FormData) {
  const supabase = await createClient()
  const { error } = await supabase.auth.updateUser({
    password: formData.get('password') as string,
  })
  if (error) return { error: error.message }
  redirect('/')
}

export async function logout() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/login')
}

export async function signInWithOAuth(provider: 'github' | 'google') {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`,
    },
  })
  if (error) return { error: error.message }
  // Return the URL — let the client redirect so NEXT_REDIRECT isn't
  // thrown inside an onClick handler, which Next.js 16 doesn't handle.
  return { url: data.url }
}
