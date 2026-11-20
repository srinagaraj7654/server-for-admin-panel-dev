import 'dotenv/config'

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean)

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 4000,
    supabaseUrl: env.SUPABASE_URL || '',
    // Secret (server-only) key: new Supabase name SUPABASE_SECRET_KEY (sb_secret_…);
    // SUPABASE_SERVICE_ROLE_KEY still accepted for older setups.
    supabaseServiceRoleKey: env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '',
    supabasePublishableKey: env.SUPABASE_PUBLISHABLE_KEY || '',   // user-facing sign-in (login, refresh, reset, Google/Apple)
    // Random secret that seals the Google/Apple sign-in state and the 60-second sign-in code. Without it,
    // Google/Apple sign-in through the server is off (email + password still works).
    authStateSecret: env.AUTH_STATE_SECRET || '',
    // Cashfree payment gateway (server-only). Payments are off when the keys are missing (website falls back to Stripe).
    cashfree: { appId: env.CASHFREE_APP_ID || '', secret: env.CASHFREE_SECRET_KEY || '', env: (env.CASHFREE_ENV || 'sandbox').trim().toLowerCase() },
    supabaseJwksUrl: env.SUPABASE_JWKS_URL || '',                  // not used yet (local JWT verification later)
    superAdminEmails: list(env.SUPER_ADMIN_EMAILS).map((e) => e.toLowerCase()),
    allowedOrigins: list(env.ALLOWED_ORIGINS || 'http://localhost:3000'),
    mainApiUrl: (env.MAIN_API_URL || '').replace(/\/+$/, ''),
    mainApiAdminKey: env.MAIN_API_ADMIN_KEY || '',
    // Users & Subscriptions: changes to the `subscriptions` table are OFF unless this is exactly "true".
    allowSubscriptionWrites: String(env.ALLOW_SUBSCRIPTION_WRITES || '').trim().toLowerCase() === 'true',
  }
}

/** Which required settings are missing (reported by /health; secrets themselves are never returned). */
export function missingConfig(config) {
  const missing = []
  if (!config.supabaseUrl) missing.push('SUPABASE_URL')
  if (!config.supabaseServiceRoleKey) missing.push('SUPABASE_SECRET_KEY')
  if (!config.mainApiUrl) missing.push('MAIN_API_URL')
  if (!config.mainApiAdminKey) missing.push('MAIN_API_ADMIN_KEY')
  return missing
}
