import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { log } from '../lib/log.js'

const str = (max) => z.string().trim().max(max)
const json = z.any()                                            // JSON columns (section_scores, plan_json, …)
const bad = (res, err) => res.status(400).json({ error: err.issues?.[0]?.message || 'Invalid request' })

/**
 * user_metadata keys the website may change. Anything else is refused (.strict) — in particular
 * plan / subscription / plan_expires (only POST /api/me/plan-sync sets those, from the subscriptions table)
 * and avatar_url (only the avatar upload sets it).
 */
const metadataSchema = z.object({
  exam_region: str(10), selected_categories: z.array(str(60)).max(30), target_exam: str(80),
  onboarding_complete: z.boolean(), full_name: str(100), phone: str(20),
  dob: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of birth must be yyyy-mm-dd'), z.literal(''), z.null()]),
  gender: str(30), referral_source: str(100), category: str(20), state: str(60), level: str(30),
  notif_off_subs: z.boolean(), notif_off_promo: z.boolean(),
  welcome_guide_done: z.boolean(),                       // first-time welcome guide finished (website)
}).partial().strict()

// Unknown keys are dropped (strip) — e.g. a student_id sent by the browser is ignored; the server sets it.
const resultSchema = z.object({
  exam: str(80), total_score: z.number(), max_score: z.number(), percentage: z.number(),
  correct_count: z.number().int(), wrong_count: z.number().int(), skipped_count: z.number().int(),
  section_scores: json, topic_scores: json, weak_topics: json, strong_topics: json, ai_feedback: json,
  exam_readiness: json, test_id_str: z.string().max(200).nullable().optional(), result_json: json,
}).partial().required({ exam: true })
const studyPlanSchema = z.object({
  exam_id: str(80), exam_date: z.string().max(20).nullable(), hours_per_day: z.number().min(0).max(24).nullable(),
  weak_topics: json, plan_json: json,
}).partial()
const onboardingSchema = z.object({
  exam_id: str(80), selected_exams: z.array(str(80)).max(30), exam_date: z.string().max(20).nullable(),
  hours_per_day: z.number().min(0).max(24).nullable(), weak_topics: json, onboarding_done: z.boolean(), phone: str(20), level: str(30),
}).partial()
const profileSchema = z.object({
  full_name: str(100), phone: str(20), dob: z.string().max(10).nullable(), gender: str(30).nullable(),
  referral_source: str(100).nullable(), category: str(20), state: str(60), target_exam: str(80),
}).partial()

const AVATAR_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } })   // Vercel body limit 4.5 MB

/** Signed-in student data — /api/me/* (every query uses req.user.id from the verified token). */
export function studentRoutes({ auth, students }) {
  const r = Router()
  r.use(auth.requireAuth)
  const handle = (fn) => async (req, res, next) => { try { await fn(req, res) } catch (e) { next(e) } }

  r.patch('/metadata', handle(async (req, res) => {
    const p = metadataSchema.safeParse(req.body)
    if (!p.success) return bad(res, p.error)
    res.json({ user: await students.updateMetadata(req.user.id, p.data) })
  }))
  r.post('/plan-sync', handle(async (req, res) => res.json({ user: await students.syncPlan(req.user.id) })))

  r.post('/results', handle(async (req, res) => {
    const p = resultSchema.safeParse(req.body)
    if (!p.success) return bad(res, p.error)
    res.status(201).json(await students.addResult(req.user.id, p.data))
  }))
  r.get('/results', handle(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100)
    const examPrefixes = String(req.query.examPrefixes || '').split(',').map((s) => s.trim()).filter((s) => /^[a-z0-9_]{1,20}$/i.test(s))
    const exam = req.query.exam ? String(req.query.exam).slice(0, 80) : undefined
    res.json({ results: await students.listResults(req.user.id, { limit, exam, examPrefixes }) })
  }))
  r.delete('/results', handle(async (req, res) => res.json(await students.deleteMyData(req.user.id))))

  r.get('/study-plan', handle(async (req, res) => res.json({ plan: await students.getStudyPlan(req.user.id) })))
  r.put('/study-plan', handle(async (req, res) => {
    const p = studyPlanSchema.safeParse(req.body)
    if (!p.success) return bad(res, p.error)
    res.json({ plan: await students.replaceStudyPlan(req.user.id, p.data) })
  }))
  r.patch('/study-plan', handle(async (req, res) => {
    if (req.body?.plan_json === undefined) return res.status(400).json({ error: 'plan_json is required' })
    res.json(await students.updateStudyPlanJson(req.user.id, req.body.plan_json))
  }))

  r.put('/onboarding', handle(async (req, res) => {
    const p = onboardingSchema.safeParse(req.body)
    if (!p.success) return bad(res, p.error)
    res.json(await students.upsertOnboarding(req.user.id, p.data))
  }))
  r.put('/profile', handle(async (req, res) => {
    const p = profileSchema.safeParse(req.body)
    if (!p.success) return bad(res, p.error)
    res.json(await students.upsertProfile(req.user.id, p.data))
  }))
  r.delete('/data', handle(async (req, res) => {
    log('student.delete_data', { user: req.user.email })
    res.json(await students.deleteMyData(req.user.id))
  }))

  r.get('/topic-stats', handle(async (req, res) => res.json({ stats: await students.topicStats(req.user.id) })))

  r.post('/avatar', (req, res, next) => avatarUpload.single('file')(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Image must be under 4 MB' })
    if (err) return next(err)
    const ext = AVATAR_TYPES[req.file?.mimetype]
    if (!req.file || !ext) return res.status(400).json({ error: 'Please select a JPG, PNG, WebP or GIF image' })
    students.saveAvatar(req.user.id, { buffer: req.file.buffer, mimetype: req.file.mimetype, ext }).then((out) => res.json(out), next)
  }))

  return r
}

/** Public data for logged-out pages — /api/public/*. */
export function publicRoutes({ students }) {
  const r = Router()
  const handle = (fn) => async (req, res, next) => { try { await fn(req, res) } catch (e) { next(e) } }
  r.get('/current-affairs', handle(async (req, res) => {
    const q = req.query
    if (q.countDate) return res.json({ count: await students.currentAffairsCount(String(q.countDate).slice(0, 10)) })
    res.json({ items: await students.currentAffairs({
      from: q.from ? String(q.from).slice(0, 10) : undefined,
      category: q.category ? String(q.category).slice(0, 60) : undefined,
      exam: q.exam ? String(q.exam).slice(0, 60) : undefined,
    }) })
  }))
  r.get('/previous-papers', handle(async (_req, res) => res.json({ papers: await students.previousPapers() })))
  return r
}
