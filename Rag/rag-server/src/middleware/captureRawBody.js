function captureRawBody(req, _res, buffer) {
  req.rawBody = Buffer.from(buffer)
}

module.exports = { captureRawBody }

