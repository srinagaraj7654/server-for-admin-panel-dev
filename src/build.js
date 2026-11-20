// Builds the fully wired app from environment settings. Used by:
//   src/index.js — local / any Node host (`npm run dev`, `npm start`): calls app.listen
//   server.js    — Vercel (Express preset): default-exports the app, Vercel serves it
import { loadConfig, missingConfig } from './config/env.js'
import { createSupabase, createMainApi } from './lib/clients.js'
import { createAccessStore } from './services/accessStore.js'
import { createSubscriptionStore } from './services/subscriptionStore.js'
import { createAuthService } from './services/authService.js'
import { createStudentStore } from './services/studentStore.js'
import { createCashfree } from './services/cashfree.js'
import { createPaymentStore } from './services/paymentStore.js'
import { createApp } from './app.js'

export function buildServer() {
  const config = loadConfig()
  const missing = missingConfig(config)
  const supabase = createSupabase(config)
  const store = supabase ? createAccessStore(supabase, config) : null
  const subscriptions = supabase ? createSubscriptionStore(supabase, config) : null
  const authService = supabase ? createAuthService(supabase, config) : null
  const students = supabase ? createStudentStore(supabase) : null
  const payments = supabase && config.cashfree.appId && config.cashfree.secret
    ? createPaymentStore({ supabase, cashfree: createCashfree(config.cashfree), students }) : null
  const mainApi = createMainApi(config)
  const app = createApp({ store, subscriptions, authService, students, payments, mainApi, config, missing })
  return { app, config, missing }
}
