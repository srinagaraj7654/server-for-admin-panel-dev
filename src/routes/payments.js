import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { PLAN_IDS } from '../config/plans.js'
import { CashfreeError } from '../services/cashfree.js'
import { log } from '../lib/log.js'

const orderSchema = z.object({ plan: z.enum(PLAN_IDS, { errorMap: () => ({ message: 'Unknown plan' }) }) })   // price comes from the server
const verifySchema = z.object({ order_id: z.string().regex(/^mt_[a-z]+_[0-9a-f]{8}_\d+$/, 'Invalid order id') })

/**
 * Cashfree payments — /api/payments/cashfree/*.
 * `payments` is null when the Cashfree keys are not configured → 503, and the website falls back to Stripe.
 */
export function paymentRoutes({ auth, payments, config }) {
  const r = Router()
  const limit = (n) => rateLimit({ windowMs: 15 * 60_000, limit: n, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many payment requests — please wait a few minutes.' } })
  const notConfigured = (res) => res.status(503).json({ error: 'Cashfree is not configured on the server', code: 'CASHFREE_OFF' })
  const upstream = (res, e) => res.status(e instanceof CashfreeError ? 502 : (e.status || 500)).json({ error: e.message || 'Payment error', code: 'CASHFREE_ERROR' })

  r.post('/cashfree/order', limit(20), auth.requireAuth, async (req, res) => {
    if (!payments) return notConfigured(res)
    const p = orderSchema.safeParse(req.body)
    if (!p.success) return res.status(400).json({ error: p.error.issues?.[0]?.message || 'Invalid request' })
    const origin = req.get('origin')
    const site = origin && config.allowedOrigins.includes(origin) ? origin : config.allowedOrigins[0]
    const serverUrl = `${req.protocol}://${req.get('host')}`
    try {
      const out = await payments.createOrder({
        userId: req.user.id, planId: p.data.plan,
        returnUrl: `${site}/?sub=cf&order_id=ORDER_ID`,
        notifyUrl: req.secure ? `${serverUrl}${req.baseUrl}/cashfree/webhook` : undefined,   // Cashfree needs https
      })
      log('payment.cashfree_order', { user: req.user.email, plan: p.data.plan, order: out.order_id, mode: out.mode })
      res.json(out)
    } catch (e) { log('payment.cashfree_order_failed', { user: req.user.email, message: e.message }); upstream(res, e) }
  })

  r.post('/cashfree/verify', limit(60), auth.requireAuth, async (req, res) => {
    if (!payments) return notConfigured(res)
    const p = verifySchema.safeParse(req.body)
    if (!p.success) return res.status(400).json({ error: p.error.issues?.[0]?.message || 'Invalid request' })
    try {
      const order = await payments.getOrder(p.data.order_id)
      if (order?.order_tags?.user_id !== req.user.id) return res.status(403).json({ error: 'This order belongs to another account' })
      const out = await payments.activate(p.data.order_id)
      log('payment.cashfree_verify', { user: req.user.email, order: p.data.order_id, status: out.status, already: out.already })
      if (out.status === 'ok') return res.json({ ok: true, plan: out.plan, user: out.user })
      res.json(out.status === 'pending' ? { pending: true } : { failed: true, orderStatus: out.orderStatus })
    } catch (e) { log('payment.cashfree_verify_failed', { user: req.user.email, message: e.message }); upstream(res, e) }
  })

  // Cashfree → server. Signed with the secret key over the RAW body (kept by express.json's verify in app.js).
  r.post('/cashfree/webhook', async (req, res) => {
    if (!payments) return notConfigured(res)
    if (!payments.verifyWebhook(req.rawBody, req.get('x-webhook-timestamp'), req.get('x-webhook-signature'))) {
      log('payment.cashfree_webhook_bad_signature', {})
      return res.status(401).json({ error: 'Invalid signature' })
    }
    const type = req.body?.type || ''
    const orderId = req.body?.data?.order?.order_id
    if (!/PAYMENT_SUCCESS/.test(type) || !orderId) return res.json({ ok: true, ignored: type })
    try {
      const out = await payments.activate(orderId)                       // re-checks the order with Cashfree
      log('payment.cashfree_webhook', { order: orderId, status: out.status, already: out.already })
      res.json({ ok: true })
    } catch (e) { log('payment.cashfree_webhook_failed', { order: orderId, message: e.message }); res.status(500).json({ error: 'retry' }) }   // Cashfree retries
  })

  return r
}
