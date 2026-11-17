import { Router } from 'express'
import { z } from 'zod'
import { PAID_PLANS } from '../services/subscriptionStore.js'
import { log } from '../lib/log.js'

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be yyyy-mm-dd')
  .refine((d) => !Number.isNaN(Date.parse(d)), 'Invalid date')
const changeSchema = z.object({
  plan: z.enum(PAID_PLANS, { errorMap: () => ({ message: 'Plan must be basic, pro or ultimate' }) }).optional(),
  startDate: date.optional(),
  expiryDate: date.optional(),
  status: z.enum(['active', 'suspended']).optional(),
}).strict().refine((c) => !(c.startDate && c.expiryDate) || c.expiryDate > c.startDate, 'Expiry must be after the start date')
const uuid = z.string().uuid()

/** Super admin only — Users & Subscriptions. */
export function subscriptionRoutes({ auth, subscriptions }) {
  const r = Router()
  r.use(auth.requireAuth, auth.requireSuperAdmin)

  r.get('/', async (_req, res, next) => {
    try { res.json(await subscriptions.listSubscribers()) } catch (e) { next(e) }
  })

  r.patch('/:userId', async (req, res, next) => {
    if (!uuid.safeParse(req.params.userId).success) return res.status(400).json({ error: 'Invalid user id' })
    const parsed = changeSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues?.[0]?.message || 'Invalid request' })
    try {
      const result = await subscriptions.updateSubscription(req.params.userId, parsed.data)
      log('subscription.change', { by: req.user.email, target: result.email, action: result.action, changes: parsed.data })
      res.json({ result })
    } catch (e) { next(e) }
  })

  return r
}
