import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { log } from '../lib/log.js'

const email = z.string().trim().toLowerCase().email('Enter a valid email address')
const forgotSchema = z.object({ email, app: z.enum(['admin', 'student']).optional() })
const loginSchema = z.object({ email, password: z.string().min(1, 'Enter your password').max(200), app: z.enum(['admin', 'student']).optional() })
const refreshSchema = z.object({ refresh_token: z.string().min(10).max(4000) })
const redeemSchema = z.object({ code: z.string().min(20).max(8000) })
// Same rules everywhere (admin "Create admin", temporary password, reset link, website password change).
export const passwordSchema = z.object({
  password: z.string().min(8, 'Password must be at least 8 characters').max(72, 'Password is too long (max 72)')
    .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Password must contain letters and numbers'),
})
const PROVIDERS = ['google', 'apple']
const ADMIN_ROLES = ['admin', 'super_admin']
const COOKIE = 'mt_oauth'

// Same answer for every email, so these can't be used to discover which emails exist / are admins.
export const FORGOT_MESSAGE = 'If this email belongs to an admin account, a password reset link has been sent. Check your inbox (and spam folder).'
export const FORGOT_MESSAGE_STUDENT = 'If an account exists for this email, a password reset link has been sent. Check your inbox (and spam folder).'

const bad = (res, err) => res.status(400).json({ error: err.issues?.[0]?.message || 'Invalid request' })
const bearer = (req) => { const h = req.get('authorization') || ''; return h.startsWith('Bearer ') ? h.slice(7).trim() : '' }
const readCookie = (req, name) => {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return ''
}

/** Auth API — sign-in, session, sign-out, passwords, Google/Apple. Mounted at /api/auth. */
export function authRoutes({ store, config, authService, auth }) {
  const r = Router()
  const limit = (n, minutes, msg) => rateLimit({ windowMs: minutes * 60_000, limit: n, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: msg } })
  const forgotLimiter = limit(5, 15, 'Too many reset requests. Please wait 15 minutes and try again.')
  const loginLimiter = limit(10, 15, 'Too many sign-in attempts. Please wait 15 minutes and try again.')

  // An address is only used for redirects when it belongs to an allowed origin (no open redirects).
  const allowedUrl = (u) => { try { const x = new URL(u); return config.allowedOrigins.includes(x.origin) ? x.toString() : null } catch { return null } }
  const defaultSite = () => config.allowedOrigins[0]
  const callbackUrl = (req) => `${req.protocol}://${req.get('host')}${req.baseUrl}/oauth/callback`
  const accessOf = async (user) => {
    const a = await store.getAccess(user)
    return { role: a.role, domains: a.domains, mustChangePassword: !!user.app_metadata?.must_change_password }
  }

  /* ── Forgot password ─────────────────────────────────────────────────── */
  r.post('/forgot-password', forgotLimiter, async (req, res, next) => {
    const parsed = forgotSchema.safeParse(req.body)
    if (!parsed.success) return bad(res, parsed.error)
    const origin = req.get('origin')
    const redirectTo = origin && config.allowedOrigins.includes(origin) ? origin : defaultSite()
    const student = parsed.data.app === 'student'
    try {
      const result = student
        ? await store.sendPasswordReset(parsed.data.email, redirectTo)          // website: any account
        : await store.sendAdminPasswordReset(parsed.data.email, redirectTo)     // admin panel: admins only
      log('auth.forgot_password', { app: student ? 'student' : 'admin', email: parsed.data.email, sent: result.sent, reason: result.reason })
      res.json({ message: student ? FORGOT_MESSAGE_STUDENT : FORGOT_MESSAGE })
    } catch (e) { next(e) }
  })

  /* ── Email + password sign-in ────────────────────────────────────────── */
  r.post('/login', loginLimiter, async (req, res, next) => {
    const parsed = loginSchema.safeParse(req.body)
    if (!parsed.success) return bad(res, parsed.error)
    try {
      const { session, user } = await authService.login(parsed.data.email, parsed.data.password)
      const access = await accessOf(user)
      if (parsed.data.app === 'admin' && !ADMIN_ROLES.includes(access.role)) {
        await authService.revoke(session.access_token)           // no admin session is ever handed out
        log('auth.login_rejected', { email: user.email, reason: 'not-admin' })
        return res.status(403).json({ error: `${user.email} is not an admin account. Only accounts created by the super admin can sign in here.`, code: 'NOT_ADMIN' })
      }
      log('auth.login', { email: user.email, app: parsed.data.app || 'student' })
      res.json({ session, user, access })
    } catch (e) { next(e) }
  })

  /* ── Refresh / me / logout ───────────────────────────────────────────── */
  r.post('/refresh', limit(60, 15, 'Too many requests'), async (req, res, next) => {
    const parsed = refreshSchema.safeParse(req.body)
    if (!parsed.success) return bad(res, parsed.error)
    try { res.json(await authService.refresh(parsed.data.refresh_token)) } catch (e) { next(e) }
  })

  r.get('/me', auth.requireAuth, async (req, res, next) => {
    try {
      const user = await authService.userFromToken(bearer(req))
      if (!user) return res.status(401).json({ error: 'Session expired — please sign in again' })
      res.json({ user, access: { ...(await accessOf(user)), recovery: req.user.recovery } })
    } catch (e) { next(e) }
  })

  r.post('/logout', async (req, res) => {
    const token = bearer(req)
    if (token) await authService.revoke(token, req.body?.scope === 'global' ? 'global' : 'local')
    res.json({ ok: true })
  })

  /* ── Set / change password (temporary, reset link, or signed-in change) ─ */
  r.post('/password', auth.requireAuth, async (req, res, next) => {
    const parsed = passwordSchema.safeParse(req.body)
    if (!parsed.success) return bad(res, parsed.error)
    try {
      await store.setPermanentPassword(req.user, parsed.data.password)
      log('auth.password_set', { user: req.user.email })      // the password itself is never logged
      res.json({ ok: true })
    } catch (e) { next(e) }
  })

  /* ── Google / Apple (web) ────────────────────────────────────────────── */
  r.get('/oauth/:provider/start', limit(30, 15, 'Too many sign-in attempts'), async (req, res, next) => {
    if (!PROVIDERS.includes(req.params.provider)) return res.status(400).json({ error: 'Unknown sign-in provider' })
    const returnTo = allowedUrl(String(req.query.return || '')) || defaultSite()
    try {
      const { url, cookie } = await authService.oauthStart(req.params.provider, { callbackUrl: callbackUrl(req), returnTo })
      res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(cookie)}; Path=${req.baseUrl}/oauth; Max-Age=600; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`)
      res.redirect(302, url)
    } catch (e) { next(e) }
  })

  r.get('/oauth/callback', async (req, res) => {
    const clear = `${COOKIE}=; Path=${req.baseUrl}/oauth; Max-Age=0; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`
    const back = (target, hash) => { res.setHeader('Set-Cookie', clear); res.redirect(302, `${target.split('#')[0]}#${hash}`) }
    const fallback = defaultSite()
    if (req.query.error) return back(fallback, `mt_auth_error=${encodeURIComponent(String(req.query.error_description || req.query.error))}`)
    if (!req.query.code) return back(fallback, 'mt_auth_error=' + encodeURIComponent('Sign-in was cancelled'))
    try {
      const { code, returnTo } = await authService.oauthCallback(String(req.query.code), readCookie(req, COOKIE))
      back(allowedUrl(returnTo) || fallback, `mt_auth=${code}`)                 // sealed, valid 60 s
    } catch (e) {
      log('auth.oauth_failed', { message: e.message })
      back(fallback, `mt_auth_error=${encodeURIComponent(e.message || 'Sign-in failed')}`)
    }
  })

  r.post('/oauth/redeem', limit(30, 15, 'Too many requests'), async (req, res, next) => {
    const parsed = redeemSchema.safeParse(req.body)
    if (!parsed.success) return bad(res, parsed.error)
    try {
      const { session, user } = await authService.redeem(parsed.data.code)
      log('auth.login', { email: user.email, app: 'student', method: 'oauth' })
      res.json({ session, user, access: await accessOf(user) })
    } catch (e) { next(e) }
  })

  return r
}
