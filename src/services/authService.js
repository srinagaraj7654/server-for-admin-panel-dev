/* ══════════════════════════════════════════════════════════════════════════
   Auth service — sign-in / session / sign-out run HERE (Node), not in the browser.
   • User-facing auth uses a Supabase client with the PUBLISHABLE key, created per call (no shared state).
   • Admin operations (sign out a token, read a user) use the service client.
   • Google/Apple: the PKCE code verifier never reaches the browser — it is sealed into an httpOnly cookie
     on this server's domain; after the provider returns, the session is handed to the website as a sealed,
     60-second code (no tokens in URLs / browser history).
   ══════════════════════════════════════════════════════════════════════════ */
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { AccessError } from './accessStore.js'

const VERIFIER_KEY = 'mt-code-verifier'     // storageKey 'mt' → supabase-js stores the PKCE verifier as `${storageKey}-code-verifier`

/** In-memory storage for one supabase-js client (captures / provides the PKCE verifier). */
function memoryStorage(initial = {}) {
  const m = new Map(Object.entries(initial))
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, v) }, removeItem: (k) => { m.delete(k) }, dump: () => Object.fromEntries(m) }
}

/** AES-256-GCM seal / open with a key derived from AUTH_STATE_SECRET. Payload carries its own expiry. */
export function makeSealer(secret) {
  const key = secret ? crypto.createHash('sha256').update(`mt-auth:${secret}`).digest() : null
  const seal = (payload, ttlSeconds) => {
    if (!key) throw new AccessError(503, 'Sign-in with Google/Apple is not configured on the server (AUTH_STATE_SECRET)')
    const iv = crypto.randomBytes(12)
    const c = crypto.createCipheriv('aes-256-gcm', key, iv)
    const body = Buffer.concat([c.update(JSON.stringify({ p: payload, exp: Date.now() + ttlSeconds * 1000 }), 'utf8'), c.final()])
    return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url')
  }
  const open = (token) => {
    if (!key || !token) return null
    try {
      const raw = Buffer.from(String(token), 'base64url')
      const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
      d.setAuthTag(raw.subarray(12, 28))
      const { p, exp } = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'))
      return Date.now() <= exp ? p : null
    } catch { return null }
  }
  return { seal, open, enabled: !!key }
}

/** Only what the browser needs from a Supabase session. */
export const publicSession = (s) => s && ({
  access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at, expires_in: s.expires_in, token_type: s.token_type || 'bearer',
})

export function createAuthService(serviceSupabase, config) {
  const anon = (storage) => {
    if (!config.supabaseUrl || !config.supabasePublishableKey) throw new AccessError(503, 'Sign-in is not configured on the server (SUPABASE_PUBLISHABLE_KEY)')
    return createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { persistSession: !!storage, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'pkce', storageKey: 'mt', ...(storage ? { storage } : {}) },
    })
  }
  const sealer = makeSealer(config.authStateSecret)

  /** Email + password. Only confirmed emails get a session. */
  async function login(email, password) {
    const { data, error } = await anon().auth.signInWithPassword({ email, password })
    if (error || !data?.session) throw new AccessError(401, error?.message === 'Email not confirmed' ? 'Please confirm your email first.' : 'Invalid email or password')
    if (!data.user?.email_confirmed_at) { await revoke(data.session.access_token); throw new AccessError(401, 'Please confirm your email first.') }
    return { session: publicSession(data.session), user: data.user }
  }

  async function refresh(refreshToken) {
    const { data, error } = await anon().auth.refreshSession({ refresh_token: refreshToken })
    if (error || !data?.session) throw new AccessError(401, 'Session expired — please sign in again')
    return { session: publicSession(data.session), user: data.user }
  }

  /** Sign out: revokes the refresh tokens of this session ('local') or all devices ('global'). */
  async function revoke(accessToken, scope = 'local') {
    try { await serviceSupabase.auth.admin.signOut(accessToken, scope) } catch { /* already invalid */ }
  }

  /** Full user object (same shape the website already reads: id, email, created_at, user_metadata, …). */
  async function userFromToken(accessToken) {
    const { data, error } = await serviceSupabase.auth.getUser(accessToken)
    if (error || !data?.user) return null
    return data.user
  }

  /** Google/Apple step 1 → { url, cookie } (cookie = sealed PKCE verifier + where to return). */
  async function oauthStart(provider, { callbackUrl, returnTo }) {
    const storage = memoryStorage()
    const { data, error } = await anon(storage).auth.signInWithOAuth({ provider, options: { redirectTo: callbackUrl, skipBrowserRedirect: true } })
    const verifier = storage.getItem(VERIFIER_KEY)
    if (error || !data?.url || !verifier) throw new AccessError(502, 'Could not start sign-in with ' + provider)
    return { url: data.url, cookie: sealer.seal({ v: verifier, r: returnTo }, 600) }
  }

  /** Google/Apple step 2 (provider came back with ?code=) → { code (sealed 60 s), returnTo }. */
  async function oauthCallback(code, cookieValue) {
    const state = sealer.open(cookieValue)
    if (!state?.v) throw new AccessError(400, 'Sign-in expired or was started in another browser — please try again')
    const storage = memoryStorage({ [VERIFIER_KEY]: state.v })
    const { data, error } = await anon(storage).auth.exchangeCodeForSession(code)
    if (error || !data?.session) throw new AccessError(400, 'Sign-in failed — please try again')
    if (!data.user?.email_confirmed_at) { await revoke(data.session.access_token); throw new AccessError(401, 'Please confirm your email first.') }
    return { code: sealer.seal({ s: publicSession(data.session) }, 60), returnTo: state.r }
  }

  /** Website redeems the sealed 60-second code → session + user. */
  async function redeem(sealedCode) {
    const p = sealer.open(sealedCode)
    if (!p?.s?.access_token) throw new AccessError(400, 'Sign-in link expired — please sign in again')
    const user = await userFromToken(p.s.access_token)
    if (!user) throw new AccessError(401, 'Session expired — please sign in again')
    return { session: p.s, user }
  }

  return { login, refresh, revoke, userFromToken, oauthStart, oauthCallback, redeem, oauthEnabled: sealer.enabled }
}
