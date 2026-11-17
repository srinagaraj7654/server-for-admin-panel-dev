/* ══════════════════════════════════════════════════════════════════════════
   Access store — all Supabase reads/writes for module access.
   • Reads existing `user_access` (renamed from user_roles) to honour current super admins.
   • Reads/writes ONLY the new `admin_access` table.
   • SUPER_ADMIN_EMAILS (env) are always super admins.
   ══════════════════════════════════════════════════════════════════════════ */
import { createClient } from '@supabase/supabase-js'
import { DOMAIN_IDS } from '../config/domains.js'

export class AccessError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

const norm = (e) => String(e || '').trim().toLowerCase()

export function createAccessStore(supabase, config) {
  const isEnvSuperAdmin = (email) => config.superAdminEmails.includes(norm(email))

  async function getUserFromToken(token) {
    if (!token) return null
    const { data, error } = await supabase.auth.getUser(token)
    if (error || !data?.user) return null
    return data.user
  }

  /** { role: 'super_admin' | 'admin' | 'student', domains: string[] } */
  async function getAccess(user) {
    if (isEnvSuperAdmin(user.email)) return { role: 'super_admin', domains: DOMAIN_IDS, source: 'env' }

    const { data: legacy } = await supabase.from('user_access').select('role').eq('user_id', user.id).maybeSingle()
    if (legacy?.role === 'super_admin') return { role: 'super_admin', domains: DOMAIN_IDS, source: 'user_access' }

    const { data: row } = await supabase.from('admin_access').select('role, domains').eq('user_id', user.id).maybeSingle()
    if (row?.role === 'super_admin') return { role: 'super_admin', domains: DOMAIN_IDS, source: 'admin_access' }
    if (row?.role === 'admin') {
      const domains = (row.domains || []).filter((d) => DOMAIN_IDS.includes(d))
      return { role: 'admin', domains, source: 'admin_access' }
    }
    return { role: 'student', domains: [], source: 'none' }
  }

  async function getUserById(id) {
    const { data } = await supabase.auth.admin.getUserById(id)
    return data?.user || null
  }

  /** Search auth users by email (substring). Scans up to 5 pages × 1000 users. */
  async function searchUsers(q, limit = 10) {
    const term = norm(q)
    if (term.length < 2) return []
    const out = []
    for (let page = 1; page <= 5 && out.length < limit; page++) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 })
      if (error) throw new AccessError(502, 'Could not search users')
      const users = data?.users || []
      for (const u of users) {
        if (norm(u.email).includes(term)) out.push({ id: u.id, email: u.email, name: u.user_metadata?.full_name || '' })
        if (out.length >= limit) break
      }
      if (users.length < 1000) break
    }
    return out
  }

  async function findUserByEmail(email) {
    const target = norm(email)
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 })
      if (error) throw new AccessError(502, 'Could not look up user')
      const users = data?.users || []
      const hit = users.find((u) => norm(u.email) === target)
      if (hit) return hit
      if (users.length < 1000) break
    }
    return null
  }

  /** All admins + super admins (admin_access, user_access super admins, env super admins). */
  async function listAdmins() {
    const { data: rows, error } = await supabase.from('admin_access').select('*').order('granted_at', { ascending: false })
    if (error) throw new AccessError(502, 'Could not load admins — is the admin_access table present in Supabase?')
    const result = new Map()
    for (const r of rows || []) {
      result.set(r.user_id, {
        userId: r.user_id, email: r.email, role: r.role,
        domains: r.role === 'super_admin' ? DOMAIN_IDS : (r.domains || []),
        grantedBy: r.granted_by, grantedAt: r.granted_at, updatedAt: r.updated_at,
        source: 'admin_access', editable: r.role === 'admin',
      })
    }
    const { data: legacy } = await supabase.from('user_access').select('user_id, role').eq('role', 'super_admin')
    for (const r of legacy || []) {
      if (result.has(r.user_id) && result.get(r.user_id).role === 'super_admin') continue
      const u = await getUserById(r.user_id)
      result.set(r.user_id, {
        userId: r.user_id, email: u?.email || '(unknown)', role: 'super_admin', domains: DOMAIN_IDS,
        grantedBy: null, grantedAt: null, updatedAt: null, source: 'user_access', editable: false,
      })
    }
    for (const email of config.superAdminEmails) {
      if ([...result.values()].some((a) => norm(a.email) === email)) continue
      result.set(`env:${email}`, {
        userId: null, email, role: 'super_admin', domains: DOMAIN_IDS,
        grantedBy: null, grantedAt: null, updatedAt: null, source: 'env', editable: false,
      })
    }
    // Resolve "granted by" emails for display
    const grantors = new Map()
    for (const a of result.values()) {
      if (a.grantedBy && !grantors.has(a.grantedBy)) grantors.set(a.grantedBy, (await getUserById(a.grantedBy))?.email || null)
      a.grantedByEmail = a.grantedBy ? grantors.get(a.grantedBy) : null
    }
    return [...result.values()]
  }

  async function assertNotSuperAdmin(user) {
    const access = await getAccess(user)
    if (access.role === 'super_admin') throw new AccessError(409, 'This user is a super admin — super admin access is managed in the database, not here.')
  }

  /** Grant (or update) domain-admin access by email. */
  async function grantAdmin(actor, { email, domains }) {
    const user = await findUserByEmail(email)
    if (!user) throw new AccessError(404, 'No MockTest account with this email. The person must sign up / log in once first.')
    await assertNotSuperAdmin(user)
    const now = new Date().toISOString()
    const { data: existing } = await supabase.from('admin_access').select('user_id').eq('user_id', user.id).maybeSingle()
    const row = existing
      ? { domains, updated_at: now }
      : { user_id: user.id, email: user.email, role: 'admin', domains, granted_by: actor.id, granted_at: now, updated_at: now }
    const q = existing
      ? supabase.from('admin_access').update(row).eq('user_id', user.id).eq('role', 'admin')
      : supabase.from('admin_access').insert(row)
    const { error } = await q
    if (error) throw new AccessError(502, 'Could not save access')
    return { userId: user.id, email: user.email, role: 'admin', domains, created: !existing }
  }

  /**
   * Create a NEW admin account (email + password set by the super admin) and give it domain access.
   * The account is created already-confirmed, so the admin can sign in on the sign-in page straight away.
   * If the email already has an account → 409 (use grantAdmin instead). If saving access fails, the new
   * account is deleted again so no half-created admin is left behind.
   */
  async function createAdmin(actor, { name, email, password, domains }) {
    if (await findUserByEmail(email)) {
      throw new AccessError(409, 'An account with this email already exists — use "Existing account" to give it access instead.')
    }
    // The super admin's password is TEMPORARY: app_metadata.must_change_password (only this server can
    // change app_metadata — the user can't clear it themselves) blocks the admin panel until the admin
    // sets their own permanent password via POST /api/me/password.
    const { data, error } = await supabase.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { full_name: name, created_by_admin: true },
      app_metadata: { must_change_password: true },
    })
    if (error || !data?.user) throw new AccessError(400, `Could not create the account: ${error?.message || 'unknown error'}`)
    const user = data.user
    const now = new Date().toISOString()
    const { error: insErr } = await supabase.from('admin_access').insert({
      user_id: user.id, email: user.email, role: 'admin', domains, granted_by: actor.id, granted_at: now, updated_at: now,
    })
    if (insErr) {
      await supabase.auth.admin.deleteUser(user.id).catch(() => {})
      throw new AccessError(502, 'Could not save access — the account was not created')
    }
    return { userId: user.id, email: user.email, name, role: 'admin', domains, created: true, newAccount: true }
  }

  /** True if `password` is the account's CURRENT password (used to stop re-using the temporary one). */
  async function isCurrentPassword(email, password) {
    if (!config.supabasePublishableKey) return false
    const anon = createClient(config.supabaseUrl, config.supabasePublishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data, error } = await anon.auth.signInWithPassword({ email, password })
    if (!error && data?.session) { await anon.auth.signOut().catch(() => {}); return true }
    return false
  }

  /** Admin replaces their temporary password with a permanent one and the flag is cleared. */
  async function setPermanentPassword(user, password) {
    if (await isCurrentPassword(user.email, password)) {
      throw new AccessError(400, 'Choose a new password — it can’t be the temporary one you were given.')
    }
    const { error } = await supabase.auth.admin.updateUserById(user.id, {
      password, app_metadata: { must_change_password: false },
    })
    if (error) throw new AccessError(400, `Could not set the password: ${error.message}`)
    return { ok: true }
  }

  async function updateDomains(actor, userId, domains) {
    if (userId === actor.id) throw new AccessError(400, 'You cannot change your own access.')
    const { data, error } = await supabase.from('admin_access')
      .update({ domains, updated_at: new Date().toISOString() })
      .eq('user_id', userId).eq('role', 'admin').select('user_id, email, role, domains')
    if (error) throw new AccessError(502, 'Could not update access')
    if (!data?.length) throw new AccessError(404, 'Domain admin not found')
    return data[0]
  }

  async function revokeAdmin(actor, userId) {
    if (userId === actor.id) throw new AccessError(400, 'You cannot revoke your own access.')
    const { data, error } = await supabase.from('admin_access')
      .delete().eq('user_id', userId).eq('role', 'admin').select('user_id, email')
    if (error) throw new AccessError(502, 'Could not revoke access')
    if (!data?.length) throw new AccessError(404, 'Domain admin not found')
    return data[0]
  }

  return { getUserFromToken, getAccess, searchUsers, listAdmins, grantAdmin, createAdmin, setPermanentPassword, updateDomains, revokeAdmin }
}
