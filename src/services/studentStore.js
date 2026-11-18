/* ══════════════════════════════════════════════════════════════════════════
   Student data — everything the website used to read/write directly in Supabase (except the
   question/answer API, which stays on the main MockTest API). Every query is scoped to the
   signed-in user's id taken from the verified token — never from the browser.
   Tables (unchanged): results, study_plans, student_onboarding, profiles, student_topic_stats,
   subscriptions (read), current_affairs + previous_papers (public reads); storage bucket "avatars".
   ══════════════════════════════════════════════════════════════════════════ */
import { AccessError } from './accessStore.js'

const fail = (what) => (error) => { if (error) throw new AccessError(502, `Could not ${what}`) }

export function createStudentStore(supabase) {
  async function getUser(id) {
    const { data, error } = await supabase.auth.admin.getUserById(id)
    if (error || !data?.user) throw new AccessError(404, 'Account not found')
    return data.user
  }

  /** Merge allowed keys into user_metadata (the route validates which keys). Returns the updated user. */
  async function updateMetadata(id, patch) {
    const user = await getUser(id)
    const { data, error } = await supabase.auth.admin.updateUserById(id, { user_metadata: { ...(user.user_metadata || {}), ...patch } })
    if (error) throw new AccessError(502, 'Could not save your details')
    return data.user
  }

  /** Plan comes ONLY from the subscriptions table (the browser can no longer set it). Same rules as before. */
  async function syncPlan(id) {
    const user = await getUser(id)
    const { data, error } = await supabase.from('subscriptions').select('plan, period_end')
      .eq('user_id', id).eq('status', 'active').order('period_end', { ascending: false }).limit(1)
    if (error) return user                                     // on a read error never change the plan
    const row = data?.[0]
    const active = row && (!row.period_end || new Date(row.period_end) > new Date())
    const meta = user.user_metadata || {}
    const cur = String(meta.plan || meta.subscription || '').toLowerCase()
    let next = null
    if (active && (cur !== row.plan || meta.plan_expires !== row.period_end)) next = { plan: row.plan, subscription: row.plan, plan_expires: row.period_end }
    else if (!active && cur && !['free', 'none'].includes(cur)) next = { plan: 'free', subscription: 'free', plan_expires: null }
    if (!next) return user
    const { data: upd, error: e2 } = await supabase.auth.admin.updateUserById(id, { user_metadata: { ...meta, ...next } })
    return e2 ? user : upd.user
  }

  /* results */
  async function addResult(id, row) {
    const full = { ...row, student_id: id }
    let { error } = await supabase.from('results').insert(full)
    if (error && /result_json/.test(error.message || '')) {     // older DB without that column (same retry as before)
      const { result_json, ...rest } = full; ({ error } = await supabase.from('results').insert(rest))
    }
    fail('save the result')(error)
    return { ok: true }
  }
  async function listResults(id, { limit = 50, exam, examPrefixes = [], columns = '*' } = {}) {
    let q = supabase.from('results').select(columns).eq('student_id', id)
    if (exam) q = q.eq('exam', exam)
    if (examPrefixes.length) q = q.or(examPrefixes.map((p) => `exam.like.${p}%`).join(','))
    const { data, error } = await q.order('created_at', { ascending: false }).limit(limit)
    fail('load results')(error)
    return data || []
  }

  /* study plan (one per user: replace = delete + insert, as before) */
  async function getStudyPlan(id) {
    const { data, error } = await supabase.from('study_plans').select('*').eq('user_id', id).order('created_at', { ascending: false }).limit(1)
    fail('load the study plan')(error)
    return data?.[0] || null
  }
  async function replaceStudyPlan(id, plan) {
    await supabase.from('study_plans').delete().eq('user_id', id)
    const { data, error } = await supabase.from('study_plans').insert({ ...plan, user_id: id, created_at: new Date().toISOString() }).select().single()
    fail('save the study plan')(error)
    return data
  }
  async function updateStudyPlanJson(id, planJson) {
    const { error } = await supabase.from('study_plans').update({ plan_json: planJson }).eq('user_id', id)
    fail('save the study plan')(error)
    return { ok: true }
  }

  /* onboarding / profile */
  async function upsertOnboarding(id, fields) {
    const { error } = await supabase.from('student_onboarding').upsert({ ...fields, student_id: id, updated_at: new Date().toISOString() }, { onConflict: 'student_id' })
    fail('save onboarding')(error)
    return { ok: true }
  }
  async function upsertProfile(id, fields) {
    const { error } = await supabase.from('profiles').upsert({ ...fields, id }, { onConflict: 'id' })
    fail('save the profile')(error)
    return { ok: true }
  }
  /** Same scope as the website's "Delete my account" today: results + profile rows. */
  async function deleteMyData(id) {
    const a = await supabase.from('results').delete().eq('student_id', id)
    const b = await supabase.from('profiles').delete().eq('id', id)
    fail('delete your data')(a.error || b.error)
    return { ok: true }
  }

  async function topicStats(id) {
    const { data, error } = await supabase.from('student_topic_stats').select('topic, last_accuracy, attempts, correct, total_questions').eq('student_id', id)
    fail('load topic stats')(error)
    return data || []
  }

  /** Upload to the public "avatars" bucket at <id>/avatar.<ext>, then save avatar_url. */
  async function saveAvatar(id, { buffer, mimetype, ext }) {
    const path = `${id}/avatar.${ext}`
    const { error } = await supabase.storage.from('avatars').upload(path, buffer, { upsert: true, contentType: mimetype })
    fail('upload the photo')(error)
    const { data } = supabase.storage.from('avatars').getPublicUrl(path)
    const url = `${data.publicUrl}?t=${Date.now()}`             // bust the browser cache after a re-upload
    const user = await updateMetadata(id, { avatar_url: url })
    return { url, user }
  }

  /* public pages (no sign-in) */
  async function currentAffairs({ from, category, exam, limit = 200 }) {
    let q = supabase.from('current_affairs').select('*')
    if (from) q = q.gte('date', from)
    if (category) q = q.eq('category', category)
    if (exam) q = q.contains('tags', [exam])
    const { data, error } = await q.order('date', { ascending: false }).order('created_at', { ascending: false }).limit(limit)
    fail('load current affairs')(error)
    return data || []
  }
  async function currentAffairsCount(date) {
    const { count, error } = await supabase.from('current_affairs').select('id', { count: 'exact', head: true }).eq('date', date)
    fail('count current affairs')(error)
    return count || 0
  }
  async function previousPapers() {
    const { data, error } = await supabase.from('previous_papers').select('*').eq('is_published', true)
      .order('sort_order', { ascending: true }).order('year', { ascending: false })
    fail('load previous papers')(error)
    return data || []
  }

  return { updateMetadata, syncPlan, addResult, listResults, getStudyPlan, replaceStudyPlan, updateStudyPlanJson,
    upsertOnboarding, upsertProfile, deleteMyData, topicStats, saveAvatar, currentAffairs, currentAffairsCount, previousPapers }
}
