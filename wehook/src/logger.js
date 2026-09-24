function write(level, event, fields = {}) {
  const safe = { ...fields }
  for (const key of ['token', 'authorization', 'secret', 'password', 'content']) {
    if (key in safe) safe[key] = '[redacted]'
  }
  process.stdout.write(`${JSON.stringify({ level, event, at: new Date().toISOString(), ...safe })}\n`)
}

module.exports = {
  info: (event, fields) => write('info', event, fields),
  warn: (event, fields) => write('warn', event, fields),
  error: (event, fields) => write('error', event, fields)
}
