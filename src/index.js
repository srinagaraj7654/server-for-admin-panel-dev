// Local / any Node host: `npm run dev` or `npm start` → http://localhost:4000
import { buildServer } from './build.js'
import { log } from './lib/log.js'

const { app, config, missing } = buildServer()

app.listen(config.port, () => {
  log('server.start', { port: config.port, subscriptionWrites: config.allowSubscriptionWrites, allowedOrigins: config.allowedOrigins, missingConfig: missing })
  if (missing.length) console.warn(`⚠  Missing settings in .env: ${missing.join(', ')} — see .env.example`)
})
