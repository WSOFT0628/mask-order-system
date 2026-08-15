import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const allowedOrigin = 'https://wsoft0628.github.io'
const headers = {
  'Access-Control-Allow-Origin': allowedOrigin,
  'Access-Control-Allow-Headers': 'apikey,content-type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers })
const validSlug = (v: string) => /^[a-z0-9][a-z0-9-]{2,47}$/.test(v)
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const sha256 = async (value: string) => {
  const data = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
const orderNumber = () => {
  const now = new Date(), date = now.toISOString().slice(2, 10).replaceAll('-', '')
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => (b % 36).toString(36)).join('').toUpperCase()
  return `M${date}-${suffix}`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers })
  if (req.method !== 'POST') return reply({ error: 'METHOD_NOT_ALLOWED' }, 405)
  try {
    const url = Deno.env.get('SUPABASE_URL')!
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    const input = await req.json()
    const action = String(input.action || '')
    const slug = String(input.slug || '').trim().toLowerCase()

    const getCampaign = async () => {
      if (!validSlug(slug)) return null
      const { data } = await db.from('mask_order_campaigns').select('*').eq('slug', slug).maybeSingle()
      return data
    }
    const campaignOpen = (campaign: any) => {
      const now = Date.now(), opens = campaign?.opens_at ? new Date(campaign.opens_at).getTime() : 0
      const closes = campaign?.closes_at ? new Date(campaign.closes_at).getTime() : Number.MAX_SAFE_INTEGER
      return !!campaign?.active && now >= opens && now <= closes
    }
    const publicCatalog = async () => {
      const { data: stateRow, error } = await db.from('mask_app_state').select('data').eq('id', 'main').maybeSingle()
      if (error || !stateRow?.data) throw new Error('CATALOG_UNAVAILABLE')
      const state = stateRow.data as any
      const products = (state.catalog || []).map((p: any) => ({
        id: String(p.id), cat: String(p.cat || ''), name: String(p.name || ''), variant: String(p.variant || ''),
        price: Number(p.price || 0), outOfStock: !!p.outOfStock, displayColor: String(p.displayColor || ''),
      }))
      return { products, settings: state.settings || {}, template: (state.templates || []).find((t: any) => t.id === state.activeTemplateId) || null }
    }
    const calculate = async (rawItems: any[]) => {
      const catalog = await publicCatalog(), map = new Map(catalog.products.map((p: any) => [p.id, p]))
      const items: any[] = []
      for (const line of Array.isArray(rawItems) ? rawItems : []) {
        const product: any = map.get(String(line.id)), qty = Math.floor(Number(line.qty))
        if (!product || product.outOfStock || !Number.isFinite(qty) || qty <= 0 || qty > 999) continue
        items.push({ id: product.id, cat: product.cat, name: product.name, variant: product.variant, price: product.price, qty, line_total: round2(product.price * qty) })
      }
      if (!items.length) throw new Error('EMPTY_ORDER')
      const totalQty = items.reduce((n, x) => n + x.qty, 0), subtotal = round2(items.reduce((n, x) => n + x.line_total, 0))
      // 團購預設不計運費與稅額；管理員日後可由設定個別開啟。
      const free = Number(catalog.settings.freeShippingQty || 0), shippingFee = Number(catalog.settings.shippingFee || 0)
      const shipping = catalog.settings.enableBuyerShipping === true && totalQty && totalQty < free ? shippingFee : 0
      const tax = catalog.settings.enableBuyerTax === true ? round2((subtotal + shipping) * Number(catalog.settings.taxRate || 0) / 100) : 0
      return { items, totalQty, subtotal, shipping, tax, total: round2(subtotal + shipping + tax) }
    }

    if (action === 'campaign') {
      const campaign = await getCampaign()
      if (!campaign) return reply({ error: 'CAMPAIGN_NOT_FOUND' }, 404)
      const catalog = await publicCatalog()
      return reply({ campaign: {
        name: campaign.name, slug: campaign.slug, description: campaign.description,
        opens_at: campaign.opens_at, closes_at: campaign.closes_at, active: campaignOpen(campaign),
        allow_edit: campaign.allow_edit, fulfillment_options: campaign.fulfillment_options,
      }, ...catalog })
    }

    if (action === 'submit') {
      if (String(input.website || '')) return reply({ ok: true })
      const campaign = await getCampaign()
      if (!campaign || !campaignOpen(campaign)) return reply({ error: 'CAMPAIGN_CLOSED' }, 400)
      const source = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
      const sourceHash = await sha256(`${source}:${campaign.id}`), since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
      const { count } = await db.from('mask_public_order_attempts').select('*', { count: 'exact', head: true }).eq('source_hash', sourceHash).gte('attempted_at', since)
      if ((count || 0) >= 10) return reply({ error: 'RATE_LIMITED' }, 429)
      await db.from('mask_public_order_attempts').insert({ source_hash: sourceHash })
      const customer = input.customer || {}, name = String(customer.name || '').trim(), phone = String(customer.phone || '').trim()
      const fulfillment = String(customer.fulfillment || '').trim(), options = Array.isArray(campaign.fulfillment_options) ? campaign.fulfillment_options : []
      if (!name || !phone) return reply({ error: 'CUSTOMER_REQUIRED' }, 400)
      // 精簡團購不要求取貨方式；只有買家真的傳入值時才驗證活動選項。
      if (fulfillment && options.length && !options.includes(fulfillment)) return reply({ error: 'INVALID_FULFILLMENT' }, 400)
      const totals = await calculate(input.items), editToken = randomToken(), orderNo = orderNumber()
      const { error } = await db.from('mask_buyer_orders').insert({
        campaign_id: campaign.id, order_no: orderNo, edit_token_hash: await sha256(editToken),
        customer: { name: name.slice(0,80), phone: phone.slice(0,40), line_name: String(customer.line_name || '').trim().slice(0,80), fulfillment, address: String(customer.address || '').trim().slice(0,300), note: String(customer.note || '').trim().slice(0,1000), consent: true },
        items: totals.items, total_qty: totals.totalQty, subtotal: totals.subtotal, shipping: totals.shipping,
        tax: totals.tax, total: totals.total,
      })
      if (error) throw error
      try {
        await db.from('mask_notifications').insert({
          event_key: `buyer-order-${orderNo}`, level: 'info', title: '收到新的買家訂單',
          body: `${name}｜${totals.totalQty} 盒｜${orderNo}`, link: 'buyerOrders', audience_role: 'admin',
        })
      } catch { /* 通知失敗不影響買家訂單 */ }
      return reply({ ok: true, order_no: orderNo, edit_token: editToken, ...totals })
    }

    if (['lookup', 'fetch', 'update', 'cancel'].includes(action)) {
      const orderNo = String(input.order_no || '').trim().toUpperCase(), editToken = String(input.edit_token || '')
      const lookupPhone = String(input.lookup_phone || '').replace(/\D/g, '')
      if (!orderNo || (!editToken && !lookupPhone)) return reply({ error: 'INVALID_ORDER_ACCESS' }, 400)
      const { data: order } = await db.from('mask_buyer_orders').select('*,mask_order_campaigns(*)').eq('order_no', orderNo).maybeSingle()
      const tokenOk = !!editToken && !!order && order.edit_token_hash === await sha256(editToken)
      const phoneOk = !!lookupPhone && !!order && String(order.customer?.phone || '').replace(/\D/g, '') === lookupPhone
      if (!order || (!tokenOk && !phoneOk)) return reply({ error: 'INVALID_ORDER_ACCESS' }, 404)
      const campaign = order.mask_order_campaigns
      if (action === 'fetch' || action === 'lookup') return reply({ order: { order_no: order.order_no,customer: order.customer,items: order.items,total_qty: order.total_qty,subtotal: order.subtotal,shipping: order.shipping,tax: order.tax,total: order.total,status: order.status,created_at: order.created_at }, campaign: { name: campaign.name,slug: campaign.slug,allow_edit: campaign.allow_edit,active: campaignOpen(campaign) } })
      if (!campaign.allow_edit || !campaignOpen(campaign) || ['aggregated','completed','cancelled'].includes(order.status)) return reply({ error: 'ORDER_LOCKED' }, 400)
      if (action === 'cancel') {
        await db.from('mask_buyer_orders').update({ status: 'cancelled', buyer_updated_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', order.id)
        return reply({ ok: true })
      }
      const rawCustomer = input.customer || {}, name = String(rawCustomer.name || '').trim(), phone = String(rawCustomer.phone || '').trim()
      const fulfillment = String(rawCustomer.fulfillment || '').trim(), options = Array.isArray(campaign.fulfillment_options) ? campaign.fulfillment_options : []
      if (!name || !phone) return reply({ error: 'CUSTOMER_REQUIRED' }, 400)
      if (fulfillment && options.length && !options.includes(fulfillment)) return reply({ error: 'INVALID_FULFILLMENT' }, 400)
      const totals = await calculate(input.items), customer = {
        name: name.slice(0, 80), phone: phone.slice(0, 40), line_name: String(rawCustomer.line_name || '').trim().slice(0, 80),
        fulfillment, address: String(rawCustomer.address || '').trim().slice(0, 300), note: String(rawCustomer.note || '').trim().slice(0, 1000), consent: true,
      }
      const { error } = await db.from('mask_buyer_orders').update({ customer, items: totals.items,total_qty: totals.totalQty,subtotal: totals.subtotal,shipping: totals.shipping,tax: totals.tax,total: totals.total,buyer_updated_at:new Date().toISOString(),updated_at:new Date().toISOString(),status:'pending' }).eq('id', order.id)
      if (error) throw error
      return reply({ ok: true, ...totals })
    }
    return reply({ error: 'UNKNOWN_ACTION' }, 400)
  } catch (error) {
    console.error(error)
    return reply({ error: error?.message || 'INTERNAL_ERROR' }, 500)
  }
})
