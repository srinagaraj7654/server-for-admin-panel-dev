/* ══════════════════════════════════════════════════════════════════════════
   Cashfree Payment Gateway client (PG API 2023-08-01). Server-only: uses the secret key.
   fetch is injectable so tests never call Cashfree.
   ══════════════════════════════════════════════════════════════════════════ */
import crypto from 'node:crypto'

export class CashfreeError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code }
}

export function createCashfree({ appId, secret, env }, fetchImpl = globalThis.fetch) {
  const mode = env === 'production' ? 'production' : 'sandbox'
  const base = mode === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg'
  const headers = { 'x-client-id': appId, 'x-client-secret': secret, 'x-api-version': '2023-08-01', 'Content-Type': 'application/json', Accept: 'application/json' }

  async function req(method, path, body) {
    let r
    try { r = await fetchImpl(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) }) }
    catch (e) { throw new CashfreeError(502, 'Could not reach Cashfree: ' + e.message, 'network') }
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new CashfreeError(r.status, j.message || `Cashfree error ${r.status}`, j.code)
    return j
  }

  return {
    mode,
    createOrder: (order) => req('POST', '/orders', order),
    getOrder: (orderId) => req('GET', `/orders/${encodeURIComponent(orderId)}`),
    getPayments: (orderId) => req('GET', `/orders/${encodeURIComponent(orderId)}/payments`),
    /** Webhook signature = base64( HMAC-SHA256( timestamp + rawBody, secret ) ). Timing-safe compare. */
    verifyWebhook(rawBody, timestamp, signature) {
      if (!rawBody || !timestamp || !signature) return false
      const expected = crypto.createHmac('sha256', secret).update(String(timestamp) + rawBody).digest('base64')
      const a = Buffer.from(expected), b = Buffer.from(String(signature))
      return a.length === b.length && crypto.timingSafeEqual(a, b)
    },
  }
}
