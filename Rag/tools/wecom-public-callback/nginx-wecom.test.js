const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')

const source = readFileSync(require.resolve('./nginx-wecom.conf'), 'utf8')
const bootstrap = readFileSync(require.resolve('./nginx-wecom-bootstrap.conf'), 'utf8')

test('bootstrap serves only the ACME challenge before TLS exists', () => {
  assert.match(bootstrap, /server_name\s+wecom\.thelonelybrave\.cn;/)
  assert.match(bootstrap, /access_log\s+off;/)
  assert.match(bootstrap, /location \^~ \/\.well-known\/acme-challenge\//)
  assert.match(bootstrap, /root\s+\/var\/www\/certbot;/)
  assert.match(bootstrap, /location \/\s*\{\s*return 404;/s)
  assert.doesNotMatch(bootstrap, /proxy_pass|ssl_certificate/)
})

test('terminates HTTPS and proxies only the WeCom callback path', () => {
  assert.match(source, /server_name\s+wecom\.thelonelybrave\.cn;/)
  assert.match(source, /location \^~ \/webhooks\/wecom\//)
  assert.match(source, /proxy_pass\s+http:\/\/127\.0\.0\.1:18788;/)
  assert.match(source, /location \/\s*\{\s*return 404;/s)
  assert.doesNotMatch(source, /proxy_pass\s+http:\/\/127\.0\.0\.1:(3001|3003|8787)/)
})

test('does not log callback query strings and applies bounded request controls', () => {
  assert.match(source, /log_format\s+wecom_callback[^;]*\$uri[^;]*;/s)
  assert.doesNotMatch(source, /log_format\s+wecom_callback[^;]*\$request_uri/s)
  assert.match(source, /listen 80;[\s\S]*access_log\s+off;[\s\S]*return 301/s)
  assert.match(source, /client_max_body_size\s+1m;/)
  assert.match(source, /limit_req\s+zone=wecom_callback/)
  assert.match(source, /limit_except GET POST/)
})
