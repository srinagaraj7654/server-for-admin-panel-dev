import { Router } from 'express'
import { z } from 'zod'
import { DOMAINS, DOMAIN_IDS } from '../config/domains.js'
import { log } from '../lib/log.js'

const domainsSchema = z.array(z.enum(DOMAIN_IDS)).min(1, 'Pick at least one domain').max(DOMAIN_IDS.length)
  .transform((d) => [...new Set(d)])
const grantSchema = z.object({ email: z.string().trim().email('Enter a valid email'), domains: domainsSchema })
const updateSchema = z.object({ domains: domainsSchema })
const createSchema = z.object({
  name: z.string().trim().min(2, 'Enter the admin’s name').max(80),
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(72, 'Password is too long (max 72)')
    .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Password must contain letters and numbers'),
  domains: domainsSchema,
})
const uuid = z.string().uuid()

const bad = (res, err) => res.status(400).json({ error: err.issues?.[0]?.message || 'Invalid request' })

/** Super admin only — manage who has admin access and to which domains. */
export function accessRoutes({ auth, store }) {
  const r = Router()
  r.use(auth.requireAuth, auth.requireSuperAdmin)

  r.get('/domains', (_req, res) => res.json({ domains: DOMAINS.map(({ id, label }) => ({ id, label })) }))

  r.get('/admins', async (_req, res, next) => {
    try { res.json({ admins: await store.listAdmins() }) } catch (e) { next(e) }
  })

  r.get('/users', async (req, res, next) => {
    try { res.json({ users: await store.searchUsers(String(req.query.q || '')) }) } catch (e) { next(e) }
  })

  r.post('/admins', async (req, res, next) => {
    const parsed = grantSchema.safeParse(req.body)
    if (!parsed.success) return bad(res, parsed.error)
    try {
      const result = await store.grantAdmin(req.user, parsed.data)
      log(result.created ? 'access.grant' : 'access.update', { by: req.user.email, target: result.email, domains: result.domains })
      res.status(result.created ? 201 : 200).json({ admin: result })
    } catch (e) { next(e) }
  })

  // Create a brand-new admin account (super admin sets the password). Password is never logged.
  r.post('/admins/create', async (req, res, next) => {
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) return bad(res, parsed.error)
    try {
      const result = await store.createAdmin(req.user, parsed.data)
      log('access.create', { by: req.user.email, target: result.email, domains: result.domains })
      res.status(201).json({ admin: result })
    } catch (e) { next(e) }
  })

  r.patch('/admins/:userId', async (req, res, next) => {
    if (!uuid.safeParse(req.params.userId).success) return res.status(400).json({ error: 'Invalid user id' })
    const parsed = updateSchema.safeParse(req.body)
    if (!parsed.success) return bad(res, parsed.error)
    try {
      const result = await store.updateDomains(req.user, req.params.userId, parsed.data.domains)
      log('access.update', { by: req.user.email, target: result.email, domains: result.domains })
      res.json({ admin: result })
    } catch (e) { next(e) }
  })

  r.delete('/admins/:userId', async (req, res, next) => {
    if (!uuid.safeParse(req.params.userId).success) return res.status(400).json({ error: 'Invalid user id' })
    try {
      const result = await store.revokeAdmin(req.user, req.params.userId)
      log('access.revoke', { by: req.user.email, target: result.email })
      res.json({ revoked: result })
    } catch (e) { next(e) }
  })

  return r
}
