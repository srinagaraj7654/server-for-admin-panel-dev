/** Structured one-line JSON logs (who did what, when). Never log tokens or keys. */
export function log(event, details = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...details }))
}
