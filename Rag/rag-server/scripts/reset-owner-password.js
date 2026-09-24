const path = require('node:path')
const dotenv = require('dotenv')
const mysql = require('mysql2/promise')
const bcrypt = require('bcryptjs')

dotenv.config({ path: path.join(__dirname, '..', '.env') })

async function main() {
  const username = String(process.env.LOCAL_OWNER_RESET_USERNAME || 'admin').trim()
  const password = String(process.env.LOCAL_OWNER_RESET_PASSWORD || '')
  if (!/^[\w.-]{2,50}$/.test(username)) throw new Error('账号格式无效')
  if (password.length < 8 || password.length > 72) throw new Error('新密码长度须为 8-72 个字符')

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  })
  try {
    const hash = await bcrypt.hash(password, 12)
    const [result] = await connection.execute(
      "UPDATE users SET password = ?, status = 'active', role = 'admin', updated_at = NOW() WHERE username = ? AND role = 'admin'",
      [hash, username]
    )
    if (result.affectedRows !== 1) throw new Error(`未找到管理员账号: ${username}`)
    process.stdout.write(`管理员账号 ${username} 的密码已重置。\n`)
  } finally {
    await connection.end()
  }
}

main().catch(error => {
  console.error(`密码重置失败: ${error.message}`)
  process.exitCode = 1
})
