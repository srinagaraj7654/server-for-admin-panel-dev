import { ADMIN_MODULES, domainOfExam } from '../config/domains.js'

/** Verifies the Supabase access token and attaches req.user + req.access. */
export function makeAuth(store) {
  async function requireAuth(req, res, next) {
    try {
      const header = req.get('authorization') || ''
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
      if (!token) return res.status(401).json({ error: 'Sign in required' })
      const user = await store.getUserFromToken(token)
      if (!user) return res.status(401).json({ error: 'Session expired — please sign in again' })
      const access = await store.getAccess(user)
      // Set by createAdmin: the account still has the TEMPORARY password from the super admin.
      const mustChangePassword = !!user.app_metadata?.must_change_password
      req.user = { id: user.id, email: user.email, mustChangePassword }
      req.access = { ...access, modules: ADMIN_MODULES[access.role] || [] }
      next()
    } catch (err) { next(err) }
  }

  // Admin endpoints are blocked until the temporary password has been replaced.
  const passwordGate = (req, res) => req.user?.mustChangePassword
    ? (res.status(403).json({ error: 'Set your new password first', code: 'PASSWORD_CHANGE_REQUIRED' }), true) : false

  const requireAdmin = (req, res, next) => {
    if (passwordGate(req, res)) return
    return ['admin', 'super_admin'].includes(req.access?.role) ? next() : res.status(403).json({ error: 'Admin access required' })
  }

  const requireSuperAdmin = (req, res, next) => {
    if (passwordGate(req, res)) return
    return req.access?.role === 'super_admin' ? next() : res.status(403).json({ error: 'Super admin access required' })
  }

  return { requireAuth, requireAdmin, requireSuperAdmin }
}

/** Can this caller act on this exam? Super admins: always. Domain admins: only exams in their domains. */
export function canUseExam(access, examId) {
  if (access?.role === 'super_admin') return true
  if (access?.role !== 'admin') return false
  const d = domainOfExam(examId)
  return !!d && (access.domains || []).includes(d)
}
