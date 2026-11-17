import { loadConfig, missingConfig } from './config/env.js'
import { createSupabase, createMainApi } from './lib/clients.js'
import { createAccessStore } from './services/accessStore.js'
import { createSubscriptionStore } from './services/subscriptionStore.js'
import { createApp } from './app.js'
import { log } from './lib/log.js'

const config = loadConfig()
const missing = missingConfig(config)
const supabase = createSupabase(config)
const store = supabase ? createAccessStore(supabase, config) : null
const subscriptions = supabase ? createSubscriptionStore(supabase, config) : null
const mainApi = createMainApi(config)

const app = createApp({ store, subscriptions, mainApi, config, missing })

app.listen(config.port, () => {
  log('server.start', { port: config.port, subscriptionWrites: config.allowSubscriptionWrites, allowedOrigins: config.allowedOrigins, missingConfig: missing })
  if (missing.length) console.warn(`⚠  Missing settings in .env: ${missing.join(', ')} — see .env.example`)
})
