import { Router } from 'express'
import { z } from 'zod'
import { log } from '../lib/log.js'

// Same rules as the super admin's "Create admin" form.
const passwordSchema = z.object({
  password: z.string().min(8, 'Password must be at least 8 characters').max(72, 'Password is too long (max 72)')
    .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Password must contain letters and numbers'),
})

export function meRoutes({ auth, store }) {
  const r = Router()

  /** GET /api/me/access → the caller's role, domains, allowed admin modules, and whether a new password is required. */
  r.get('/access', auth.requireAuth, (req, res) => {
    res.json({
      user: { id: req.user.id, email: req.user.email },
      role: req.access.role,
      domains: req.access.domains,
      modules: req.access.modules,
      mustChangePassword: req.user.mustChangePassword,
      recovery: req.user.recovery,
    })
  })

  /** POST /api/me/password { password } → set a new password: replaces the TEMPORARY one, or after a reset link. */
  r.post('/password', auth.requireAuth, async (req, res, next) => {
    // Allowed while on the temporary password from the super admin, or when signed in via a reset link.
    if (!req.user.mustChangePassword && !req.user.recovery) return res.status(400).json({ error: 'Your password is already set. Use "Forgot password?" on the sign-in page to change it.' })
    const parsed = passwordSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues?.[0]?.message || 'Invalid password' })
    try {
      await store.setPermanentPassword(req.user, parsed.data.password)
      log('access.password_set', { user: req.user.email })     // the password itself is never logged
      res.json({ ok: true })
    } catch (e) { next(e) }
  })

  return r
}
