// Vercel entry (Express preset). Vercel picks the first of app.js / index.js / server.js / src/app.js / …
// that imports `express`; this root file comes before src/app.js (which only exports createApp).
// It default-exports the wired app; Vercel runs it as one function. Settings come from the
// project's Environment Variables in Vercel (not from a .env file). Local runs use src/index.js.
import 'express'
import { buildServer } from './src/build.js'

const { app, missing } = buildServer()
if (missing.length) console.warn(`Missing settings: ${missing.join(', ')} — add them in Vercel → Settings → Environment Variables`)

export default app
