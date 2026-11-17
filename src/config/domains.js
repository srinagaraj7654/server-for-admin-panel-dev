/* ══════════════════════════════════════════════════════════════════════════
   Domains = exam categories an admin can be given access to.
   Keep in sync with the frontend copy: mocktest-web/src/access/domains.js
   An exam belongs to the FIRST domain whose prefix matches its id
   (order matters: `state` is checked before `us` because AP EAMCET ids start with "ap_").
   ══════════════════════════════════════════════════════════════════════════ */

export const DOMAINS = [
  { id: 'banking',    label: 'Banking',            prefixes: ['bank_', 'sbi_', 'rbi_', 'nabard_', 'ibps_', 'rrb_office', 'rrb_officer', 'rrb_clerk', 'rrb_po'] },
  { id: 'insurance',  label: 'Insurance',          prefixes: ['lic_', 'niacl_', 'nicl_', 'uiic_', 'oicl_'] },
  { id: 'ssc',        label: 'SSC',                prefixes: ['ssc_'] },
  { id: 'railway',    label: 'Railway',            prefixes: ['rrb_ntpc', 'rrb_group', 'rrb_alp', 'rrb_je'] },
  { id: 'government', label: 'Government (Post / PSU)', prefixes: ['ippb_', 'coal_india'] },
  { id: 'state',      label: 'State (EAMCET)',     prefixes: ['ap_eamcet', 'ts_eamcet'] },
  { id: 'us',         label: 'US Exams',           prefixes: ['sat_', 'act_', 'psat_', 'ap_'] },
]

export const DOMAIN_IDS = DOMAINS.map((d) => d.id)

/** Domain id for an exam id, or null if it doesn't belong to any domain. */
export function domainOfExam(examId) {
  const id = String(examId || '').trim()
  if (!id) return null
  const d = DOMAINS.find((dom) => dom.prefixes.some((p) => id.startsWith(p)))
  return d ? d.id : null
}

/** Admin-panel modules each role may use. */
export const ADMIN_MODULES = {
  super_admin: ['dashboard', 'exams', 'write', 'ca', 'upload', 'flagged', 'scheduler', 'analytics', 'settings', 'access', 'subscriptions'],
  admin: ['exams', 'write', 'upload', 'flagged'],
  student: [],
}
