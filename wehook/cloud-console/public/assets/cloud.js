(() => {
  'use strict'
  const surface = document.documentElement.dataset.surface
  const app = document.getElementById('app')
  const icons = {
    overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 4h6v6H4zM14 4h6v10h-6zM4 14h6v6H4zM14 18h6v2h-6z"/></svg>',
    wecom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 5h11v9H9l-4 3v-3H4z"/><path d="M11 9h9v8h-3v3l-4-3h-2"/></svg>',
    credits: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3v18M17 7.5c0-2-1.8-3-5-3s-5 1.2-5 3 1.5 2.7 5 3.5 5 1.7 5 3.7-1.8 3.3-5 3.3-5-1.2-5-3.5"/></svg>',
    device: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="4" y="3" width="16" height="13" rx="2"/><path d="M8 21h8M12 16v5"/></svg>'
  }
  const state = { data: null, user: null, page: 1 }

  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char])) }
  function number(value) { return new Intl.NumberFormat('zh-CN').format(Number(value || 0)) }
  function date(value) { return value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(new Date(value)) : '尚未连接' }
  function toast(message, tone = 'success') {
    const region = document.getElementById('toast-region')
    const item = document.createElement('div')
    item.className = `toast ${tone}`
    item.textContent = message
    region.replaceChildren(item)
    window.setTimeout(() => item.remove(), 3200)
  }
  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options })
    const body = await response.json().catch(() => ({ success: false, message: '服务器返回了无法识别的响应' }))
    if (response.status === 401 && path !== '/v1/auth/login') {
      if (path === '/v1/session') throw Object.assign(new Error('unauthorized'), { sessionMissing: true })
      renderLogin('登录已过期，请重新登录')
      throw Object.assign(new Error('unauthorized'), { handled: true })
    }
    if (!response.ok) throw Object.assign(new Error(body.message || '请求未能完成'), { code: body.code, status: response.status })
    return body.data
  }

  function renderLogin(message = '') {
    app.innerHTML = `<main class="login-shell">
      <section class="login-story" aria-labelledby="story-title">
        <div class="brand"><span class="brand-mark">LW</span><span>孤勇者云端</span></div>
        <div class="story-copy"><p class="eyebrow">${surface === 'admin' ? 'Operator control plane' : 'Customer account centre'}</p><h1 id="story-title">${surface === 'admin' ? '看清每一条连接。' : '额度与连接，一处掌握。'}</h1><p>${surface === 'admin' ? '管理客户租户、企业微信接入与 AI 额度账本。业务数据仍留在客户本地。' : '查看套餐余量、企业微信接入状态，并为本地客服端签发连接凭证。'}</p></div>
        <p class="privacy-note">云端只保存运行所需的租户、连接、额度和审计信息。聊天记录、客户资料、订单、PDF 与知识库保留在客户自己的电脑和百炼账户中。</p>
      </section>
      <section class="login-panel"><div class="login-card"><p class="eyebrow">安全登录</p><h2>${surface === 'admin' ? '运营后台' : '客户账户中心'}</h2><p>输入管理员账户继续。</p>
        <form id="login-form" class="form-stack" novalidate>
          <div id="login-error" class="form-error" ${message ? '' : 'hidden'}>${escapeHtml(message)}</div>
          <div class="form-field"><label for="username">用户名</label><input id="username" name="username" autocomplete="username" required aria-describedby="username-error"><span id="username-error" class="field-error"></span></div>
          <div class="form-field"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required aria-describedby="password-error"><span id="password-error" class="field-error"></span></div>
          <button class="btn btn-primary btn-wide" type="submit">登录</button>
        </form>
      </div></section></main>`
    document.getElementById('login-form').addEventListener('submit', login)
  }

  async function login(event) {
    event.preventDefault()
    const form = event.currentTarget
    const button = form.querySelector('button[type="submit"]')
    const username = form.username.value.trim()
    const password = form.password.value
    form.querySelectorAll('input').forEach(input => input.removeAttribute('aria-invalid'))
    form.querySelectorAll('.field-error').forEach(item => { item.textContent = '' })
    if (!username || !password) {
      const field = !username ? form.username : form.password
      field.setAttribute('aria-invalid', 'true')
      document.getElementById(`${field.id}-error`).textContent = '请填写此项'
      field.focus(); return
    }
    button.disabled = true; button.setAttribute('aria-busy', 'true')
    document.getElementById('login-error').hidden = true
    try {
      state.user = await api('/v1/auth/login', { method: 'POST', body: JSON.stringify({ username, password, surface }) })
      if (state.user.mustChangePassword) renderPasswordChange()
      else await loadDashboard()
    } catch (error) {
      const target = document.getElementById('login-error'); target.hidden = false; target.textContent = error.message
      form.password.value = ''; form.password.focus()
    } finally { button.disabled = false; button.removeAttribute('aria-busy') }
  }

  function renderPasswordChange() {
    app.innerHTML = `<main class="login-shell"><section class="login-story" aria-labelledby="change-story"><div class="brand"><span class="brand-mark">LW</span><span>孤勇者云端</span></div><div class="story-copy"><p class="eyebrow">First sign-in</p><h1 id="change-story">先把钥匙换掉。</h1><p>初始密码只用于第一次进入。修改完成后，旧密码会立即失效。</p></div><p class="privacy-note">新密码至少 12 个字符。建议使用一段容易记住但别人猜不到的长句，并保存在密码管理器中。</p></section><section class="login-panel"><div class="login-card"><p class="eyebrow">账户保护</p><h2>设置长期密码</h2><p>完成前不能进入运营功能。</p><form id="password-form" class="form-stack" novalidate><div class="form-error" data-form-error hidden></div><div class="form-field"><label for="currentPassword">当前密码</label><input id="currentPassword" name="currentPassword" type="password" autocomplete="current-password" required><span class="field-error"></span></div><div class="form-field"><label for="newPassword">新密码</label><input id="newPassword" name="newPassword" type="password" autocomplete="new-password" required aria-describedby="new-password-hint"><span id="new-password-hint" class="field-hint">至少 12 个字符</span><span class="field-error"></span></div><div class="form-field"><label for="confirmPassword">确认新密码</label><input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" required><span class="field-error"></span></div><button class="btn btn-primary btn-wide" type="submit">保存并进入后台</button></form></div></section></main>`
    const form = document.getElementById('password-form')
    form.addEventListener('submit', async event => {
      event.preventDefault()
      const body = values(form)
      const errorBox = form.querySelector('[data-form-error]')
      errorBox.hidden = true
      if (body.newPassword.length < 12 || body.newPassword !== body.confirmPassword) {
        errorBox.hidden = false
        errorBox.textContent = body.newPassword.length < 12 ? '新密码至少需要 12 个字符' : '两次输入的新密码不一致'
        form.newPassword.focus(); return
      }
      const button = form.querySelector('button[type="submit"]'); button.disabled = true; button.setAttribute('aria-busy', 'true')
      try { state.user = await api('/v1/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword: body.currentPassword, newPassword: body.newPassword }) }); toast('长期密码已设置'); await loadDashboard() }
      catch (error) { errorBox.hidden = false; errorBox.textContent = error.message }
      finally { button.disabled = false; button.removeAttribute('aria-busy') }
    })
  }

  function shell(content, active = 'overview') {
    const isAdmin = surface === 'admin'
    const nav = isAdmin
      ? [['overview', '总览', icons.overview], ['wecom', '企业微信', icons.wecom], ['credits', 'Token 套餐', icons.credits]]
      : [['overview', '账户总览', icons.overview], ['devices', '本地设备', icons.device], ['credits', '额度明细', icons.credits]]
    app.innerHTML = `<a class="skip-link" href="#main-content">跳到主要内容</a><div class="app-shell">
      <aside class="sidebar"><div class="brand"><span class="brand-mark">LW</span><span>孤勇者云端</span></div><nav class="sidebar-nav" aria-label="主导航">${nav.map(([id,label,icon]) => `<a href="#${id}" class="nav-button" data-section="${id}" ${id === active ? 'aria-current="page"' : ''}>${icon}<span>${label}</span></a>`).join('')}</nav><div class="sidebar-footer"><span class="status">控制平面正常</span><p>客户业务数据不进入云端</p></div></aside>
      <div class="main"><header class="topbar"><div class="page-title"><h1>${isAdmin ? '运营控制台' : escapeHtml(state.data?.tenant?.name || '账户中心')}</h1><span>${isAdmin ? 'CONTROL / 01' : 'ACCOUNT / 01'}</span></div><div class="user-actions"><span class="user-chip">${escapeHtml(state.user?.username || '')}</span><form id="logout-form"><button type="submit" class="btn btn-ghost">退出</button></form></div></header><main id="main-content" class="content">${content}</main></div>
    </div>`
    document.getElementById('logout-form').addEventListener('submit', event => { event.preventDefault(); logout() })
    document.querySelectorAll('[data-section]').forEach(button => button.addEventListener('click', event => { event.preventDefault(); renderSection(button.dataset.section) }))
  }

  function table(rows, columns, emptyText) {
    const pageSize = 20
    const pages = Math.max(1, Math.ceil(rows.length / pageSize))
    state.page = Math.min(state.page, pages)
    const start = (state.page - 1) * pageSize
    const visible = rows.slice(start, start + pageSize)
    if (!rows.length) return `<div class="empty-state"><div><strong>${escapeHtml(emptyText)}</strong><p>新记录出现后会自动显示在这里。</p></div></div>`
    return `<div class="table-region" tabindex="0" aria-label="数据表格，可横向滚动"><table class="data-table"><thead><tr>${columns.map(item => `<th scope="col">${item.label}</th>`).join('')}</tr></thead><tbody>${visible.map(row => `<tr>${columns.map(item => `<td>${item.render(row)}</td>`).join('')}</tr>`).join('')}</tbody></table></div><div class="table-foot"><span>显示 ${start + 1}–${Math.min(start + pageSize, rows.length)}，共 ${rows.length} 条</span><div class="action-row"><button class="btn btn-ghost page-prev" ${state.page === 1 ? 'disabled' : ''}>上一页</button><button class="btn btn-ghost page-next" ${state.page === pages ? 'disabled' : ''}>下一页</button></div></div>`
  }

  function bindPager(section) {
    document.querySelector('.page-prev')?.addEventListener('click', () => { state.page -= 1; renderSection(section) })
    document.querySelector('.page-next')?.addEventListener('click', () => { state.page += 1; renderSection(section) })
  }

  function renderSection(section) {
    state.page = 1
    if (surface === 'admin') renderAdmin(section)
    else renderAccount(section)
  }

  function renderAdmin(section = 'overview') {
    const data = state.data
    if (section === 'overview') {
      shell(`<section class="section-head"><div><p class="eyebrow">运行态势</p><h2>今天的控制平面</h2><p>这里只汇总连接与计量，不接触客户客服业务内容。</p></div><div class="action-row"><button class="btn btn-secondary" data-action="tenant">新增客户</button><button class="btn btn-primary" data-action="grant">人工加额</button></div></section>
        <section class="metric-grid" aria-label="关键指标"><article class="metric"><span class="metric-label">客户租户</span><strong class="metric-value">${number(data.totals.tenants)}</strong><span class="metric-foot">独立身份与数据边界</span></article><article class="metric"><span class="metric-label">可用额度总计</span><strong class="metric-value">${number(data.totals.credits)}</strong><span class="metric-foot">整数 credits，非人民币</span></article><article class="metric"><span class="metric-label">企业微信安装</span><strong class="metric-value">${number(data.totals.installations)}</strong><span class="metric-foot">按 CorpID 归属租户</span></article><article class="metric"><span class="metric-label">本地设备</span><strong class="metric-value">${number(data.totals.devices)}</strong><span class="metric-foot">独立凭证，可撤销</span></article></section>
        <div class="dashboard-grid"><section class="panel"><div class="panel-head"><h3>最近租户</h3><span>最多显示 20 条</span></div>${table(data.tenants, tenantColumns(), '还没有客户租户')}</section><aside class="panel"><div class="panel-head"><h3>消息链路</h3><span>边界检查</span></div><div class="panel-body"><div class="signal-rail"><div class="signal-node"><i class="node-dot"></i><div class="node-copy"><strong>企业微信</strong><span>公网回调、验签与解密</span></div><span class="node-state">入口</span></div><div class="signal-node"><i class="node-dot"></i><div class="node-copy"><strong>云端网关</strong><span>租户隔离、缓存、重试与计量</span></div><span class="node-state">在线</span></div><div class="signal-node"><i class="node-dot pending"></i><div class="node-copy"><strong>客户本地</strong><span>会话、PDF、知识库与 AI 决策</span></div><span class="node-state">按设备</span></div></div></div></aside></div>`, section)
      bindPager(section); bindAdminActions(); return
    }
    if (section === 'wecom') {
      shell(`<section class="section-head"><div><p class="eyebrow">模块 01</p><h2>企业微信接入</h2><p>每个 CorpID 只归属于一个租户；敏感凭据不会显示在浏览器中。</p></div><button class="btn btn-primary" data-action="wecom">登记企业</button></section><section class="panel"><div class="panel-head"><h3>安装记录</h3><span>${data.installations.length} 条</span></div>${table(data.installations, wecomColumns(), '还没有企业微信安装')}</section>`, section)
      bindPager(section); bindAdminActions(); return
    }
    shell(`<section class="section-head"><div><p class="eyebrow">模块 02</p><h2>Token 套餐与额度</h2><p>当前阶段采用人工加额与追加式账本；正式支付接入前不把额度等同于人民币。</p></div><button class="btn btn-primary" data-action="grant">人工加额</button></section><section class="panel"><div class="panel-head"><h3>额度流水</h3><span>只追加，不删除</span></div>${table(data.ledger, ledgerColumns(), '还没有额度流水')}</section>`, section)
    bindPager(section); bindAdminActions()
  }

  function tenantColumns() { return [
    { label: '客户', render: row => `<strong>${escapeHtml(row.name)}</strong><br><span class="mono">${escapeHtml(row.slug)}</span>` },
    { label: '状态', render: row => `<span class="status">${row.status === 'active' ? '启用' : escapeHtml(row.status)}</span>` },
    { label: '可用额度', render: row => `<span class="mono">${number(row.balance)}</span>` },
    { label: '企微 / 设备', render: row => `${number(row.wecom)} / ${number(row.devices)}` },
    { label: '创建时间', render: row => date(row.createdAt) }
  ] }
  function wecomColumns() { return [
    { label: '企业', render: row => `<strong>${escapeHtml(row.companyName || '未命名企业')}</strong>` },
    { label: 'CorpID', render: row => `<span class="mono">${escapeHtml(row.corpId)}</span>` },
    { label: '回调标识', render: row => `<span class="mono">${escapeHtml(row.callbackKey)}</span>` },
    { label: '状态', render: row => `<span class="status pending">${row.status === 'pending_callback' ? '待配置回调' : escapeHtml(row.status)}</span>` },
    { label: '更新时间', render: row => date(row.updatedAt) }
  ] }
  function ledgerColumns() { return [
    { label: '类型', render: row => escapeHtml(({ manual_grant: '人工加额', reservation: '模型预留', settlement_adjustment: '结算调整', reservation_release: '取消返还' })[row.kind] || row.kind) },
    { label: '变化', render: row => `<strong class="mono">${row.delta > 0 ? '+' : ''}${number(row.delta)}</strong>` },
    { label: '原因', render: row => escapeHtml(row.reason || '模型调用计量') },
    { label: '时间', render: row => date(row.createdAt) }
  ] }

  function renderAccount(section = 'overview') {
    const data = state.data
    if (section === 'overview') {
      shell(`<section class="balance-hero"><div><p class="eyebrow">当前可用额度</p><div class="balance-value">${number(data.balance)}</div><div class="balance-unit">CREDITS · 模型调用前预留，完成后按实际用量结算</div></div><button class="btn btn-secondary" data-contact>联系服务商购买额度</button></section><div class="privacy-banner"><strong>数据边界：</strong>PDF 会由你的本地程序直接上传到你自己的百炼知识库；聊天、客户和订单数据不会通过这里中转。只有使用服务商模型额度时，本地程序才向 API 网关发起计量请求。</div><div class="dashboard-grid"><section class="panel"><div class="panel-head"><h3>接入概况</h3><span>${escapeHtml(data.tenant.slug)}</span></div><div class="panel-body"><div class="signal-rail"><div class="signal-node"><i class="node-dot"></i><div class="node-copy"><strong>账户与套餐</strong><span>${escapeHtml(data.plan?.name || '未分配套餐')} · ${escapeHtml(data.subscription?.status || '未启用')}</span></div><span class="node-state">正常</span></div><div class="signal-node"><i class="node-dot ${data.installations.length ? 'pending' : 'pending'}"></i><div class="node-copy"><strong>企业微信</strong><span>${data.installations.length ? `${data.installations.length} 个企业已登记` : '等待服务商登记企业安装'}</span></div><span class="node-state">${data.installations.length ? '待联调' : '待配置'}</span></div><div class="signal-node"><i class="node-dot ${data.devices.length ? '' : 'pending'}"></i><div class="node-copy"><strong>本地客服端</strong><span>${data.devices.length ? `${data.devices.length} 个设备凭证` : '尚未签发设备凭证'}</span></div><span class="node-state">${data.devices.length ? '已签发' : '待配置'}</span></div></div></div></section><aside class="panel"><div class="panel-head"><h3>下一步</h3><span>上线清单</span></div><div class="panel-body"><p class="field-hint">1. 签发本地设备凭证<br>2. 在本地程序中配置 API 网关<br>3. 完成企业微信回调验证<br>4. 用测试额度完成一次模型调用</p></div></aside></div>`, section)
      document.querySelector('[data-contact]').addEventListener('click', () => toast('购买入口将在支付规则确认后开放', 'error')); return
    }
    if (section === 'devices') {
      shell(`<section class="section-head"><div><p class="eyebrow">本地连接</p><h2>设备凭证</h2><p>每台客户电脑使用独立凭证；密钥只在签发时显示一次。</p></div><button class="btn btn-primary" data-action="device">签发设备</button></section><section class="panel"><div class="panel-head"><h3>已签发设备</h3><span>${data.devices.length} 台</span></div>${table(data.devices, deviceColumns(), '还没有本地设备')}</section>`, section)
      bindPager(section); document.querySelector('[data-action="device"]').addEventListener('click', openDevice); return
    }
    shell(`<section class="section-head"><div><p class="eyebrow">用量记录</p><h2>额度明细</h2><p>模型请求先预留、后结算；失败或取消会返还预留额度。</p></div></section><section class="panel"><div class="panel-head"><h3>最近流水</h3><span>最多 50 条</span></div>${table(data.ledger, ledgerColumns(), '还没有额度流水')}</section>`, section)
    bindPager(section)
  }
  function deviceColumns() { return [
    { label: '设备', render: row => `<strong>${escapeHtml(row.name)}</strong>` },
    { label: '凭证预览', render: row => `<span class="mono">${escapeHtml(row.tokenPreview)}</span>` },
    { label: '状态', render: row => `<span class="status ${row.status === 'active' ? '' : 'offline'}">${row.status === 'active' ? '已启用' : escapeHtml(row.status)}</span>` },
    { label: '最近连接', render: row => date(row.lastSeenAt) },
    { label: '签发时间', render: row => date(row.createdAt) }
  ] }

  function modal({ title, description, body, confirm = '保存', tone = 'primary', onSubmit }) {
    const root = document.getElementById('modal-root')
    const previous = document.activeElement
    root.innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-description"><div class="modal-head"><div><h2 id="modal-title">${escapeHtml(title)}</h2><p id="modal-description">${escapeHtml(description)}</p></div><button type="button" class="icon-button" data-close aria-label="关闭对话框">×</button></div><form id="modal-form" novalidate>${body}<div class="modal-actions"><button type="button" class="btn btn-secondary" data-close>取消</button><button type="submit" class="btn btn-${tone}">${escapeHtml(confirm)}</button></div></form></section></div>`
    const dialog = root.querySelector('.modal')
    const close = () => { root.replaceChildren(); previous?.focus?.() }
    root.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', close))
    root.querySelector('.modal-backdrop').addEventListener('mousedown', event => { if (event.target === event.currentTarget) close() })
    const keyHandler = event => {
      if (event.key === 'Escape') { document.removeEventListener('keydown', keyHandler); close() }
      if (event.key === 'Tab') {
        const focusable = [...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled)')]
        const first = focusable[0], last = focusable.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', keyHandler, { signal: AbortSignal.timeout(30 * 60 * 1000) })
    root.querySelector('input')?.focus()
    root.querySelector('#modal-form').addEventListener('submit', event => onSubmit(event, close))
  }

  function formBody(fields, extra = '') { return `<div class="modal-body"><div class="form-stack"><div class="form-error" data-form-error hidden></div>${fields.map(field => `<div class="form-field"><label for="${field.name}">${escapeHtml(field.label)}</label><input id="${field.name}" name="${field.name}" type="${field.type || 'text'}" autocomplete="${field.autocomplete || 'off'}" ${field.min ? `min="${field.min}"` : ''} required aria-describedby="${field.name}-hint ${field.name}-error"><span id="${field.name}-hint" class="field-hint">${escapeHtml(field.hint || '')}</span><span id="${field.name}-error" class="field-error"></span></div>`).join('')}${extra}</div></div>` }
  function values(form) { return Object.fromEntries(new FormData(form).entries()) }
  function validate(form) {
    const invalid = [...form.querySelectorAll('input[required]')].find(input => !input.value.trim())
    if (!invalid) return true
    invalid.setAttribute('aria-invalid', 'true'); document.getElementById(`${invalid.id}-error`).textContent = '请填写此项'; invalid.focus(); return false
  }
  async function submitModal(event, close, path, success, transform = value => value) {
    event.preventDefault(); const form = event.currentTarget
    form.querySelectorAll('input').forEach(input => input.removeAttribute('aria-invalid'))
    form.querySelectorAll('.field-error').forEach(item => { item.textContent = '' })
    if (!validate(form)) return
    const button = form.querySelector('button[type="submit"]'); button.disabled = true; button.setAttribute('aria-busy', 'true')
    try { await api(path, { method: 'POST', body: JSON.stringify(transform(values(form))) }); close(); toast(success); await loadDashboard() }
    catch (error) { const box = form.querySelector('[data-form-error]'); box.hidden = false; box.textContent = error.message }
    finally { button.disabled = false; button.removeAttribute('aria-busy') }
  }

  function bindAdminActions() {
    document.querySelectorAll('[data-action="tenant"]').forEach(button => button.addEventListener('click', () => modal({ title: '新增客户租户', description: '创建独立客户边界与账户中心登录。', body: formBody([{ name: 'name', label: '客户名称' }, { name: 'slug', label: '客户编号', hint: '仅小写英文、数字与连字符' }, { name: 'accountUsername', label: '账户中心用户名', autocomplete: 'username' }, { name: 'accountPassword', label: '初始密码', type: 'password', autocomplete: 'new-password', hint: '至少 12 个字符，请通过安全渠道交付客户' }]), onSubmit: (event, close) => submitModal(event, close, '/v1/admin/tenants', '客户租户已创建') })))
    document.querySelectorAll('[data-action="wecom"]').forEach(button => button.addEventListener('click', () => modal({ title: '登记企业微信安装', description: '登记租户归属；Token 与 EncodingAESKey 不在此页面录入。', body: formBody([{ name: 'tenantId', label: '租户 ID', hint: '从租户列表复制完整 ID' }, { name: 'companyName', label: '企业名称' }, { name: 'corpId', label: '企业 CorpID', hint: '通常以 ww 开头' }, { name: 'callbackKey', label: '回调标识', hint: '留空时由服务端生成' }]), onSubmit: (event, close) => submitModal(event, close, '/v1/admin/wecom/installations', '企业微信安装已登记') })))
    document.querySelectorAll('[data-action="grant"]').forEach(button => button.addEventListener('click', () => modal({ title: '人工加额', description: '该操作会写入不可删除的额度账本。', confirm: '确认加额', body: formBody([{ name: 'tenantId', label: '租户 ID' }, { name: 'credits', label: '增加额度', type: 'number', min: '1', hint: '整数 credits，不代表人民币金额' }, { name: 'reason', label: '原因', hint: '例如：测试额度、线下采购单号' }], '<div class="confirm-box">提交后将立即增加该租户的可用额度。若需纠正，应追加反向调整记录，不应删除历史。</div>'), onSubmit: (event, close) => submitModal(event, close, '/v1/admin/credits/grant', '额度已写入账本', value => ({ ...value, credits: Number(value.credits) })) })))
  }

  function openDevice() {
    modal({ title: '签发本地设备凭证', description: '凭证只显示一次，请立即保存到客户本地程序。', confirm: '签发凭证', body: formBody([{ name: 'name', label: '设备名称', hint: '例如：上海门店客服电脑' }]), onSubmit: async (event, close) => {
      event.preventDefault(); const form = event.currentTarget; if (!validate(form)) return
      const button = form.querySelector('button[type="submit"]'); button.disabled = true; button.setAttribute('aria-busy', 'true')
      try {
        const result = await api('/v1/account/devices', { method: 'POST', body: JSON.stringify(values(form)) })
        form.querySelector('.modal-body').insertAdjacentHTML('beforeend', `<div class="secret-once"><strong>只显示这一次</strong><code>${escapeHtml(result.token)}</code></div>`)
        button.textContent = '已签发'; button.disabled = true; toast('设备凭证已签发，请立即安全保存'); await refreshData()
      } catch (error) { const box = form.querySelector('[data-form-error]'); box.hidden = false; box.textContent = error.message; button.disabled = false }
      finally { button.removeAttribute('aria-busy') }
    } })
  }

  async function logout() { try { await api('/v1/auth/logout', { method: 'POST', body: '{}' }) } finally { state.user = null; state.data = null; renderLogin() } }
  async function refreshData() { state.data = await api(surface === 'admin' ? '/v1/admin/overview' : '/v1/account/overview') }
  async function loadDashboard() {
    app.innerHTML = '<div class="loading-state"><div><strong>正在读取控制平面</strong><div class="loading-line"></div></div></div>'
    try { await refreshData(); renderSection('overview') }
    catch (error) { if (!error.handled) app.innerHTML = `<div class="error-state"><div><strong>暂时无法读取数据</strong><p>${escapeHtml(error.message)}</p><button id="retry" class="btn btn-primary">重试</button></div></div>`, document.getElementById('retry')?.addEventListener('click', loadDashboard) }
  }
  async function boot() {
    try { state.user = await api('/v1/session'); if (state.user.mustChangePassword) renderPasswordChange(); else await loadDashboard() }
    catch (error) { if (!error.handled) renderLogin() }
  }
  boot()
})()
