// Run with: npm test   (node:test — no extra dependencies, no real Supabase / API needed)
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { domainOfExam } from '../src/config/domains.js'
import { buildSubscribers, pickCurrent, createSubscriptionStore } from '../src/services/subscriptionStore.js'

// ── fakes ──────────────────────────────────────────────────────────────────
const USERS = {
  'tok-super':   { id: '00000000-0000-4000-8000-000000000001', email: 'boss@arkaserve.com',   access: { role: 'super_admin', domains: ['banking', 'ssc'] } },
  'tok-banking': { id: '00000000-0000-4000-8000-000000000002', email: 'bank@arkaserve.com',   access: { role: 'admin', domains: ['banking'] } },
  'tok-student': { id: '00000000-0000-4000-8000-000000000003', email: 'kid@gmail.com',        access: { role: 'student', domains: [] } },
  'tok-temp':    { id: '00000000-0000-4000-8000-000000000004', email: 'temp@arkaserve.com', temp: true, access: { role: 'admin', domains: ['banking'] } },
}
const calls = []
const store = {
  getUserFromToken: async (t) => USERS[t] ? { id: USERS[t].id, email: USERS[t].email, app_metadata: { must_change_password: !!USERS[t].temp } } : null,
  setPermanentPassword: async (u, p) => { calls.push(['pw', u.email, p]); return { ok: true } },
  sendAdminPasswordReset: async (email, redirectTo) => { calls.push(['reset', email, redirectTo]); return { sent: email.endsWith('@arkaserve.com') } },
  getAccess: async (u) => Object.values(USERS).find((x) => x.id === u.id).access,
  listAdmins: async () => [{ email: 'bank@arkaserve.com', role: 'admin', domains: ['banking'] }],
  searchUsers: async () => [],
  grantAdmin: async (_a, d) => { calls.push(['grant', d]); return { ...d, userId: 'x', role: 'admin', created: true } },
  createAdmin: async (_a, d) => { calls.push(['create', d]); return { userId: 'n', email: d.email, role: 'admin', domains: d.domains, created: true } },
  updateDomains: async () => ({}),
  revokeAdmin: async () => ({}),
}
const FLAGGED = [{ id: 'q-bank', exam: 'sbi_po_prelims' }, { id: 'q-ssc', exam: 'ssc_cgl_tier1' }]
const mainApi = {
  get: async (url) => {
    calls.push(['GET', url])
    if (url === '/admin/flagged') return { status: 200, data: { flagged: FLAGGED } }
    if (url === '/admin/stats') return { status: 200, data: { exams: [{ exam_id: 'bank_po_prelims' }, { exam_id: 'ssc_cgl_tier1' }] } }
    return { status: 200, data: {} }
  },
  request: async ({ method, url, data }) => { calls.push([method.toUpperCase(), url, data]); return { status: 200, data: { ok: true } } },
}
const subscriptions = {
  listSubscribers: async () => ({ subscribers: [{ id: 'u1', plan: 'pro' }], writable: false }),
  updateSubscription: async (id, c) => { calls.push(['sub', id, c]); return { userId: id, action: 'update' } },
}
const config = { allowedOrigins: ['http://localhost:3000'] }

let server, base
before(async () => {
  server = createApp({ store, subscriptions, mainApi, config }).listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())

const call = (path, { token, method = 'GET', body } = {}) => fetch(base + path, {
  method,
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
})

// ── tests ──────────────────────────────────────────────────────────────────
test('domains: exam ids map to the right category', () => {
  assert.equal(domainOfExam('sbi_po_prelims'), 'banking')
  assert.equal(domainOfExam('rrb_office_assistant_prelims'), 'banking')
  assert.equal(domainOfExam('rrb_ntpc_cbt1'), 'railway')
  assert.equal(domainOfExam('ap_eamcet_engg'), 'state')
  assert.equal(domainOfExam('ap_calc_ab'), 'us')
  assert.equal(domainOfExam('lic_aao_pre'), 'insurance')
  assert.equal(domainOfExam('nonsense'), null)
})

test('health works without auth', async () => {
  const r = await call('/health'); assert.equal(r.status, 200)
})

test('no token → 401, bad token → 401', async () => {
  assert.equal((await call('/api/me/access')).status, 401)
  assert.equal((await call('/api/me/access', { token: 'nope' })).status, 401)
})

test('/api/me/access returns role, domains, modules', async () => {
  const r = await call('/api/me/access', { token: 'tok-banking' })
  const j = await r.json()
  assert.equal(j.role, 'admin'); assert.deepEqual(j.domains, ['banking'])
  assert.deepEqual(j.modules, ['exams', 'write', 'upload', 'flagged'])
})

test('only super admins can manage access', async () => {
  assert.equal((await call('/api/access/admins', { token: 'tok-banking' })).status, 403)
  assert.equal((await call('/api/access/admins', { token: 'tok-student' })).status, 403)
  assert.equal((await call('/api/access/admins', { token: 'tok-super' })).status, 200)
})

test('grant validates email and domains', async () => {
  assert.equal((await call('/api/access/admins', { token: 'tok-super', method: 'POST', body: { email: 'x', domains: ['banking'] } })).status, 400)
  assert.equal((await call('/api/access/admins', { token: 'tok-super', method: 'POST', body: { email: 'a@b.com', domains: ['mars'] } })).status, 400)
  assert.equal((await call('/api/access/admins', { token: 'tok-super', method: 'POST', body: { email: 'a@b.com', domains: [] } })).status, 400)
  const ok = await call('/api/access/admins', { token: 'tok-super', method: 'POST', body: { email: 'a@b.com', domains: ['ssc', 'ssc'] } })
  assert.equal(ok.status, 201)
  assert.deepEqual(calls.find((c) => c[0] === 'grant')[1], { email: 'a@b.com', domains: ['ssc'] })
})

test('students cannot use admin endpoints', async () => {
  assert.equal((await call('/api/admin/stats', { token: 'tok-student' })).status, 403)
})

test('domain admin: own-domain approve is forwarded unchanged', async () => {
  const r = await call('/api/admin/approve/q-bank', { token: 'tok-banking', method: 'PUT', body: {} })
  assert.equal(r.status, 200)
  assert.ok(calls.some((c) => c[0] === 'PUT' && c[1] === '/admin/approve/q-bank'))
})

test('domain admin: other-domain approve / write / seed → 403 and NOT forwarded', async () => {
  assert.equal((await call('/api/admin/approve/q-ssc', { token: 'tok-banking', method: 'PUT', body: {} })).status, 403)
  assert.equal((await call('/api/admin/question', { token: 'tok-banking', method: 'POST', body: { exam: 'ssc_cgl_tier1' } })).status, 403)
  assert.equal((await call('/api/admin/seed/ssc_cgl_tier1', { token: 'tok-banking', method: 'POST', body: {} })).status, 403)
  assert.ok(!calls.some((c) => c[1] === '/admin/approve/q-ssc' || c[1] === '/admin/seed/ssc_cgl_tier1'))
})

test('domain admin: lists are filtered to their domains', async () => {
  const f = await (await call('/api/admin/flagged', { token: 'tok-banking' })).json()
  assert.deepEqual(f.flagged.map((q) => q.id), ['q-bank'])
  const s = await (await call('/api/admin/stats', { token: 'tok-banking' })).json()
  assert.deepEqual(s.exams.map((e) => e.exam_id), ['bank_po_prelims'])
})

test('Current Affairs is super-admin only', async () => {
  assert.equal((await call('/api/admin/run-ca', { token: 'tok-banking', method: 'POST', body: {} })).status, 403)
  assert.equal((await call('/api/admin/run-ca', { token: 'tok-super', method: 'POST', body: {} })).status, 200)
})

test('super admin can act on any domain', async () => {
  assert.equal((await call('/api/admin/approve/q-ssc', { token: 'tok-super', method: 'PUT', body: {} })).status, 200)
})

// ── Users & Subscriptions ──────────────────────────────────────────────────
const U1 = '00000000-0000-4000-8000-0000000000a1'

test('subscriptions: super admin only', async () => {
  assert.equal((await call('/api/subscriptions')).status, 401)
  assert.equal((await call('/api/subscriptions', { token: 'tok-banking' })).status, 403)
  assert.equal((await call('/api/subscriptions', { token: 'tok-student' })).status, 403)
  assert.equal((await call(`/api/subscriptions/${U1}`, { token: 'tok-banking', method: 'PATCH', body: { plan: 'pro' } })).status, 403)
  const r = await call('/api/subscriptions', { token: 'tok-super' })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).subscribers[0].plan, 'pro')
})

test('subscriptions: PATCH validates input before touching the store', async () => {
  const before = calls.filter((c) => c[0] === 'sub').length
  const bad = async (path, body) => (await call(path, { token: 'tok-super', method: 'PATCH', body })).status
  assert.equal(await bad('/api/subscriptions/not-a-uuid', { plan: 'pro' }), 400)
  assert.equal(await bad(`/api/subscriptions/${U1}`, { plan: 'gold' }), 400)
  assert.equal(await bad(`/api/subscriptions/${U1}`, { plan: 'trial' }), 400)
  assert.equal(await bad(`/api/subscriptions/${U1}`, { status: 'deleted' }), 400)
  assert.equal(await bad(`/api/subscriptions/${U1}`, { expiryDate: '12/01/2026' }), 400)
  assert.equal(await bad(`/api/subscriptions/${U1}`, { startDate: '2026-12-10', expiryDate: '2026-12-01' }), 400)
  assert.equal(await bad(`/api/subscriptions/${U1}`, { amount: 0 }), 400)          // unknown fields rejected
  assert.equal(calls.filter((c) => c[0] === 'sub').length, before)
  const ok = await call(`/api/subscriptions/${U1}`, { token: 'tok-super', method: 'PATCH', body: { plan: 'ultimate', expiryDate: '2027-01-31' } })
  assert.equal(ok.status, 200)
  assert.deepEqual(calls.at(-1), ['sub', U1, { plan: 'ultimate', expiryDate: '2027-01-31' }])
})

test('subscriptions: list merges users, profiles and rows; trial users only while in trial', () => {
  const now = Date.parse('2026-11-16T12:00:00Z')
  const users = [
    { id: 'a', email: 'paid@x.com', created_at: '2026-01-01T00:00:00Z', last_sign_in_at: '2026-11-15T00:00:00Z' },
    { id: 'b', email: 'trial@x.com', created_at: '2026-11-14T00:00:00Z' },
    { id: 'c', email: 'old@x.com', created_at: '2026-10-01T00:00:00Z' },
  ]
  const profiles = [{ id: 'a', full_name: 'Paid Person', phone: '99999' }]
  const subs = [
    { id: 's1', user_id: 'a', plan: 'basic', status: 'active', amount: 199, period_start: '2026-06-01T00:00:00Z', period_end: '2026-07-01T00:00:00Z' },
    { id: 's2', user_id: 'a', plan: 'pro', status: 'active', amount: 499, period_start: '2026-11-01T00:00:00Z', period_end: '2026-12-01T00:00:00Z' },
  ]
  const list = buildSubscribers({ users, profiles, subs, now })
  assert.deepEqual(list.map((u) => u.id), ['a', 'b'])                       // c: trial over, never paid → hidden
  assert.equal(list[0].name, 'Paid Person'); assert.equal(list[0].plan, 'pro'); assert.equal(list[0].subscriptionId, 's2')
  assert.equal(list[0].source, 'paid')
  assert.equal(list[1].plan, 'trial'); assert.equal(list[1].name, 'trial'); assert.equal(list[1].subscriptionId, null)
  assert.equal(pickCurrent([{ id: 1, status: 'suspended', period_end: '2027' }, { id: 2, status: 'active', period_end: '2026' }]).id, 2)
})

test('subscriptions: writes are refused when ALLOW_SUBSCRIPTION_WRITES is off (no DB call)', async () => {
  let touched = false
  const fakeSb = new Proxy({}, { get: () => { touched = true; return () => ({}) } })
  const s = createSubscriptionStore(fakeSb, { allowSubscriptionWrites: false })
  await assert.rejects(s.updateSubscription(U1, { plan: 'pro' }), (e) => e.status === 403)
  assert.equal(touched, false)
})

// ── Create admin account (super admin sets the password) ───────────────────
test('create admin: super admin only, validated, password never echoed', async () => {
  const body = { name: 'Bank Admin', email: 'New.Admin@Arkaserve.com', password: 'secret123', domains: ['banking'] }
  assert.equal((await call('/api/access/admins/create', { token: 'tok-banking', method: 'POST', body })).status, 403)
  assert.equal((await call('/api/access/admins/create', { token: 'tok-student', method: 'POST', body })).status, 403)
  const bad = async (b) => (await call('/api/access/admins/create', { token: 'tok-super', method: 'POST', body: { ...body, ...b } })).status
  assert.equal(await bad({ password: 'short1' }), 400)
  assert.equal(await bad({ password: 'onlyletters' }), 400)
  assert.equal(await bad({ email: 'nope' }), 400)
  assert.equal(await bad({ name: '' }), 400)
  assert.equal(await bad({ domains: [] }), 400)
  assert.ok(!calls.some((c) => c[0] === 'create'))
  const r = await call('/api/access/admins/create', { token: 'tok-super', method: 'POST', body })
  assert.equal(r.status, 201)
  assert.ok(!JSON.stringify(await r.json()).includes('secret123'))
  assert.deepEqual(calls.find((c) => c[0] === 'create')[1], { ...body, email: 'new.admin@arkaserve.com' })
})

// ── Temporary password → admin must set a permanent one ────────────────────
test('temporary password: admin panel blocked until a new password is set', async () => {
  const me = await (await call('/api/me/access', { token: 'tok-temp' })).json()
  assert.equal(me.mustChangePassword, true)
  const blocked = await call('/api/admin/stats', { token: 'tok-temp' })
  assert.equal(blocked.status, 403)
  assert.equal((await blocked.json()).code, 'PASSWORD_CHANGE_REQUIRED')
  assert.equal((await call('/api/admin/stats', { token: 'tok-banking' })).status, 200)          // normal admin unaffected
  assert.equal((await (await call('/api/me/access', { token: 'tok-banking' })).json()).mustChangePassword, false)
})

test('temporary password: set-password validates and is only for flagged accounts', async () => {
  const pw = (token, password) => call('/api/me/password', { token, method: 'POST', body: { password } })
  assert.equal((await pw(undefined, 'newpass123')).status, 401)
  assert.equal((await pw('tok-banking', 'newpass123')).status, 400)          // not on a temporary password
  assert.equal((await pw('tok-temp', 'short1')).status, 400)
  assert.equal((await pw('tok-temp', 'lettersonly')).status, 400)
  assert.ok(!calls.some((c) => c[0] === 'pw'))
  assert.equal((await pw('tok-temp', 'MyNewPass2026')).status, 200)
  assert.deepEqual(calls.find((c) => c[0] === 'pw'), ['pw', 'temp@arkaserve.com', 'MyNewPass2026'])
})


// ── Forgot password (admin accounts only, same answer for everyone) ────────
test('forgot password: same message for admin and non-admin, validated, uses an allowed origin', async () => {
  const send = (email, origin) => fetch(base + '/api/auth/forgot-password', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ email }) })
  const a = await send('Bank@Arkaserve.com', 'http://localhost:3000')
  const b = await send('kid@gmail.com', 'https://evil.example')
  assert.equal(a.status, 200); assert.equal(b.status, 200)
  assert.equal((await a.json()).message, (await b.json()).message)          // no way to tell admins apart
  const resets = calls.filter((c) => c[0] === 'reset')
  assert.deepEqual(resets[0], ['reset', 'bank@arkaserve.com', 'http://localhost:3000'])
  assert.deepEqual(resets[1], ['reset', 'kid@gmail.com', 'http://localhost:3000'])  // unknown origin → first allowed origin
  assert.equal((await send('not-an-email')).status, 400)
})

test('forgot password: rate limited to 5 per 15 minutes', async () => {
  let last
  for (let i = 0; i < 6; i++) last = await fetch(base + '/api/auth/forgot-password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'x@y.com' }) })
  assert.equal(last.status, 429)
})

// ── Reset link ("recovery" sign-in) may set a new password ─────────────────
import { tokenAuthMethods } from '../src/middleware/auth.js'
test('recovery sign-in (amr=recovery) may set a new password; normal sign-in may not', async () => {
  const jwt = (amr) => `h.${Buffer.from(JSON.stringify({ amr })).toString('base64url')}.s`
  const recTok = jwt([{ method: 'recovery', timestamp: 1 }])
  const pwTok = jwt([{ method: 'password', timestamp: 1 }])
  assert.deepEqual(tokenAuthMethods(recTok), ['recovery'])
  assert.deepEqual(tokenAuthMethods('not-a-jwt'), [])
  const bank = USERS['tok-banking']
  USERS[recTok] = { ...bank }; USERS[pwTok] = { ...bank }
  const set = (token) => call('/api/me/password', { token, method: 'POST', body: { password: 'Recover2026' } })
  assert.equal((await set(pwTok)).status, 400)                                  // already has a password
  assert.equal((await set(recTok)).status, 200)
  assert.deepEqual(calls.filter((c) => c[0] === 'pw').at(-1), ['pw', 'bank@arkaserve.com', 'Recover2026'])
})
