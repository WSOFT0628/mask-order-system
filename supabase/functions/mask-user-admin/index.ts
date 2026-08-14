import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const allowedOrigin = 'https://wsoft0628.github.io'
const cors = {
  'Access-Control-Allow-Origin': allowedOrigin,
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
}

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return reply({ error: 'METHOD_NOT_ALLOWED' }, 405)

  try {
    const url = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const authorization = req.headers.get('Authorization') || ''
    const token = authorization.replace(/^Bearer\s+/i, '')
    if (!token) return reply({ error: 'NOT_AUTHENTICATED' }, 401)

    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: authData, error: authError } = await admin.auth.getUser(token)
    if (authError || !authData.user) return reply({ error: 'INVALID_SESSION' }, 401)

    const callerId = authData.user.id
    const { data: caller } = await admin.from('mask_app_members')
      .select('role,approved').eq('user_id', callerId).maybeSingle()
    if (!caller?.approved || caller.role !== 'admin') return reply({ error: 'ADMIN_ONLY' }, 403)

    const input = await req.json()
    const action = String(input.action || '')

    if (action === 'list') {
      const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
      if (error) throw error
      const { data: members, error: memberError } = await admin.from('mask_app_members').select('*')
      if (memberError) throw memberError
      const memberMap = new Map((members || []).map((m) => [m.user_id, m]))
      return reply({ users: data.users.map((u) => ({
        user_id: u.id,
        email: u.email || '',
        display_name: memberMap.get(u.id)?.display_name || u.user_metadata?.display_name || '',
        role: memberMap.get(u.id)?.role || 'staff',
        approved: memberMap.get(u.id)?.approved ?? false,
        must_change_password: memberMap.get(u.id)?.must_change_password ?? false,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at,
        disabled: !!u.banned_until && new Date(u.banned_until).getTime() > Date.now(),
      })) })
    }

    if (action === 'create') {
      const email = String(input.email || '').trim().toLowerCase()
      const password = String(input.password || '')
      const displayName = String(input.display_name || '').trim()
      const role = ['admin', 'staff', 'viewer'].includes(input.role) ? input.role : 'staff'
      if (!/^\S+@\S+\.\S+$/.test(email)) return reply({ error: 'INVALID_EMAIL' }, 400)
      if (password.length < 10) return reply({ error: 'PASSWORD_TOO_SHORT' }, 400)
      const { data, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { display_name: displayName },
      })
      if (error || !data.user) throw error || new Error('CREATE_FAILED')
      const { error: profileError } = await admin.from('mask_app_members').upsert({
        user_id: data.user.id, email, display_name: displayName, role,
        approved: true, must_change_password: true, updated_at: new Date().toISOString(),
      })
      if (profileError) throw profileError
      return reply({ ok: true, user_id: data.user.id })
    }

    const userId = String(input.user_id || '')
    if (!userId) return reply({ error: 'USER_REQUIRED' }, 400)

    if (action === 'update') {
      const role = ['admin', 'staff', 'viewer'].includes(input.role) ? input.role : 'staff'
      const approved = Boolean(input.approved)
      if (userId === callerId && (!approved || role !== 'admin'))
        return reply({ error: 'CANNOT_REVOKE_SELF' }, 400)
      const { error } = await admin.from('mask_app_members').update({
        role, approved, display_name: String(input.display_name || '').trim(),
        updated_at: new Date().toISOString(),
      }).eq('user_id', userId)
      if (error) throw error
      const { error: banError } = await admin.auth.admin.updateUserById(userId, {
        ban_duration: approved ? 'none' : '876000h',
      })
      if (banError) throw banError
      return reply({ ok: true })
    }

    if (action === 'reset_password') {
      const password = String(input.password || '')
      if (password.length < 10) return reply({ error: 'PASSWORD_TOO_SHORT' }, 400)
      const { error } = await admin.auth.admin.updateUserById(userId, { password })
      if (error) throw error
      const { error: profileError } = await admin.from('mask_app_members').update({
        must_change_password: true, updated_at: new Date().toISOString(),
      }).eq('user_id', userId)
      if (profileError) throw profileError
      return reply({ ok: true })
    }

    return reply({ error: 'UNKNOWN_ACTION' }, 400)
  } catch (error) {
    console.error(error)
    return reply({ error: error?.message || 'INTERNAL_ERROR' }, 500)
  }
})
