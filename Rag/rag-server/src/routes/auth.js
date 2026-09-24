const express = require('express')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const User = require('../models/User')
const {
  JWT_SECRET,
  JWT_EXPIRE,
  JWT_ISSUER,
  JWT_AUDIENCE,
  JWT_ALGORITHMS
} = require('../config/jwt')

const CAPTCHA_EXPIRE_SECONDS = 5 * 60
const CAPTCHA_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

function resolveCaptchaEnabled(environment = process.env) {
  return String(environment.AUTH_CAPTCHA_ENABLED || '').trim().toLowerCase() === 'true'
}

function resolvePublicRegistrationEnabled(environment = process.env) {
  return String(environment.AUTH_PUBLIC_REGISTRATION_ENABLED || '').trim().toLowerCase() === 'true'
}

function resolveAuthMode(environment = process.env) {
  return String(environment.AUTH_MODE || 'single_owner').trim().toLowerCase() === 'team'
    ? 'team'
    : 'single_owner'
}

function createCaptchaCode(length = 4) {
  const bytes = crypto.randomBytes(length)
  let code = ''
  for (const byte of bytes) {
    code += CAPTCHA_ALPHABET[byte % CAPTCHA_ALPHABET.length]
  }
  return code
}

function escapeSvgText(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function renderCaptchaSvg(code) {
  const width = 160
  const height = 48
  const letters = [...String(code)]
    .map((letter, index) => {
      const x = 28 + index * 31
      const y = 42 + (index % 2 === 0 ? -4 : 4)
      const rotate = index % 2 === 0 ? -8 + index * 3 : 8 - index * 2
      const fill = ['#1d4ed8', '#0f766e', '#b45309', '#7c3aed'][index % 4]
      return `<text x="${x}" y="${y}" transform="rotate(${rotate} ${x} ${y})" fill="${fill}" font-size="30" font-family="Arial, Helvetica, sans-serif" font-weight="700">${escapeSvgText(letter)}</text>`
    })
    .join('')

  return `<?xml version="1.0" encoding="UTF-8"?>
  <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="captcha">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#eff6ff" />
        <stop offset="100%" stop-color="#e0f2fe" />
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" rx="8" fill="url(#bg)" />
    <path d="M8 12 L152 6" stroke="#93c5fd" stroke-width="1.4" opacity="0.8" />
    <path d="M4 36 L156 28" stroke="#60a5fa" stroke-width="1.2" opacity="0.65" />
    <path d="M12 42 L148 10" stroke="#cbd5e1" stroke-width="1" opacity="0.5" />
    ${letters}
    <circle cx="20" cy="14" r="1.6" fill="#1d4ed8" opacity="0.7" />
    <circle cx="140" cy="36" r="1.6" fill="#0f766e" opacity="0.7" />
  </svg>`
}

function createCaptchaChallenge({ jwtSecret = JWT_SECRET, ttlSeconds = CAPTCHA_EXPIRE_SECONDS } = {}) {
  const captchaCode = createCaptchaCode()
  const captchaToken = jwt.sign(
    { code: captchaCode },
    jwtSecret,
    { expiresIn: ttlSeconds }
  )
  return {
    captchaToken,
    captchaCode,
    captchaImage: `data:image/svg+xml;base64,${Buffer.from(renderCaptchaSvg(captchaCode), 'utf8').toString('base64')}`,
    expiresIn: ttlSeconds
  }
}

function normalizeCaptchaCode(value) {
  return String(value || '').replace(/\s+/g, '').toUpperCase()
}

function verifyCaptchaSubmission({ captchaToken, captchaCode, jwtSecret = JWT_SECRET }) {
  if (!captchaToken || !captchaCode) {
    const error = new Error('请填写验证码')
    error.status = 400
    throw error
  }

  let payload
  try {
    payload = jwt.verify(captchaToken, jwtSecret)
  } catch {
    const error = new Error('验证码已失效，请刷新后重试')
    error.status = 400
    throw error
  }

  if (normalizeCaptchaCode(payload.code) !== normalizeCaptchaCode(captchaCode)) {
    const error = new Error('验证码错误')
    error.status = 400
    throw error
  }
}

function createAuthRouter({
  UserModel,
  User: injectedUserModel,
  jwtSecret = JWT_SECRET,
  jwtExpire = JWT_EXPIRE,
  jwtIssuer = JWT_ISSUER,
  jwtAudience = JWT_AUDIENCE,
  jwtAlgorithms = JWT_ALGORITHMS,
  captchaEnabled = resolveCaptchaEnabled(),
  publicRegistrationEnabled = resolvePublicRegistrationEnabled(),
  authMode = resolveAuthMode(),
  createCaptcha,
  createCaptchaChallenge: injectedCreateCaptcha
} = {}) {
  const UserStore = injectedUserModel || UserModel || User
  const captchaFactory = injectedCreateCaptcha || createCaptcha || createCaptchaChallenge
  const router = express.Router()
  let setupInProgress = false

  router.get('/setup-status', async (req, res) => {
    try {
      const userCount = await UserStore.count()
      res.json({
        success: true,
        data: {
          needsSetup: userCount === 0,
          authMode,
          publicRegistrationEnabled
        }
      })
    } catch (error) {
      console.error('读取初始化状态失败:', error.message)
      res.status(503).json({ success: false, message: '暂时无法读取系统初始化状态' })
    }
  })

  router.post('/setup', async (req, res) => {
    if (setupInProgress) {
      return res.status(409).json({ success: false, message: '管理员初始化正在进行，请稍后重试' })
    }
    setupInProgress = true
    try {
      if (await UserStore.count() > 0) {
        return res.status(409).json({ success: false, message: '系统已经完成初始化，请直接登录' })
      }

      const username = String(req.body?.username || '').trim()
      const password = String(req.body?.password || '')
      if (!/^[\w.-]{2,50}$/.test(username)) {
        return res.status(400).json({ success: false, message: '用户名须为 2-50 位字母、数字、下划线、点或短横线' })
      }
      if (password.length < 8 || password.length > 72) {
        return res.status(400).json({ success: false, message: '密码长度须为 8-72 个字符' })
      }

      const user = await UserStore.create({
        username,
        password: await bcrypt.hash(password, 12),
        email: null,
        role: 'admin',
        status: 'active'
      })
      const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role },
        jwtSecret,
        { expiresIn: jwtExpire, algorithm: jwtAlgorithms[0], issuer: jwtIssuer, audience: jwtAudience }
      )
      res.status(201).json({
        success: true,
        message: '管理员初始化完成',
        data: {
          token,
          authMode,
          user: { id: user.id, username: user.username, email: user.email, role: user.role }
        }
      })
    } catch (error) {
      console.error('管理员初始化失败:', error.message)
      res.status(500).json({ success: false, message: '管理员初始化失败' })
    } finally {
      setupInProgress = false
    }
  })

  router.get('/captcha', (req, res) => {
    const captcha = captchaFactory({ jwtSecret })
    res.json({
      success: true,
      data: {
        captchaToken: captcha.captchaToken,
        captchaImage: captcha.captchaImage,
        expiresIn: captcha.expiresIn
      }
    })
  })

  router.post('/register', async (req, res) => {
    if (!publicRegistrationEnabled) {
      return res.status(403).json({ success: false, message: '公开注册已关闭，请使用系统管理员账号登录' })
    }
    try {
      const { username, password, email } = req.body
      if (!username || !password) {
        return res.status(400).json({
          success: false,
          message: '用户名和密码不能为空'
        })
      }

      const existingUser = await UserStore.findOne({ where: { username } })
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: '用户名已存在'
        })
      }

      if (email) {
        const existingEmail = await UserStore.findOne({ where: { email } })
        if (existingEmail) {
          return res.status(400).json({
            success: false,
            message: '邮箱已被注册'
          })
        }
      }

      const hashedPassword = await bcrypt.hash(password, 10)
      const user = await UserStore.create({
        username,
        password: hashedPassword,
        email: email || null,
        role: 'agent'
      })

      const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role },
        jwtSecret,
        { expiresIn: jwtExpire, algorithm: jwtAlgorithms[0], issuer: jwtIssuer, audience: jwtAudience }
      )

      res.json({
        success: true,
        message: '注册成功',
        data: {
          token,
          authMode,
          user: {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role
          }
        }
      })
    } catch (error) {
      console.error('注册失败:', error.message)
      res.status(500).json({
        success: false,
        message: '注册失败: ' + error.message
      })
    }
  })

  router.post('/login', async (req, res) => {
    try {
      const { username, password, captchaToken, captchaCode } = req.body

      if (!username || !password) {
        return res.status(400).json({
          success: false,
          message: '用户名和密码不能为空'
        })
      }

      if (captchaEnabled) {
        verifyCaptchaSubmission({ captchaToken, captchaCode, jwtSecret })
      }

      const user = await UserStore.findOne({ where: { username } })
      if (!user) {
        return res.status(400).json({
          success: false,
          message: '账号或密码错误'
        })
      }

      if (user.status !== 'active') {
        return res.status(400).json({
          success: false,
          message: '账号已被禁用'
        })
      }

      const isMatch = await bcrypt.compare(password, user.password)
      if (!isMatch) {
        return res.status(400).json({
          success: false,
          message: '账号或密码错误'
        })
      }

      const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role },
        jwtSecret,
        { expiresIn: jwtExpire, algorithm: jwtAlgorithms[0], issuer: jwtIssuer, audience: jwtAudience }
      )

      res.json({
        success: true,
        message: '登录成功',
        data: {
          token,
          authMode,
          user: {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role
          }
        }
      })
    } catch (error) {
      console.error('登录失败:', error.message)
      if (error.status) {
        return res.status(error.status).json({
          success: false,
          message: error.message
        })
      }
      if (error.name === 'JsonWebTokenError') {
        return res.status(400).json({
          success: false,
          message: '验证码已失效，请刷新后重试'
        })
      }
      if (error.name === 'TokenExpiredError') {
        return res.status(400).json({
          success: false,
          message: '验证码已过期，请刷新后重试'
        })
      }
      res.status(500).json({
        success: false,
        message: '登录失败: ' + error.message
      })
    }
  })

  router.get('/me', async (req, res) => {
    try {
      const token = req.headers.authorization?.replace('Bearer ', '')
      if (!token) {
        return res.status(401).json({
          success: false,
          message: '未提供认证令牌'
        })
      }

      const decoded = jwt.verify(token, jwtSecret, {
        algorithms: jwtAlgorithms,
        issuer: jwtIssuer,
        audience: jwtAudience
      })
      const user = await UserStore.findByPk(decoded.id, {
        attributes: ['id', 'username', 'email', 'role', 'status', 'createdAt']
      })

      if (!user) {
        return res.status(404).json({
          success: false,
          message: '用户不存在'
        })
      }
      if (user.status !== 'active') {
        return res.status(401).json({ success: false, message: '账号不可用' })
      }

      res.json({
        success: true,
        data: user
      })
    } catch (error) {
      if (error.name === 'JsonWebTokenError') {
        return res.status(401).json({
          success: false,
          message: '无效的认证令牌'
        })
      }
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: '认证令牌已过期'
        })
      }
      res.status(500).json({
        success: false,
        message: '获取用户信息失败'
      })
    }
  })

  router.post('/change-password', async (req, res) => {
    try {
      const { oldPassword, newPassword } = req.body
      const token = req.headers.authorization?.replace('Bearer ', '')
      if (!token) {
        return res.status(401).json({
          success: false,
          message: '未提供认证令牌'
        })
      }

      const decoded = jwt.verify(token, jwtSecret, {
        algorithms: jwtAlgorithms,
        issuer: jwtIssuer,
        audience: jwtAudience
      })
      const user = await UserStore.findByPk(decoded.id)
      if (!user) {
        return res.status(404).json({
          success: false,
          message: '用户不存在'
        })
      }
      if (user.status !== 'active') {
        return res.status(401).json({ success: false, message: '账号不可用' })
      }

      const isMatch = await bcrypt.compare(oldPassword, user.password)
      if (!isMatch) {
        return res.status(400).json({
          success: false,
          message: '原密码错误'
        })
      }

      const hashedPassword = await bcrypt.hash(newPassword, 10)
      await user.update({ password: hashedPassword })

      res.json({
        success: true,
        message: '密码修改成功'
      })
    } catch (error) {
      console.error('修改密码失败:', error.message)
      if (error.name === 'JsonWebTokenError') {
        return res.status(401).json({
          success: false,
          message: '无效的认证令牌'
        })
      }
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: '认证令牌已过期'
        })
      }
      res.status(500).json({
        success: false,
        message: '修改密码失败'
      })
    }
  })

  return router
}

const authRouter = createAuthRouter()

module.exports = authRouter
module.exports.createCaptchaChallenge = createCaptchaChallenge
module.exports.createAuthRouter = createAuthRouter
module.exports.normalizeCaptchaCode = normalizeCaptchaCode
module.exports.verifyCaptchaSubmission = verifyCaptchaSubmission
module.exports.resolveCaptchaEnabled = resolveCaptchaEnabled
module.exports.resolvePublicRegistrationEnabled = resolvePublicRegistrationEnabled
module.exports.resolveAuthMode = resolveAuthMode
