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

// v2.3.0：臨時密碼由後端安全產生，且只在建立／重設完成時回傳一次。
const temporaryPassword = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(14))
  return `M!${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')}`
}

const validEmail = (value: string) => /^\S+@\S+\.\S+$/.test(value)
const sha256 = async (value: string) => {
  const data = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

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
    const audit = async (eventType: string, actorUserId: string | null, targetUserId: string | null, detail: string) => {
      try {
        await admin.from('mask_security_events').insert({
          event_type: eventType, actor_user_id: actorUserId, target_user_id: targetUserId, detail,
        })
      } catch { /* 尚未執行 v2.3.0 SQL 時不阻斷主要操作 */ }
    }

    // 公開救援入口永遠回傳相同結果，避免洩漏帳號是否存在。
    if (action === 'request_recovery') {
      const identifier = String(input.identifier || '').trim().toLowerCase()
      if (identifier) {
        const identifierHash = await sha256(identifier)
        const since = new Date(Date.now() - 15 * 60 * 1000).toISOString()
        const { count } = await admin.from('mask_recovery_requests').select('*', { count: 'exact', head: true })
          .eq('identifier_hash', identifierHash).gte('requested_at', since)
        if ((count || 0) >= 3) return reply({ ok: true })
        await admin.from('mask_recovery_requests').insert({ identifier_hash: identifierHash })
        let authEmail = identifier.includes('@') ? identifier : ''
        if (!authEmail && /^[a-z0-9][a-z0-9._-]{2,31}$/.test(identifier)) {
          const { data: member } = await admin.from('mask_app_members')
            .select('email,contact_email,approved').ilike('username', identifier).maybeSingle()
          if (member?.approved && validEmail(member.contact_email || '')) authEmail = member.contact_email
          else if (member?.approved && validEmail(member.email || '') && !member.email.endsWith('@mask-order.local')) authEmail = member.email
        }
        if (validEmail(authEmail)) {
          const authClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
          await authClient.auth.resetPasswordForEmail(authEmail, { redirectTo: `${allowedOrigin}/mask-order-system/` })
        }
      }
      await audit('recovery_requested', null, null, '公開救援入口')
      return reply({ ok: true })
    }

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
      const password = temporaryPassword()
      const displayName = String(input.display_name || '').trim()
      const role = ['admin', 'staff', 'viewer'].includes(input.role) ? input.role : 'staff'
      if (!username && !/^\S+@\S+\.\S+$/.test(email)) return reply({ error: 'ACCOUNT_REQUIRED' }, 400)
      if (username && !/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) return reply({ error: 'INVALID_USERNAME' }, 400)
      if (email && !validEmail(email)) return reply({ error: 'INVALID_EMAIL' }, 400)
      if (role === 'admin' && !validEmail(email)) return reply({ error: 'ADMIN_EMAIL_REQUIRED' }, 400)
      if (username) {
        const { data: exists } = await admin.from('mask_app_members').select('user_id').ilike('username', username).maybeSingle()
        if (exists) return reply({ error: 'USERNAME_EXISTS' }, 409)
      }
      // 有 Email 時直接作為 Auth Email，讓日後可使用 Supabase 安全救援信。
      const authEmail = validEmail(email) ? email : `${username}@mask-order.local`
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
      await audit('account_created', callerId, data.user.id, displayName || username || email)
      return reply({ ok: true, user_id: data.user.id, temporary_password: password })
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
      const contactEmail = String(input.email || '').trim().toLowerCase()
      if (!username && !contactEmail) return reply({ error: 'ACCOUNT_REQUIRED' }, 400)
      if (contactEmail && !validEmail(contactEmail)) return reply({ error: 'INVALID_EMAIL' }, 400)
      if (role === 'admin' && !validEmail(contactEmail)) return reply({ error: 'ADMIN_EMAIL_REQUIRED' }, 400)
      if (username && !/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) return reply({ error: 'INVALID_USERNAME' }, 400)
      if (username) {
        const { data: duplicate } = await admin.from('mask_app_members').select('user_id').ilike('username', username).neq('user_id', userId).maybeSingle()
        if (duplicate) return reply({ error: 'USERNAME_EXISTS' }, 409)
      }
      const { error } = await admin.from('mask_app_members').update({
        role, approved, display_name: String(input.display_name || '').trim(),
        contact_email: contactEmail || null,
        username: username || null,
        updated_at: new Date().toISOString(),
      }).eq('user_id', userId)
      if (error) throw error
      const nextAuthEmail = contactEmail || `${username}@mask-order.local`
      if (nextAuthEmail) {
        const { error: emailError } = await admin.auth.admin.updateUserById(userId, {
          email: nextAuthEmail, email_confirm: true,
        })
        if (emailError) throw emailError
        await admin.from('mask_app_members').update({ email: nextAuthEmail }).eq('user_id', userId)
      }
      const { error: banError } = await admin.auth.admin.updateUserById(userId, {
        ban_duration: approved ? 'none' : '876000h',
      })
      if (banError) throw banError
      await notify(`account-updated-${userId}-${Date.now()}`, 'info', '帳號資料或權限已更新', String(input.display_name || username || userId), null, userId)
      await audit('account_updated', callerId, userId, String(input.display_name || username || userId))
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
      await audit('account_deleted', callerId, null, label)
      return reply({ ok: true })
    }

    if (action === 'reset_password') {
      const password = temporaryPassword()
      const { error } = await admin.auth.admin.updateUserById(userId, { password })
      if (error) throw error
      const { error: profileError } = await admin.from('mask_app_members').update({
        must_change_password: true, updated_at: new Date().toISOString(),
      }).eq('user_id', userId)
      if (profileError) throw profileError
      await notify(`password-reset-${userId}-${Date.now()}`, 'warn', '密碼已由管理員重設', '下次登入後請修改密碼。', null, userId)
      await audit('password_reset', callerId, userId, '管理員核發一次性臨時密碼')
      return reply({ ok: true, temporary_password: password })
    }

    return reply({ error: 'UNKNOWN_ACTION' }, 400)
  } catch (error) {
    console.error(error)
    return reply({ error: error?.message || 'INTERNAL_ERROR' }, 500)
  }
})
