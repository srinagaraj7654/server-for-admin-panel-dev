# MockTest — Admin Access Server

Node.js + Express server that controls **who can use the MockTest admin panel, and for which exam domains**.

| Role | Can do |
|---|---|
| **Super admin** | Everything in the admin panel, plus **grant / change / revoke** admin access |
| **Domain admin** | Only *Exam Management, Write Questions, Upload Syllabus, Review Flagged* — and only for exams in their assigned domains (e.g. Banking) |
| Everyone else | No admin access |

Domains (exam categories): **Banking, Insurance, SSC, Railway, Government (Post/PSU), State (EAMCET), US Exams** — see `src/config/domains.js`
(keep in sync with `mocktest-web/src/access/domains.js`).

## How it fits
```
Admin panel (browser) ── Supabase login token ──▶ this server ── checks role + domain ──▶ existing MockTest API (/admin/*)
                                                     │                                        (admin key kept here)
                                                     └── Supabase: reads user_access (was user_roles),
                                                                   reads/writes admin_access (new table)
```
- Questions are **still saved by the existing API**, exactly as today — this server only checks access and forwards the same request.
- The existing API's admin key lives **only in this server's `.env`**, not in the website's JavaScript.

## Setup (local only — not hosted yet)
1. **Database:** the `admin_access` table already exists in Supabase (created once; no existing table was changed).
2. `cp .env.example .env` and fill in:
   - `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (Supabase → Project settings → API keys — the **secret** `sb_secret_…` key; keep secret). `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_JWKS_URL` are optional (kept for later)
   - `SUPER_ADMIN_EMAILS` — comma-separated emails that are always super admins
   - `MAIN_API_URL`, `MAIN_API_ADMIN_KEY` — the existing MockTest API and its admin key
   - `ALLOWED_ORIGINS` — the frontend URL(s), default `http://localhost:3000`
3. `npm install` then `npm run dev` → <http://localhost:4000/health>
4. In the MockTest frontend's **local** `.env.development` set `VITE_ACCESS_API_URL=http://localhost:4000`
   and restart `npm run dev` there. Without this variable the frontend behaves exactly as before.

## API
All `/api/*` routes need `Authorization: Bearer <Supabase access token>`.

| Method & path | Who | What |
|---|---|---|
| `GET /health` | anyone | status + missing settings |
| `GET /api/me/access` | signed-in user | `{ role, domains, modules }` |
| `GET /api/access/domains` | super admin | domain list |
| `GET /api/access/admins` | super admin | all admins & super admins |
| `GET /api/access/users?q=` | super admin | search accounts by email |
| `POST /api/access/admins` `{ email, domains[] }` | super admin | grant / update domain admin |
| `POST /api/access/admins/create` `{ name, email, password, domains[] }` | super admin | create a NEW admin account with a **temporary** password |
| `POST /api/me/password` `{ password }` | admin on a temporary password | set their own permanent password (unlocks the admin panel) |
| `PATCH /api/access/admins/:userId` `{ domains[] }` | super admin | change domains |
| `DELETE /api/access/admins/:userId` | super admin | revoke |
| `GET /api/admin/stats`, `/api/admin/flagged`, `/api/admin/seed-status` | admin | forwarded, filtered to own domains |
| `PUT /api/admin/approve/:qid`, `PUT /api/admin/edit/:qid`, `DELETE /api/admin/question/:qid` | admin (own domain) | forwarded |
| `POST /api/admin/question`, `/seed/:examId`, `/cancel-seed/:examId`, `/ingest/:examId`, `/upload-syllabus` | admin (own domain) | forwarded |
| `GET /api/admin/ca-status`, `/ca-log`, `POST /api/admin/run-ca` | super admin | forwarded |
| `GET /api/subscriptions` | super admin | paid subscribers + users still in the 7-day free trial (from auth users, `profiles`, `subscriptions`) |
| `PATCH /api/subscriptions/:userId` `{ plan?, startDate?, expiryDate?, status? }` | super admin | change a subscription (only when `ALLOW_SUBSCRIPTION_WRITES=true`); trial users get a new ₹0 row |

Super admins come from `SUPER_ADMIN_EMAILS`, existing `user_access.role = 'super_admin'` (table renamed from user_roles), or an `admin_access` row with
role `super_admin` (added via SQL). They can't be demoted from the UI. Nobody can change or revoke their own access.

## Tests
`npm test` — runs the server with fake Supabase/API (no keys needed): auth, roles, domain checks, filtering.

## Later: hosting
Any Node host works (e.g. Render: build `npm install`, start `npm start`, add the same env vars).
After it's live: point the frontend's `VITE_ACCESS_API_URL` at it, remove `VITE_ADMIN_KEY` from the frontend
and **rotate** the existing API's admin key.
