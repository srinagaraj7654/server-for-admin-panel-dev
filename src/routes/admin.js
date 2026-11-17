/* ══════════════════════════════════════════════════════════════════════════
   /api/admin/* — domain-checked proxy to the EXISTING MockTest API.
   Every request mirrors what the admin panel already sends to /admin/*; after the
   role/domain check it is forwarded unchanged (same body, same path), so questions
   are stored exactly as today. The admin key is added here, never by the browser.
   ══════════════════════════════════════════════════════════════════════════ */
import { Router } from 'express'
import multer from 'multer'
import { canUseExam } from '../middleware/auth.js'
import { log } from '../lib/log.js'

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })

export function adminRoutes({ auth, mainApi }) {
  const r = Router()
  r.use(auth.requireAuth, auth.requireAdmin)

  const ensureApi = (res) => {
    if (mainApi) return true
    res.status(503).json({ error: 'MAIN_API_URL is not configured on the admin server' })
    return false
  }
  const deny = (res, examId) => res.status(403).json({ error: `You don't have access to ${examId || 'this exam'}'s domain` })

  /** Forward to the existing API and relay its status + JSON body. */
  async function forward(res, method, path, { data, params, headers } = {}) {
    const resp = await mainApi.request({ method, url: path, data, params, headers })
    res.status(resp.status).json(resp.data)
  }

  /** Look up which exam a question belongs to, via the existing review queue. */
  async function examOfQuestion(qid) {
    const resp = await mainApi.get('/admin/flagged')
    const q = (resp.data?.flagged || []).find((x) => String(x.id) === String(qid))
    return q ? q.exam : null
  }

  // ── read endpoints (results filtered to the caller's domains) ──
  r.get('/stats', async (req, res, next) => {
    if (!ensureApi(res)) return
    try {
      const resp = await mainApi.get('/admin/stats')
      const data = resp.data || {}
      if (req.access.role !== 'super_admin' && Array.isArray(data.exams)) {
        data.exams = data.exams.filter((e) => canUseExam(req.access, e.exam_id))
      }
      res.status(resp.status).json(data)
    } catch (e) { next(e) }
  })

  r.get('/flagged', async (req, res, next) => {
    if (!ensureApi(res)) return
    const exam = req.query.exam ? String(req.query.exam) : ''
    if (exam && !canUseExam(req.access, exam)) return deny(res, exam)
    try {
      const resp = await mainApi.get('/admin/flagged', { params: exam ? { exam } : undefined })
      const data = resp.data || {}
      if (req.access.role !== 'super_admin' && Array.isArray(data.flagged)) {
        data.flagged = data.flagged.filter((q) => canUseExam(req.access, q.exam))
      }
      res.status(resp.status).json(data)
    } catch (e) { next(e) }
  })

  r.get('/seed-status', async (_req, res, next) => {
    if (!ensureApi(res)) return
    try { await forward(res, 'get', '/admin/seed-status') } catch (e) { next(e) }
  })

  // ── question actions (domain of the question is checked first) ──
  const questionAction = (method, pathFn, label) => async (req, res, next) => {
    if (!ensureApi(res)) return
    try {
      const qid = req.params.qid
      if (req.access.role !== 'super_admin') {
        const exam = await examOfQuestion(qid)
        if (!exam) return res.status(404).json({ error: 'Question not found in the review queue' })
        if (!canUseExam(req.access, exam)) return deny(res, exam)
      }
      await forward(res, method, pathFn(qid), { data: method === 'delete' ? undefined : (req.body || {}) })
      log(`question.${label}`, { by: req.user.email, qid })
    } catch (e) { next(e) }
  }
  r.put('/approve/:qid', questionAction('put', (q) => `/admin/approve/${encodeURIComponent(q)}`, 'approve'))
  r.put('/edit/:qid', questionAction('put', (q) => `/admin/edit/${encodeURIComponent(q)}`, 'edit'))
  r.delete('/question/:qid', questionAction('delete', (q) => `/admin/question/${encodeURIComponent(q)}`, 'delete'))

  r.post('/question', async (req, res, next) => {
    if (!ensureApi(res)) return
    const exam = req.body?.exam
    if (!exam) return res.status(400).json({ error: 'exam is required' })
    if (!canUseExam(req.access, exam)) return deny(res, exam)
    try {
      await forward(res, 'post', '/admin/question', { data: req.body })
      log('question.create', { by: req.user.email, exam })
    } catch (e) { next(e) }
  })

  // ── exam actions (exam id in the path) ──
  const examAction = (action) => async (req, res, next) => {
    if (!ensureApi(res)) return
    const examId = req.params.examId
    if (!canUseExam(req.access, examId)) return deny(res, examId)
    try {
      await forward(res, 'post', `/admin/${action}/${encodeURIComponent(examId)}`, { data: req.body || {} })
      log(`exam.${action}`, { by: req.user.email, exam: examId })
    } catch (e) { next(e) }
  }
  r.post('/seed/:examId', examAction('seed'))
  r.post('/cancel-seed/:examId', examAction('cancel-seed'))
  r.post('/ingest/:examId', examAction('ingest'))

  r.post('/upload-syllabus', upload.single('file'), async (req, res, next) => {
    if (!ensureApi(res)) return
    const examId = req.body?.exam_id
    if (!examId || !req.file) return res.status(400).json({ error: 'exam_id and file are required' })
    if (!canUseExam(req.access, examId)) return deny(res, examId)
    try {
      const form = new FormData()
      form.append('exam_id', examId)
      form.append('file', new Blob([req.file.buffer], { type: req.file.mimetype || 'application/pdf' }), req.file.originalname)
      await forward(res, 'post', '/admin/upload-syllabus', { data: form })
      log('exam.upload-syllabus', { by: req.user.email, exam: examId, bytes: req.file.size })
    } catch (e) { next(e) }
  })

  // ── super-admin-only modules (Current Affairs / scheduler) ──
  r.get('/ca-status', auth.requireSuperAdmin, async (_req, res, next) => {
    if (!ensureApi(res)) return
    try { await forward(res, 'get', '/admin/ca-status') } catch (e) { next(e) }
  })
  r.get('/ca-log', auth.requireSuperAdmin, async (req, res, next) => {
    if (!ensureApi(res)) return
    try { await forward(res, 'get', '/admin/ca-log', { params: { limit: req.query.limit || 5 } }) } catch (e) { next(e) }
  })
  r.post('/run-ca', auth.requireSuperAdmin, async (req, res, next) => {
    if (!ensureApi(res)) return
    try { await forward(res, 'post', '/admin/run-ca', { data: {} }); log('ca.run', { by: req.user.email }) } catch (e) { next(e) }
  })

  return r
}
