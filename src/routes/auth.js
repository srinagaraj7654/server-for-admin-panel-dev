import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { log } from '../lib/log.js'

const forgotSchema = z.object({ email: z.string().trim().toLowerCase().email('Enter a valid email address') })

// Same answer for every email, so this can't be used to discover which emails are admins.
export const FORGOT_MESSAGE = 'If this email belongs to an admin account, a password reset link has been sent. Check your inbox (and spam folder).'

/** Public (no sign-in) — admin panel "Forgot password?". */
export function authRoutes({ store, config }) {
  const r = Router()
  const limiter = rateLimit({
    windowMs: 15 * 60_000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Too many reset requests. Please wait 15 minutes and try again.' },
  })

  r.post('/forgot-password', limiter, async (req, res, next) => {
    const parsed = forgotSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues?.[0]?.message || 'Invalid request' })
    // Reset link goes back to the admin panel that asked — only if it is an allowed origin.
    const origin = req.get('origin')
    const redirectTo = origin && config.allowedOrigins.includes(origin) ? origin : config.allowedOrigins[0]
    try {
      const result = await store.sendAdminPasswordReset(parsed.data.email, redirectTo)
      log('auth.forgot_password', { email: parsed.data.email, sent: result.sent, reason: result.reason })
      res.json({ message: FORGOT_MESSAGE })
    } catch (e) { next(e) }
  })

  return r
}
