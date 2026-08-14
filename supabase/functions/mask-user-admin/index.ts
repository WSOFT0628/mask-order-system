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
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const input = await req.json()
    const action = String(input.action || '')
    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    // 自訂帳號登入：只回傳登入結果，不公開帳號所綁定的 Auth Email。
    if (action === 'login') {
      const username = String(input.username || '').trim().toLowerCase()
      const password = String(input.password || '')
      if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username) || !password)
        return reply({ error: 'INVALID_CREDENTIALS' }, 400)
      const { data: member } = await admin.from('mask_app_members')
        .select('email,approved').ilike('username', username).maybeSingle()
      if (!member?.approved || !member.email) return reply({ error: 'INVALID_CREDENTIALS' }, 401)
      const authClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
      const { data, error } = await authClient.auth.signInWithPassword({ email: member.email, password })
      if (error || !data.session) return reply({ error: 'INVALID_CREDENTIALS' }, 401)
      return reply({
        access_token: data.session.access_token, refresh_token: data.session.refresh_token,
        expires_in: data.session.expires_in, token_type: data.session.token_type, user: data.user,
      })
    }

    const authorization = req.headers.get('Authorization') || ''
    const token = authorization.replace(/^Bearer\s+/i, '')
    if (!token) return reply({ error: 'NOT_AUTHENTICATED' }, 401)

    const { data: authData, error: authError } = await admin.auth.getUser(token)
    if (authError || !authData.user) return reply({ error: 'INVALID_SESSION' }, 401)

    const callerId = authData.user.id
    const { data: caller } = await admin.from('mask_app_members')
      .select('role,approved').eq('user_id', callerId).maybeSingle()
    if (!caller?.approved || caller.role !== 'admin') return reply({ error: 'ADMIN_ONLY' }, 403)

    const notify = async (eventKey: string, level: string, title: string, body: string, audienceRole: string | null = 'admin', targetUserId: string | null = null) => {
      try {
        await admin.from('mask_notifications').upsert({
          event_key: eventKey, level, title, body, audience_role: audienceRole,
          target_user_id: targetUserId, created_at: new Date().toISOString(),
        }, { onConflict: 'event_key' })
      } catch { /* 通知失敗不能阻斷主要帳號操作 */ }
    }

    if (action === 'list') {
      const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
      if (error) throw error
      const { data: members, error: memberError } = await admin.from('mask_app_members').select('*')
      if (memberError) throw memberError
      const memberMap = new Map((members || []).map((m) => [m.user_id, m]))
      return reply({ users: data.users.map((u) => ({
        user_id: u.id,
        email: memberMap.get(u.id)?.contact_email || (u.email?.endsWith('@mask-order.local') ? '' : u.email || ''),
        username: memberMap.get(u.id)?.username || '',
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
      const username = String(input.username || '').trim().toLowerCase()
      const password = String(input.password || '')
      const displayName = String(input.display_name || '').trim()
      const role = ['admin', 'staff', 'viewer'].includes(input.role) ? input.role : 'staff'
      if (!username && !/^\S+@\S+\.\S+$/.test(email)) return reply({ error: 'ACCOUNT_REQUIRED' }, 400)
      if (username && !/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) return reply({ error: 'INVALID_USERNAME' }, 400)
      if (password.length < 10) return reply({ error: 'PASSWORD_TOO_SHORT' }, 400)
      if (username) {
        const { data: exists } = await admin.from('mask_app_members').select('user_id').ilike('username', username).maybeSingle()
        if (exists) return reply({ error: 'USERNAME_EXISTS' }, 409)
      }
      const authEmail = username ? `${username}@mask-order.local` : email
      const { data, error } = await admin.auth.admin.createUser({
        email: authEmail, password, email_confirm: true,
        user_metadata: { display_name: displayName },
      })
      if (error || !data.user) throw error || new Error('CREATE_FAILED')
      const { error: profileError } = await admin.from('mask_app_members').upsert({
        user_id: data.user.id, email: authEmail, contact_email: email || null,
        username: username || null, display_name: displayName, role,
        approved: true, must_change_password: true, updated_at: new Date().toISOString(),
      })
      if (profileError) throw profileError
      await notify(`account-created-${data.user.id}`, 'info', '已建立新帳號', displayName || username || email)
      return reply({ ok: true, user_id: data.user.id })
    }

    if (action === 'get_permissions') {
      const { data, error } = await admin.from('mask_role_permissions').select('*').order('role')
      if (error) throw error
      return reply({ roles: data || [] })
    }

    if (action === 'update_permissions') {
      const role = String(input.role || '')
      const permissions = input.permissions || {}
      if (!['staff','viewer'].includes(role)) return reply({ error: 'PROTECTED_ROLE' }, 400)
      const { error } = await admin.from('mask_role_permissions').update({
        permissions, updated_at: new Date().toISOString(),
      }).eq('role', role)
      if (error) throw error
      return reply({ ok: true })
    }

    const userId = String(input.user_id || '')
    if (!userId) return reply({ error: 'USER_REQUIRED' }, 400)

    if (action === 'update') {
      const role = ['admin', 'staff', 'viewer'].includes(input.role) ? input.role : 'staff'
      const approved = Boolean(input.approved)
      if (userId === callerId && (!approved || role !== 'admin'))
        return reply({ error: 'CANNOT_REVOKE_SELF' }, 400)
      const { data: target } = await admin.from('mask_app_members').select('role,approved').eq('user_id', userId).maybeSingle()
      if (target?.role === 'admin' && target.approved && (!approved || role !== 'admin')) {
        const { count } = await admin.from('mask_app_members').select('*',{count:'exact',head:true}).eq('role','admin').eq('approved',true)
        if ((count || 0) <= 1) return reply({ error: 'LAST_ADMIN' }, 400)
      }
      const username = String(input.username || '').trim().toLowerCase()
      if (username && !/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) return reply({ error: 'INVALID_USERNAME' }, 400)
      if (username) {
        const { data: duplicate } = await admin.from('mask_app_members').select('user_id').ilike('username', username).neq('user_id', userId).maybeSingle()
        if (duplicate) return reply({ error: 'USERNAME_EXISTS' }, 409)
      }
      const { error } = await admin.from('mask_app_members').update({
        role, approved, display_name: String(input.display_name || '').trim(),
        contact_email: String(input.email || '').trim().toLowerCase() || null,
        username: username || null,
        updated_at: new Date().toISOString(),
      }).eq('user_id', userId)
      if (error) throw error
      const { error: banError } = await admin.auth.admin.updateUserById(userId, {
        ban_duration: approved ? 'none' : '876000h',
      })
      if (banError) throw banError
      await notify(`account-updated-${userId}-${Date.now()}`, 'info', '帳號資料或權限已更新', String(input.display_name || username || userId), null, userId)
      return reply({ ok: true })
    }

    if (action === 'delete') {
      if (userId === callerId) return reply({ error: 'CANNOT_DELETE_SELF' }, 400)
      const { data: target } = await admin.from('mask_app_members').select('role,approved,display_name,username,email').eq('user_id', userId).maybeSingle()
      if (!target) return reply({ error: 'USER_NOT_FOUND' }, 404)
      if (target.role === 'admin' && target.approved) {
        const { count } = await admin.from('mask_app_members').select('*',{count:'exact',head:true}).eq('role','admin').eq('approved',true)
        if ((count || 0) <= 1) return reply({ error: 'LAST_ADMIN' }, 400)
      }
      const label = target.display_name || target.username || target.email || userId
      const { error } = await admin.auth.admin.deleteUser(userId)
      if (error) throw error
      await notify(`account-deleted-${userId}`, 'warn', '帳號已刪除', label)
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
      await notify(`password-reset-${userId}-${Date.now()}`, 'warn', '密碼已由管理員重設', '下次登入後請修改密碼。', null, userId)
      return reply({ ok: true })
    }

    return reply({ error: 'UNKNOWN_ACTION' }, 400)
  } catch (error) {
    console.error(error)
    return reply({ error: error?.message || 'INTERNAL_ERROR' }, 500)
  }
})
