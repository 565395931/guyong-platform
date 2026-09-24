function createHealthHandler(server) {
  return async (_req, res) => {
    try {
      return res.json(await server.health())
    } catch (error) {
      return res.status(503).json({ status: 'unavailable', code: 'store_unavailable', message: error.message })
    }
  }
}

module.exports = { createHealthHandler }
