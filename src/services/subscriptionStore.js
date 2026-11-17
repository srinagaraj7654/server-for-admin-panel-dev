/* ══════════════════════════════════════════════════════════════════════════
   Subscription store — Admin → Users & Subscriptions (super admin only).
   • READS existing tables (unchanged): auth users, `profiles`, `subscriptions`.
   • WRITES only the existing `subscriptions` table, in the same format the
     payment flow uses (plan, status, amount, currency, period_start, period_end).
     Writes are OFF unless ALLOW_SUBSCRIPTION_WRITES=true in .env.
   The web app reads `subscriptions` on sign-in (status='active' and period_end
   in the future ⇒ paid plan), so changes reach the student on next sign-in.
   ══════════════════════════════════════════════════════════════════════════ */
import { AccessError } from './accessStore.js'

export const PAID_PLANS = ['basic', 'pro', 'ultimate']
export const TRIAL_DAYS = 7          // same as the web app's free trial (from account creation)
const DAY = 86_400_000

/** yyyy-mm-dd → timestamp in India time (start or end of that day). */
export const startOfDay = (d) => new Date(`${d}T00:00:00+05:30`).toISOString()
export const endOfDay = (d) => new Date(`${d}T23:59:59+05:30`).toISOString()

/** Pick the row that decides the user's plan: newest active one, else the newest row. */
export function pickCurrent(rows) {
  const byEnd = (a, b) => String(b.period_end || '').localeCompare(String(a.period_end || ''))
  const active = rows.filter((r) => r.status === 'active').sort(byEnd)
  return active[0] || [...rows].sort(byEnd)[0] || null
}

/** Merge auth users + profiles + subscriptions into the admin list. Pure (tested). */
export function buildSubscribers({ users, profiles, subs, now = Date.now() }) {
  const prof = new Map(profiles.map((p) => [p.id, p]))
  const subsBy = new Map()
  for (const s of subs) subsBy.set(s.user_id, [...(subsBy.get(s.user_id) || []), s])

  const out = []
  for (const u of users) {
    const p = prof.get(u.id) || {}
    const base = {
      id: u.id,
      email: u.email || p.email || '',
      name: p.full_name || u.user_metadata?.full_name || u.user_metadata?.name || (u.email || '').split('@')[0] || 'User',
      phone: p.phone || u.phone || '',
      lastActive: u.last_sign_in_at || u.created_at || null,
      createdAt: u.created_at || null,
    }
    const cur = pickCurrent(subsBy.get(u.id) || [])
    if (cur) {
      out.push({
        ...base,
        source: Number(cur.amount) > 0 ? 'paid' : 'manual',
        subscriptionId: cur.id,
        plan: cur.plan,
        status: cur.status === 'active' ? 'active' : 'suspended',
        dbStatus: cur.status,
        amount: cur.amount, currency: cur.currency,
        startAt: cur.period_start || cur.created_at, endAt: cur.period_end,
      })
      continue
    }
    // No subscription row → only listed while still inside the free trial.
    const created = Date.parse(u.created_at || '')
    if (Number.isFinite(created) && created + TRIAL_DAYS * DAY > now) {
      out.push({
        ...base, source: 'trial', subscriptionId: null, plan: 'trial', status: 'active', dbStatus: null,
        amount: 0, currency: 'INR',
        startAt: new Date(created).toISOString(), endAt: new Date(created + TRIAL_DAYS * DAY).toISOString(),
      })
    }
  }
  return out
}

export function createSubscriptionStore(supabase, config) {
  const writesEnabled = !!config.allowSubscriptionWrites

  async function allAuthUsers() {
    const users = []
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 })
      if (error) throw new AccessError(502, 'Could not load users')
      const batch = data?.users || []
      users.push(...batch)
      if (batch.length < 1000) break
    }
    return users
  }

  async function listSubscribers() {
    const [users, profRes, subRes] = await Promise.all([
      allAuthUsers(),
      supabase.from('profiles').select('id, full_name, email, phone'),
      supabase.from('subscriptions').select('id, user_id, plan, status, amount, currency, period_start, period_end, created_at'),
    ])
    if (profRes.error) throw new AccessError(502, 'Could not load profiles')
    if (subRes.error) throw new AccessError(502, 'Could not load subscriptions')
    const subs = subRes.data || []
    const ids = new Set(users.map((u) => u.id))
    return {
      subscribers: buildSubscribers({ users, profiles: profRes.data || [], subs }),
      writable: writesEnabled,
      // rows whose user_id has no account any more (deleted users) — not listed, only counted
      orphanSubscriptions: subs.filter((s) => !ids.has(s.user_id)).length,
    }
  }

  /**
   * Change one user's subscription. `changes` = { plan?, startDate?, expiryDate?, status? } (dates yyyy-mm-dd).
   * Updates the user's current subscription row; if they have none (free-trial user), inserts a manual
   * row (amount 0) — that needs a paid plan id plus both dates.
   */
  async function updateSubscription(userId, changes) {
    if (!writesEnabled) throw new AccessError(403, 'Subscription changes are turned off on the server (set ALLOW_SUBSCRIPTION_WRITES=true in its .env)')
    const { data: user } = await supabase.auth.admin.getUserById(userId)
    if (!user?.user) throw new AccessError(404, 'User not found')

    const { data: rows, error } = await supabase.from('subscriptions')
      .select('id, user_id, plan, status, amount, currency, period_start, period_end, created_at').eq('user_id', userId)
    if (error) throw new AccessError(502, 'Could not load subscription')
    const cur = pickCurrent(rows || [])
    const now = new Date().toISOString()

    const patch = {}
    if (changes.plan) patch.plan = changes.plan
    if (changes.startDate) patch.period_start = startOfDay(changes.startDate)
    if (changes.expiryDate) patch.period_end = endOfDay(changes.expiryDate)
    if (changes.status) patch.status = changes.status

    if (cur) {
      if (!Object.keys(patch).length) return { userId, subscriptionId: cur.id, unchanged: true }
      const { data, error: upErr } = await supabase.from('subscriptions')
        .update({ ...patch, updated_at: now }).eq('id', cur.id).select('id, plan, status, period_start, period_end').single()
      if (upErr) throw new AccessError(400, `Database rejected the change: ${upErr.message}`)
      return { userId, email: user.user.email, action: 'update', before: cur, after: data }
    }

    // Free-trial user → give a plan manually.
    if (!changes.plan || !changes.startDate || !changes.expiryDate) {
      throw new AccessError(400, 'This user has no subscription yet — pick a plan (Basic, Pro or Ultimate) to give them one')
    }
    const row = {
      user_id: userId, plan: changes.plan, status: changes.status || 'active', amount: 0, currency: 'INR',
      period_start: patch.period_start, period_end: patch.period_end, created_at: now, updated_at: now,
    }
    const { data, error: insErr } = await supabase.from('subscriptions').insert(row).select('id, plan, status, period_start, period_end').single()
    if (insErr) throw new AccessError(400, `Database rejected the new subscription: ${insErr.message}`)
    return { userId, email: user.user.email, action: 'insert', after: data }
  }

  return { listSubscribers, updateSubscription, writesEnabled }
}
