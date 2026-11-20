/* ══════════════════════════════════════════════════════════════════════════
   Cashfree payments → subscriptions.
   • Orders are created with the SERVER's price (src/config/plans.js) and tagged with user_id + plan.
   • A subscription is activated only when Cashfree itself reports the order PAID, the amount matches
     the server price, and this cashfree_order_id was not activated before (also enforced by a unique
     index in the database). Activation then reuses studentStore.syncPlan to stamp the plan on the user.
   Writes only the existing `subscriptions` table (+ the 2 approved columns cashfree_order_id / _payment_id).
   ══════════════════════════════════════════════════════════════════════════ */
import { PLANS } from '../config/plans.js'
import { AccessError } from './accessStore.js'

/**
 * Pure activation logic (deps injected → testable).
 * @returns {Promise<{status:'ok'|'pending'|'failed', plan?, userId?, user?, already?}>}
 */
export async function activateOrder({ cashfree, findByOrderId, insertSubscription, syncPlan, now = () => new Date() }, orderId) {
  const order = await cashfree.getOrder(orderId)
  const status = order.order_status
  if (status !== 'PAID') return { status: status === 'ACTIVE' ? 'pending' : 'failed', orderStatus: status }

  const tags = order.order_tags || {}
  const userId = tags.user_id, planId = tags.plan, plan = PLANS[planId]
  if (!userId || !plan) throw new AccessError(400, 'Order is missing its plan / user')
  if (Number(order.order_amount) !== plan.amount || (order.order_currency || 'INR') !== plan.currency) {
    throw new AccessError(400, 'Paid amount does not match the plan price')
  }

  const existing = await findByOrderId(orderId)
  if (existing) return { status: 'ok', plan: planId, userId, already: true, user: await syncPlan(userId) }

  let paymentId = null
  try {
    const payments = await cashfree.getPayments(orderId)
    paymentId = (Array.isArray(payments) ? payments : []).find((p) => p.payment_status === 'SUCCESS')?.cf_payment_id ?? null
  } catch { /* payment id is informational only */ }

  const start = now()
  const end = new Date(start.getTime() + plan.days * 86_400_000)
  const inserted = await insertSubscription({
    user_id: userId, plan: planId, status: 'active', amount: plan.amount, currency: plan.currency,
    period_start: start.toISOString(), period_end: end.toISOString(),
    cashfree_order_id: orderId, cashfree_payment_id: paymentId != null ? String(paymentId) : null,
    created_at: start.toISOString(), updated_at: start.toISOString(),
  })
  return { status: 'ok', plan: planId, userId, already: !inserted, user: await syncPlan(userId) }
}

export function createPaymentStore({ supabase, cashfree, students }) {
  const deps = {
    cashfree,
    async findByOrderId(orderId) {
      const { data, error } = await supabase.from('subscriptions').select('id').eq('cashfree_order_id', orderId).limit(1)
      if (error) throw new AccessError(502, 'Could not read subscriptions — have the cashfree columns been added?')
      return data?.[0] || null
    },
    /** Returns true if inserted, false if another request inserted the same order first (unique index). */
    async insertSubscription(row) {
      const { error } = await supabase.from('subscriptions').insert(row)
      if (!error) return true
      if (error.code === '23505') return false
      throw new AccessError(502, 'Could not save the subscription')
    },
    syncPlan: (userId) => students.syncPlan(userId),
  }

  /** Customer details Cashfree requires (phone: from the profile; a placeholder if none is saved). */
  async function customerFor(userId) {
    const { data } = await supabase.auth.admin.getUserById(userId)
    const u = data?.user || {}
    let phone = String(u.user_metadata?.phone || u.phone || '').replace(/\D/g, '')
    if (phone.length === 12 && phone.startsWith('91')) phone = phone.slice(2)
    if (!/^[6-9]\d{9}$/.test(phone)) phone = '9999999999'
    return { customer_id: userId, customer_email: u.email || undefined, customer_phone: phone, customer_name: u.user_metadata?.full_name || undefined }
  }

  async function createOrder({ userId, planId, returnUrl, notifyUrl }) {
    const plan = PLANS[planId]
    const orderId = `mt_${planId}_${userId.slice(0, 8)}_${Date.now()}`
    const order = await cashfree.createOrder({
      order_id: orderId,
      order_amount: plan.amount,
      order_currency: plan.currency,
      customer_details: await customerFor(userId),
      order_meta: { return_url: returnUrl.replace('ORDER_ID', '{order_id}'), ...(notifyUrl ? { notify_url: notifyUrl } : {}) },
      order_note: `MockTest ${plan.label} plan (${plan.days} days)`,
      order_tags: { user_id: userId, plan: planId },
    })
    return { order_id: order.order_id, payment_session_id: order.payment_session_id, mode: cashfree.mode }
  }

  return {
    mode: cashfree.mode,
    createOrder,
    getOrder: (orderId) => cashfree.getOrder(orderId),
    activate: (orderId) => activateOrder(deps, orderId),
    verifyWebhook: (raw, ts, sig) => cashfree.verifyWebhook(raw, ts, sig),
  }
}
