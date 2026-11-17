import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { makeAuth } from './middleware/auth.js'
import { meRoutes } from './routes/me.js'
import { accessRoutes } from './routes/access.js'
import { adminRoutes } from './routes/admin.js'
import { subscriptionRoutes } from './routes/subscriptions.js'
import { AccessError } from './services/accessStore.js'
import { log } from './lib/log.js'

/**
 * Build the Express app. Dependencies are injected so tests can use fakes:
 *   store   — access store (Supabase-backed in production)
 *   mainApi — axios client for the existing MockTest API (or null if not configured)
 *   config  — loadConfig() result
 *   missing — list of missing env settings (shown by /health)
 */
export function createApp({ store, subscriptions = null, mainApi, config, missing = [] }) {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 1)
  app.use(helmet())
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || config.allowedOrigins.includes(origin)),
    allowedHeaders: ['Content-Type', 'Authorization'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  }))
  app.use(express.json({ limit: '1mb' }))
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false }))

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'mocktest-admin-access', missingConfig: missing }))

  if (!store) {
    app.use('/api', (_req, res) => res.status(503).json({ error: `Admin server not configured: ${missing.join(', ')}` }))
  } else {
    const auth = makeAuth(store)
    app.use('/api/me', meRoutes({ auth, store }))
    app.use('/api/access', accessRoutes({ auth, store }))
    app.use('/api/admin', adminRoutes({ auth, mainApi }))
    if (subscriptions) app.use('/api/subscriptions', subscriptionRoutes({ auth, subscriptions }))   // super admin only
  }

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }))

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof AccessError) return res.status(err.status).json({ error: err.message })
    if (err?.response) {                       // error response from the existing API → relay it
      return res.status(err.response.status).json(err.response.data ?? { error: 'Upstream error' })
    }
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large — max 20MB' })
    log('error', { path: req.path, message: err?.message })
    res.status(500).json({ error: 'Server error' })
  })

  return app
}
