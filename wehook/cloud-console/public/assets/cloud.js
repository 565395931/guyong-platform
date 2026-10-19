(() => {
  'use strict'
  const surface = document.documentElement.dataset.surface
  const app = document.getElementById('app')
  const icons = {
    overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 4h6v6H4zM14 4h6v10h-6zM4 14h6v6H4zM14 18h6v2h-6z"/></svg>',
    wecom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 5h11v9H9l-4 3v-3H4z"/><path d="M11 9h9v8h-3v3l-4-3h-2"/></svg>',
    credits: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3v18M17 7.5c0-2-1.8-3-5-3s-5 1.2-5 3 1.5 2.7 5 3.5 5 1.7 5 3.7-1.8 3.3-5 3.3-5-1.2-5-3.5"/></svg>',
    inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 5h16v12H8l-4 3z"/><path d="M8 9h8M8 13h5"/></svg>',
    ai: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9 3h6l1 3 3 1v6l-3 1-1 3H9l-1-3-3-1V7l3-1z"/><circle cx="12" cy="10" r="2"/><path d="M9 21h6"/></svg>',
    device: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="4" y="3" width="16" height="13" rx="2"/><path d="M8 21h8M12 16v5"/></svg>'
  }
  const state = {
    data: null,
    user: null,
    page: 1,
    tablePages: {},
    billingGeneration: 0,
    billingTenantId: null,
    inbox: null,
    modelConfig: null,
    shops: [],
    modalCleanup: null,
    replyRequests: new Map(),
    activeSection: '',
    inboxPollTimer: null,
    inboxPollGeneration: 0,
    inboxBusy: false
  }
  const INBOX_POLL_INTERVAL_MS = 3000

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
    state.modalCleanup?.()
    stopInboxPolling()
    state.activeSection = 'login'
    app.innerHTML = `<main class="login-shell">
      <section class="login-story" aria-labelledby="story-title">
        <div class="brand"><span class="brand-mark">LW</span><span>孤勇者云端</span></div>
        <div class="story-copy"><p class="eyebrow">${surface === 'admin' ? 'Operator control plane' : 'Customer account centre'}</p><h1 id="story-title">${surface === 'admin' ? '让每条消息都有去处。' : '额度与连接，一处掌握。'}</h1><p>${surface === 'admin' ? '统一处理企业微信消息、人工回复、AI 建议与模型额度。' : '查看模型余额、企业微信接入状态，并为本地客服端签发连接凭证。'}</p></div>
        <p class="privacy-note">客服消息会进入云端完成同步、人工处理或模型回复。密钥加密保存；客户资料、订单、PDF 与知识库仍可保留在客户自己的系统中。</p>
      </section>
      <section class="login-panel"><div class="login-card"><p class="eyebrow">安全登录</p><h2>${surface === 'admin' ? '运营后台' : '客户账户中心'}</h2><p>输入管理员账户继续。</p>
        <form id="login-form" class="form-stack" novalidate>
          <div id="login-error" class="form-error" ${message ? '' : 'hidden'}>${escapeHtml(message)}</div>
          <div class="form-field"><label for="username">用户名</label><input id="username" name="username" autocomplete="username" required aria-describedby="username-error"><span id="username-error" class="field-error"></span></div>
          <div class="form-field"><label for="password">密码</label><div class="secret-control"><input id="password" name="password" type="password" autocomplete="current-password" required aria-describedby="password-error"><button type="button" class="secret-toggle" data-action="secret-toggle" data-secret-toggle="password" aria-label="显示密码">显示</button></div><span id="password-error" class="field-error"></span></div>
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
    app.innerHTML = `<main class="login-shell"><section class="login-story" aria-labelledby="change-story"><div class="brand"><span class="brand-mark">LW</span><span>孤勇者云端</span></div><div class="story-copy"><p class="eyebrow">First sign-in</p><h1 id="change-story">先把钥匙换掉。</h1><p>初始密码只用于第一次进入。修改完成后，旧密码会立即失效。</p></div><p class="privacy-note">新密码至少 12 个字符。建议使用一段容易记住但别人猜不到的长句，并保存在密码管理器中。</p></section><section class="login-panel"><div class="login-card"><p class="eyebrow">账户保护</p><h2>设置长期密码</h2><p>完成前不能进入运营功能。</p><form id="password-form" class="form-stack" novalidate><div class="form-error" data-form-error hidden></div>${passwordField('currentPassword','当前密码','current-password')}${passwordField('newPassword','新密码','new-password','至少 12 个字符')}${passwordField('confirmPassword','确认新密码','new-password')}<button class="btn btn-primary btn-wide" type="submit">保存并进入后台</button></form></div></section></main>`
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
    state.activeSection = active
    const isAdmin = surface === 'admin'
    const nav = isAdmin
      ? [['overview', '总览', icons.overview], ['inbox', '消息工作台', icons.inbox], ['ai', '模型配置', icons.ai], ['wecom', '企业微信', icons.wecom], ['shops', '微信小店', icons.wecom], ['credits', '模型余额', icons.credits]]
      : [['overview', '账户总览', icons.overview], ['devices', '本地设备', icons.device], ['credits', '额度明细', icons.credits]]
    const titleMap = { overview: '总览', inbox: '消息工作台', ai: '模型配置', wecom: '企业微信', shops: '微信小店', credits: '模型余额', devices: '本地设备' }
    document.title = `${titleMap[active] || '运营后台'} · 孤勇者云端`
    app.innerHTML = `<a class="skip-link" href="#main-content">跳到主要内容</a><div class="app-shell">
      <aside class="sidebar"><div class="brand"><span class="brand-mark">LW</span><span>孤勇者云端</span></div><nav class="sidebar-nav" aria-label="主导航">${nav.map(([id,label,icon]) => `<a href="#${id}" class="nav-button" data-section="${id}" ${id === active ? 'aria-current="page"' : ''}>${icon}<span>${label}</span></a>`).join('')}</nav><div class="sidebar-footer"><span class="status">控制平面正常</span><p>客服消息按租户隔离处理</p></div></aside>
      <div class="main"><header class="topbar"><div class="page-title"><h1>${isAdmin ? '运营控制台' : escapeHtml(state.data?.tenant?.name || '账户中心')}</h1><span>${isAdmin ? 'CONTROL / 01' : 'ACCOUNT / 01'}</span></div><div class="user-actions"><span class="user-chip">${escapeHtml(state.user?.username || '')}</span><form id="logout-form"><button type="submit" class="btn btn-ghost">退出</button></form></div></header><main id="main-content" class="content ${active === 'inbox' ? 'content-workbench' : ''}">${content}</main></div>
    </div>`
    document.getElementById('logout-form').addEventListener('submit', event => { event.preventDefault(); logout() })
    document.querySelectorAll('[data-section]').forEach(button => button.addEventListener('click', event => { event.preventDefault(); renderSection(button.dataset.section) }))
  }

  function table(rows, columns, emptyText, tableKey = 'main') {
    const pageSize = 20
    const pages = Math.max(1, Math.ceil(rows.length / pageSize))
    const page = Math.min(tableKey === 'main' ? state.page : state.tablePages[tableKey] || 1, pages)
    if (tableKey === 'main') state.page = page; else state.tablePages[tableKey] = page
    const start = (page - 1) * pageSize
    const visible = rows.slice(start, start + pageSize)
    if (!rows.length) return `<div class="empty-state"><div><strong>${escapeHtml(emptyText)}</strong><p>新记录出现后会自动显示在这里。</p></div></div>`
    return `<div class="table-region" tabindex="0" aria-label="数据表格，可横向滚动"><table class="data-table"><thead><tr>${columns.map(item => `<th scope="col">${item.label}</th>`).join('')}</tr></thead><tbody>${visible.map(row => `<tr>${columns.map(item => `<td>${item.render(row)}</td>`).join('')}</tr>`).join('')}</tbody></table></div><div class="table-foot"><span>显示 ${start + 1}–${Math.min(start + pageSize, rows.length)}，共 ${rows.length} 条</span><div class="action-row"><button class="btn btn-ghost page-prev" data-table-key="${tableKey}" ${page === 1 ? 'disabled' : ''}>上一页</button><button class="btn btn-ghost page-next" data-table-key="${tableKey}" ${page === pages ? 'disabled' : ''}>下一页</button></div></div>`
  }

  function bindPager(section) {
    document.querySelectorAll('.page-prev,.page-next').forEach(button => button.addEventListener('click', () => {
      const delta = button.classList.contains('page-prev') ? -1 : 1, key = button.dataset.tableKey
      if (key === 'main') state.page += delta; else state.tablePages[key] = (state.tablePages[key] || 1) + delta
      renderSection(section, false)
    }))
  }

  async function renderSection(section, resetPage = true) {
    if (section !== 'inbox') stopInboxPolling()
    if (resetPage) { state.page = 1; state.tablePages = {} }
    if (surface === 'admin') await renderAdmin(section)
    else if (section === 'credits' || section === 'overview') await renderBilling(section)
    else renderAccount(section)
  }

  async function renderAdmin(section = 'overview') {
    const data = state.data
    if (section === 'credits') { await renderBilling(section); return }
    if (section === 'shops') { await renderShops(); return }
    if (section === 'overview') {
      shell(`<section class="section-head"><div><p class="eyebrow">运行态势</p><h2>今天的控制平面</h2><p>汇总企业接入、消息处理与模型额度；消息正文只用于客服处理。</p></div><div class="action-row"><button class="btn btn-secondary" data-action="tenant">新增客户</button><button class="btn btn-primary" data-action="grant">管理余额</button></div></section>
        <section class="metric-grid" aria-label="关键指标"><article class="metric"><span class="metric-label">客户租户</span><strong class="metric-value">${number(data.totals.tenants)}</strong><span class="metric-foot">独立身份与数据边界</span></article><article class="metric"><span class="metric-label">人民币余额总计</span><strong class="metric-value">${money(data.totals.money)}</strong><span class="metric-foot">人民币 · 按实际 Token 用量结算</span></article><article class="metric"><span class="metric-label">企业微信安装</span><strong class="metric-value">${number(data.totals.installations)}</strong><span class="metric-foot">按 CorpID 归属租户</span></article><article class="metric"><span class="metric-label">本地设备</span><strong class="metric-value">${number(data.totals.devices)}</strong><span class="metric-foot">独立凭证，可撤销</span></article></section>
        <div class="dashboard-grid"><section class="panel"><div class="panel-head"><h3>最近租户</h3><span>最多显示 20 条</span></div>${table(data.tenants, tenantColumns(), '还没有客户租户')}</section><aside class="panel"><div class="panel-head"><h3>消息链路</h3><span>实时路径</span></div><div class="panel-body"><div class="signal-rail"><div class="signal-node"><i class="node-dot"></i><div class="node-copy"><strong>企业微信</strong><span>公网回调、验签与消息同步</span></div><span class="node-state">入口</span></div><div class="signal-node"><i class="node-dot"></i><div class="node-copy"><strong>云端工作台</strong><span>人工回复、AI 建议与发送审计</span></div><span class="node-state">处理</span></div><div class="signal-node"><i class="node-dot pending"></i><div class="node-copy"><strong>客户系统</strong><span>订单、PDF 与知识库按租户连接</span></div><span class="node-state">按需</span></div></div></div></aside></div>`, section)
      bindPager(section); bindAdminActions(); return
    }
    if (section === 'ai') {
      state.modelConfig = await api('/v1/admin/ai/config')
      const config = state.modelConfig
      shell(`<section class="section-head"><div><p class="eyebrow">AI Gateway</p><h2>模型 API 配置</h2><p>兼容 OpenAI Chat Completions 接口。API Key 加密保存在服务器，浏览器不会读取原值。</p></div><span class="status ${config.lastTestStatus === 'passed' ? '' : 'pending'}">${config.lastTestStatus === 'passed' ? '连接已验证' : config.configured ? '等待测试' : '尚未配置'}</span></section>
        <form id="model-form" class="settings-layout" novalidate><section class="panel"><div class="panel-head"><h3>连接参数</h3><span>${config.apiKeyPreview ? `当前密钥 ${escapeHtml(config.apiKeyPreview)}` : '首次配置需填写密钥'}</span></div><div class="panel-body form-stack"><div class="form-error" data-form-error hidden></div>${settingsField('baseUrl','API Base URL',config.baseUrl)}${settingsField('apiKey','API Key','', 'secret')}${settingsField('model','模型名称',config.model)}
        <div class="form-grid">${settingsField('temperature','温度',config.temperature,'number','0','2','0.1')}${settingsField('maxTokens','最大输出 Token',config.maxTokens,'number','1','8192','1')}</div>
        <h3>图片理解路由</h3>${settingsField('visionModel','视觉模型名称',config.visionModel)}${settingsField('visionBaseUrl','视觉 Base URL（留空共用文本地址）',config.visionBaseUrl)}${settingsField('visionApiKey','视觉 API Key（留空共用文本密钥）','', 'secret')}
        <div class="form-field"><label for="systemPrompt">系统提示词</label><textarea id="systemPrompt" name="systemPrompt" rows="8">${escapeHtml(config.systemPrompt)}</textarea></div></div><div class="form-footer"><div class="action-row"><button type="button" class="btn btn-secondary" data-test-model>测试连接</button><button type="submit" class="btn btn-primary">保存并启用</button></div></div></section><aside class="panel guidance-panel"><div class="panel-head"><h3>调用规则</h3><span>模型路由</span></div><div class="panel-body"><p>上下文包含图片时，整次请求使用视觉模型；纯文本使用文本模型。两条路由可以配置成同一个模型。</p><p>本地只选择 customer-auto，源头模型更换不需要修改客户配置。</p></div></aside></form>`, section)
      bindModelForm(); return
    }
    if (section === 'inbox') {
      await renderInbox(); return
    }
    if (section === 'wecom') {
      const pendingCount = data.installations.filter(item => !item.tenantId).length
      shell(`<section class="section-head"><div><p class="eyebrow">模块 01</p><h2>企业微信接入</h2><p>让客户企业授权应用，再把授权企业归入对应客户账户。</p></div><div class="action-row"><button class="btn btn-secondary" data-action="install-link">生成测试安装链接</button><button class="btn btn-primary" data-action="wecom" ${pendingCount ? '' : 'disabled'}>绑定企业到客户${pendingCount ? `（${pendingCount}）` : ''}</button></div></section><div class="privacy-banner"><strong>CorpID 是什么？</strong> 它是企业微信为每家企业分配的唯一编号，授权后由系统自动获取。手工核对时，可在客户的企业微信管理后台进入“我的企业 → 企业信息”，查看“企业 ID”。</div><section class="panel"><div class="panel-head"><h3>安装记录</h3><span>${data.installations.length} 条</span></div>${table(data.installations, wecomColumns(), '还没有企业微信安装')}</section>`, section)
      bindPager(section); bindAdminActions(); return
    }
    shell(`<section class="section-head"><div><p class="eyebrow">模块 02</p><h2>模型余额与额度</h2><p>当前阶段采用人工加额与追加式账本；正式支付接入前不把额度等同于人民币。</p></div><button class="btn btn-primary" data-action="grant">管理余额</button></section><section class="panel"><div class="panel-head"><h3>额度流水</h3><span>只追加，不删除</span></div>${table(data.ledger, ledgerColumns(), '还没有额度流水')}</section>`, section)
    bindPager(section); bindAdminActions()
  }

  function settingsField(name, label, value, type = 'text', min = '', max = '', step = '') {
    const secret = type === 'secret'
    const inputType = secret ? 'text' : type
    const input = `<input id="${name}" name="${name}" type="${inputType}" aria-describedby="${name}-error" class="${secret ? 'api-secret-input is-masked' : ''}" value="${escapeHtml(value ?? '')}" ${min !== '' ? `min="${min}"` : ''} ${max !== '' ? `max="${max}"` : ''} ${step ? `step="${step}"` : ''} autocomplete="off" ${secret ? 'autocapitalize="none" spellcheck="false" data-lpignore="true" data-1p-ignore' : ''}>`
    return `<div class="form-field"><label for="${name}">${label}</label>${secret ? `<div class="secret-control">${input}<button type="button" class="secret-toggle" data-action="secret-toggle" data-secret-toggle="${name}" onclick="void 0" aria-label="显示 ${escapeHtml(label)}" aria-pressed="false">显示</button></div>` : input}<span id="${name}-error" class="field-error"></span></div>`
  }

  const money = value => `¥${(Number(value || 0) / 1e9).toFixed(6)}`
  async function renderBilling(section = 'credits') {
    const admin = surface === 'admin'
    const generation = ++state.billingGeneration
    shell('<section class="panel"><div class="panel-body" role="status">正在读取余额和账单…</div></section>', section)
    let data
    try {
      data = await api(`/v1/${admin ? 'admin' : 'account'}/billing`)
      if (generation !== state.billingGeneration || state.activeSection !== section) return
      if (admin && state.billingTenantId) {
        const selected = await api('/v1/admin/billing/calls?tenantId=' + encodeURIComponent(state.billingTenantId))
        data.calls = selected.calls
        data.selectedName = selected.tenantName
      }
    }
    catch (error) {
      if (error.handled || generation !== state.billingGeneration || state.activeSection !== section) return
      shell(`<section class="panel"><div class="panel-body" role="alert">${escapeHtml(error.message)} <button class="btn btn-secondary" data-billing-retry>重新读取</button></div></section>`, section)
      document.querySelector('[data-billing-retry]').addEventListener('click', () => renderBilling(section)); return
    }
    if (generation !== state.billingGeneration || state.activeSection !== section) return
    const columns = [
      ...(admin ? [{ label: '客户', render: r => escapeHtml(state.data.tenants.find(t => t.id === r.tenantId)?.name || '未知客户') }] : []),
      { label: '模型 / 状态', render: r => `${escapeHtml(admin ? r.upstreamModel : r.model)}<br>${escapeHtml(({ settled: '已结算', reserved: '处理中', failed: '已失败返还', failed_billed: '未生成文本，按供应商用量结算', pending_reconciliation: '待核账' })[r.status] || r.status)}` },
      { label: '输入 / 缓存 / 输出 Token', render: r => r.usage ? `${number(r.usage.input)} / ${number(r.usage.cached)} / ${number(r.usage.output)}` : '等待用量' },
      { label: '扣费', render: r => r.sale == null ? '未结算' : money(r.sale) },
      ...(admin ? [{ label: '成本', render: r => r.cost == null ? '待核账' : money(r.cost) }, { label: '毛利', render: r => r.profit == null ? '待核账' : money(r.profit) }] : []),
      { label: '时间', render: r => date(r.createdAt) }
    ]
    if (admin) columns.push({ label: '核账', render: r => ['pending_reconciliation','reserved'].includes(r.status) ? `<button class="btn btn-secondary" data-reconcile="${escapeHtml(r.id)}">核对账单</button>` : '已完成' })
    const pricing = data.pricing
    const rates = [{ name: '普通时段 · 文本', ...pricing.text }, { name: '工作日 09:00–12:00 · 文本 / 图片', ...pricing.peakMorning }, { name: '工作日 14:00–18:00 · 文本 / 图片', ...pricing.peakAfternoon }, { name: '普通时段 · 图片理解', ...(pricing.vision || {}) }]
    shell(`<section class="section-head"><div><p class="eyebrow">模型余额</p><h2>管理客户余额，按实际用量扣费</h2><p>直接调整人民币余额，本地每分钟同步；计费采用北京时间。</p></div>${admin ? '' : '<button class="btn btn-secondary" data-buy-package>联系管理员补充额度</button>'}</section>
      <section class="metric-grid"><article class="metric"><span class="metric-label">${admin ? '余额总计' : '可用余额'}</span><strong class="metric-value">${money(data.balance)}</strong></article><article class="metric"><span class="metric-label">已结算用量金额</span><strong class="metric-value">${money(data.totals.sale)}</strong></article>${admin ? `<article class="metric"><span class="metric-label">模型成本</span><strong class="metric-value">${money(data.totals.cost)}</strong></article><article class="metric"><span class="metric-label">毛利（扣费减成本）</span><strong class="metric-value">${money(data.totals.profit)}</strong></article>` : ''}</section>
      ${admin ? `<section class="panel"><div class="panel-head"><h3>客户余额</h3></div>${table(data.customers, [{ label: '客户', render: r => escapeHtml(r.name) }, { label: '可用余额', render: r => money(r.balance) }, { label: '已扣费', render: r => money(r.sale) }, { label: '成本', render: r => money(r.cost) }, { label: '毛利', render: r => money(r.profit) }, { label: '操作', render: r => '<button class="btn btn-secondary" data-view-billing="' + escapeHtml(r.id) + '">查看账单</button> <button class="btn btn-secondary" data-set-balance="' + escapeHtml(r.id) + '">调整余额</button> <button class="btn btn-secondary" data-model-key="' + escapeHtml(r.id) + '">生成模型 Key</button>' }], '还没有客户', 'billing-customers')}</section>` : ''}
      <section class="panel"><div class="panel-head"><h3>售价 · 元／百万 Token</h3>${admin ? '<button class="btn btn-secondary" data-edit-pricing>修改单价</button>' : ''}</div>${table(rates, [{ label: '时段 / 类型', render: r => escapeHtml(r.name) }, { label: '输入未缓存', render: r => r.input == null ? '待配置' : number(r.input) }, { label: '缓存命中', render: r => r.cached == null ? '待配置' : number(r.cached) }, { label: '输出', render: r => r.output == null ? '待配置' : number(r.output) }], '未配置价格', 'billing-prices')}</section>
      <section class="panel"><div class="panel-head"><h3>余额调整记录</h3></div>${table(data.entries.filter(r => ['balance_adjustment','test_package','package_purchase'].includes(r.kind)), [{ label: '客户', render: r => escapeHtml(state.data.tenants?.find(t => t.id === r.tenantId)?.name || '本账户') }, { label: '调整说明', render: r => escapeHtml(r.reference || (r.kind === 'test_package' ? '历史测试加额' : '历史充值')) }, { label: '调整金额', render: r => money(r.delta) }, { label: '调整后余额', render: r => r.target == null ? '—' : money(r.target) }, { label: '时间', render: r => date(r.createdAt) }], '还没有调整记录', 'billing-adjustments')}</section>
      <section class="panel" id="billing-call-panel"><div class="panel-head"><h3>模型调用账单${data.selectedName ? ' · ' + escapeHtml(data.selectedName) : ''}</h3><span>每个账号保留最近 300 条</span></div>${table(data.calls, columns, admin && !state.billingTenantId ? '请先点击客户的“查看账单”' : '该账号还没有模型调用', 'billing-calls')}</section>`, section)
    document.querySelectorAll('[data-view-billing]').forEach(button => button.addEventListener('click', async () => {
      state.billingTenantId = button.dataset.viewBilling
      state.tablePages['billing-calls'] = 1
      await renderBilling(section)
      document.getElementById('billing-call-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }))
    document.querySelector('[data-buy-package]')?.addEventListener('click', () => toast('请联系管理员补充大模型额度'))
    document.querySelectorAll('[data-reconcile]').forEach(button => button.addEventListener('click', () => {
      const callId = button.dataset.reconcile
      modal({ title: '核对供应商账单', description: '仅在供应商确认实际用量或未计费后处理。此操作会调整客户余额并保留审计。', confirm: '确认核账', body: `<div class="modal-body"><div class="form-stack"><div class="form-error" data-form-error hidden></div>${choiceField('resolution','核账结果',[{value:'settle',title:'按实际用量补结算',meta:'以供应商账单为准'},{value:'refund',title:'确认未计费，全部返还',meta:'不得用于已产生供应商费用的调用'}],'')}${formFields([{name:'reference',label:'供应商核账凭据编号'},{name:'input',label:'总输入 Token',type:'number',min:'0',value:0},{name:'cached',label:'缓存命中 Token',type:'number',min:'0',value:0},{name:'output',label:'输出 Token',type:'number',min:'0',value:0}])}</div></div>`, onSubmit: async (event, close) => { await submitModal(event,close,'/v1/admin/billing/reconcile','账单已核对', value => ({ callId, reference:value.reference, refund:value.resolution === 'refund', usage:{prompt_tokens:Number(value.input),completion_tokens:Number(value.output),prompt_tokens_details:{cached_tokens:Number(value.cached)}} })); if (!document.getElementById('modal-form')) await renderBilling(section) } })
    }))
    document.querySelectorAll('[data-model-key]').forEach(button => button.addEventListener('click', () => {
      const customer = data.customers.find(c => c.id === button.dataset.modelKey)
      modal({ title: '生成模型 Key', description: customer.name + ' · 调用费用从该客户余额扣除。Key 只显示一次。', confirm: '生成 Key', body: formBody([{ name: 'name', label: 'Key 名称', value: '本地模型服务' }]), onSubmit: async (event, close) => {
        event.preventDefault(); const form = event.currentTarget
        if (form.dataset.pending === 'true' || form.dataset.issued === 'true' || !validate(form)) return
        form.dataset.pending = 'true'; const submit = form.querySelector('[type="submit"]'); submit.disabled = true
        try {
          const result = await api('/v1/admin/model-keys', { method: 'POST', body: JSON.stringify({ tenantId: customer.id, name: values(form).name }) })
          form.dataset.issued = 'true'
          const box = document.createElement('div'); box.className = 'secret-once'
          const heading = document.createElement('strong'); heading.textContent = '请保存到客户本地的 AI 配置'
          const details = document.createElement('pre'); details.textContent = 'Base URL: ' + result.baseUrl + '\n模型: ' + result.model + '\nAPI Key: ' + result.key
          const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'btn btn-secondary'; copy.textContent = '复制 API Key'
          copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(result.key); toast('Key 已复制') } catch { toast('复制失败，请手动复制', 'error') } })
          box.append(heading, details, copy); form.querySelector('.modal-body').append(box)
          submit.textContent = '已生成'; toast('模型 Key 已生成')
        } catch (error) { const box = form.querySelector('[data-form-error]'); box.hidden = false; box.textContent = error.message; submit.disabled = false }
        finally { form.dataset.pending = 'false' }
      } })
    }))
    document.querySelectorAll('[data-set-balance]').forEach(button => button.addEventListener('click', () => {
      const customer = data.customers.find(c => c.id === button.dataset.setBalance), requestKey = crypto.randomUUID()
      modal({ title: '调整客户余额', description: customer.name + ' · 当前余额 ' + money(customer.balance), confirm: '保存余额', body: formBody([{ name: 'amountYuan', label: '调整后的余额（元）', type: 'number', min: '0', value: customer.balance / 1e9 }, { name: 'reference', label: '调整说明' }]), onSubmit: async (event, close) => {
        await submitModal(event, close, '/v1/admin/billing/balance', '余额已更新', value => ({ tenantId: customer.id, amountYuan: Number(value.amountYuan), expectedBalance: customer.balance, reference: value.reference, idempotencyKey: requestKey }))
        if (!document.getElementById('modal-form')) await renderBilling(section)
      } })
    }))
    document.querySelector('[data-edit-pricing]')?.addEventListener('click', () => {
      const fields = ['text', 'peakMorning', 'peakAfternoon', 'vision'].flatMap((band, i) => ['input','cached','output'].map(field => ({ name: `${band}_${field}`, label: `${rates[i].name} · ${{input:'输入未缓存',cached:'缓存命中',output:'输出'}[field]}`, type: 'number', min: '0', value: pricing[band]?.[field] ?? '' })))
      modal({ title: '配置模型单价', description: '新价格只作用于后续请求；文本成本固定六折，图片成本按原价。', confirm: '保存单价', body: formBody(fields), onSubmit: async (event, close) => {
        event.preventDefault(); const form = event.currentTarget
        if (form.dataset.pending === 'true' || !validate(form)) return
        form.dataset.pending = 'true'; const button = form.querySelector('[type="submit"]'); button.disabled = true
        try { const value = values(form), next = { ...pricing }; for (const band of ['text','peakMorning','peakAfternoon','vision']) next[band] = Object.fromEntries(['input','cached','output'].map(f => [f, Number(value[`${band}_${f}`])])); await api('/v1/admin/billing/pricing', { method:'PUT', body:JSON.stringify(next) }); form.dataset.pending = 'false'; close(); toast('单价已保存'); await renderBilling(section) }
        catch (error) { const box = form.querySelector('[data-form-error]'); box.hidden = false; box.textContent = error.message }
        finally { form.dataset.pending = 'false'; button.disabled = false }
      } })
    })
    bindPager(section)
  }

  function generateShopCallbackValues(randomSource = crypto) {
    const token = [...randomSource.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('')
    // Rejection sampling keeps a 32-byte AES key while respecting the shop form's alphanumeric alphabet.
    for (let attempt = 0; attempt < 128; attempt += 1) {
      const key = btoa(String.fromCharCode(...randomSource.getRandomValues(new Uint8Array(32)))).replace(/=+$/, '')
      if (/^[a-zA-Z0-9]{43}$/.test(key)) return { token, encodingAESKey: key }
    }
    throw new Error('暂时无法生成符合格式的消息密钥，请在小店页面随机生成后填入此处')
  }

  function shopCallbackUrl(id, origin = location.origin) {
    return new URL(`/v1/shop/callback/${id}`, origin).href
  }

  function shopModalField(name, label, value = '', readOnly = false) {
    return `<div class="form-field"><label for="${name}">${escapeHtml(label)}</label><div class="shop-copy-control"><input id="${name}" name="${name}" type="text" value="${escapeHtml(value)}" ${readOnly ? 'readonly' : ''} autocomplete="off" autocapitalize="none" spellcheck="false" data-lpignore="true" data-1p-ignore aria-describedby="${name}-error"><button type="button" class="btn btn-secondary" data-shop-copy="${name}" disabled aria-label="复制${escapeHtml(label)}">复制</button></div><span id="${name}-error" class="field-error"></span></div>`
  }

  async function renderShops() {
    shell('<section class="panel"><div class="panel-body" role="status">正在读取店铺…</div></section>', 'shops')
    let localClients = []
    try { [state.shops, localClients] = await Promise.all([api('/v1/admin/shops'), api('/v1/admin/local-clients')]) }
    catch (error) {
      if (error.handled) return
      shell(`<section class="panel"><div class="panel-body"><div class="form-error" role="alert">${escapeHtml(error.message)}</div><button class="btn btn-secondary" data-shop-retry>重新读取</button></div></section>`, 'shops')
      document.querySelector('[data-shop-retry]').addEventListener('click', renderShops); return
    }
    if (state.activeSection !== 'shops') return
    const columns = [
      { label: '店铺名称', render: row => `<strong>${escapeHtml(row.name)}</strong>` },
      { label: '小店 AppID', render: row => `<span class="mono">${escapeHtml(row.appId)}</span>` },
      { label: '所属客户', render: row => { const tenant = state.data.tenants.find(item => item.id === row.tenantId); return escapeHtml(tenant ? `${tenant.name} · ${tenant.slug}` : '客户不存在') } },
      { label: '回调状态', render: row => `<span class="status ${row.verifiedAt ? '' : 'pending'}">${row.verifiedAt ? '地址已验证' : '待验证'}</span>` },
      { label: '本地工作台', render: row => localClients.some(client => client.status === 'active' && client.bindings?.some(binding => binding.gatewayAccountId === row.id)) ? '<span class="status">本地接管 · 人工回复</span>' : '<span class="status pending">未连接</span>' },
      { label: '操作', render: row => { const owner = localClients.find(client => client.status === 'active' && client.bindings?.some(binding => binding.gatewayAccountId === row.id)); return `<div class="action-row"><button type="button" class="btn btn-secondary" data-shop-edit="${escapeHtml(row.id)}">配置店铺</button><button type="button" class="btn btn-secondary" data-shop-test="${escapeHtml(row.id)}">测试接口连接</button><button type="button" class="btn btn-secondary" data-local-pair="${escapeHtml(row.id)}">连接本地工作台</button><button type="button" class="btn btn-secondary" data-local-revoke="${escapeHtml(owner?.id || '')}" data-tenant="${escapeHtml(row.tenantId)}" ${owner ? '' : 'disabled'}>断开连接</button><button type="button" class="btn btn-danger-outline" data-shop-delete="${escapeHtml(row.id)}">删除店铺</button></div>` } }
    ]
    shell(`<section class="section-head"><h2>已登记店铺</h2><button type="button" class="btn btn-primary" data-shop-new>新增店铺</button></section><section class="panel"><div class="panel-head"><h3>店铺列表</h3><span>${number(state.shops.length)} 家</span></div>${table(state.shops, columns, '尚未登记店铺')}</section>`, 'shops')
    document.querySelector('.page-prev')?.addEventListener('click', () => { state.page -= 1; renderShops() })
    document.querySelector('.page-next')?.addEventListener('click', () => { state.page += 1; renderShops() })
    document.querySelector('[data-shop-new]').addEventListener('click', event => openShopModal(null, event.currentTarget))
    document.querySelectorAll('[data-shop-edit]').forEach(button => button.addEventListener('click', () => openShopModal(state.shops.find(row => row.id === button.dataset.shopEdit), button)))
    document.querySelectorAll('[data-local-pair]').forEach(button => button.addEventListener('click', () => {
      const shop = state.shops.find(row => row.id === button.dataset.localPair)
      let issuing = false
      const popup = modal({ title: '连接本地工作台', description: `仅授权「${shop.name}」给本地工作台，保持人工回复。配对码五分钟内有效，只能使用一次。`,
        body: '<div class="modal-body"><div class="form-stack"><div class="form-error" data-form-error role="alert" hidden></div><div data-pair-result role="status">生成后，在本地工作台的账号管理中点击“连接远端”，粘贴配对码。</div></div></div>',
        confirm: '生成配对码', canClose: () => !issuing, onSubmit: async event => {
          event.preventDefault(); if (issuing) return
          issuing = true; const submit = popup.form.querySelector('[type="submit"]'); submit.disabled = true; submit.setAttribute('aria-busy', 'true')
          try {
            const result = await api('/v1/admin/local-pairings', { method: 'POST', body: JSON.stringify({ tenantId: shop.tenantId, installationIds: [shop.id] }) })
            popup.form.querySelector('[data-pair-result]').innerHTML = `${shopModalField('local-pair-code', '一次性配对码', result.code, true)}<p>有效期至 ${escapeHtml(date(result.expiresAt))}，重新生成会让上一条未使用的配对码失效。</p>`
            const copy = popup.form.querySelector('[data-shop-copy]'); copy.disabled = false
            copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(result.code); toast('配对码已复制') } catch { toast('复制失败，请手动选中配对码复制', 'error') } })
            submit.textContent = '重新生成配对码'
          } catch (error) { const box = popup.form.querySelector('[data-form-error]'); box.hidden = false; box.textContent = error.message }
          finally { issuing = false; submit.disabled = false; submit.removeAttribute('aria-busy') }
        } })
    }))
    document.querySelectorAll('[data-local-revoke]:not(:disabled)').forEach(button => button.addEventListener('click', () => {
      const shop = state.shops.find(row => row.id === button.closest('tr').querySelector('[data-shop-edit]').dataset.shopEdit)
      modal({ title: '断开本地连接',
      description: `「${shop.name}」会停止向本地工作台同步。店铺账号和两端聊天记录不会删除，其他店铺连接不受影响。`,
      body: '<div class="modal-body"><div class="form-error" data-form-error hidden role="alert"></div></div>', confirm: '断开连接', tone: 'secondary',
      onSubmit: (event, close) => submitModal(event, close, `/v1/admin/shops/${shop.id}/disconnect`, '连接已断开', () => ({})) })
    }))
    document.querySelectorAll('[data-shop-delete]').forEach(button => button.addEventListener('click', () => {
      const shop = state.shops.find(row => row.id === button.dataset.shopDelete)
      let deleting = false
      const popup = modal({ title: '删除远端店铺资料', tone: 'danger', confirm: '删除店铺资料', canClose: () => !deleting,
        description: `将删除「${shop.name}」的登记、凭据、聊天、旧备注与投递记录，并解除该店铺的本地接管。不会删除其他店铺、客户账户或本机已有记录，也不会切换微信小店客服模式。`,
        body: formBody([{ name: 'confirmName', label: '输入完整店铺名称确认删除', hint: shop.name }], '<p>页面不提供撤销；服务器保留受保护的加密恢复备份。删除后原回调停止处理消息，请先确认微信小店不再使用该回调。</p>'),
        onSubmit: async event => {
          event.preventDefault(); if (deleting) return
          const form = popup.form, field = form.querySelector('[name="confirmName"]'), box = form.querySelector('[data-form-error]')
          box.hidden = true
          if (field.value !== shop.name) { field.setAttribute('aria-invalid', 'true'); document.getElementById('confirmName-error').textContent = '店铺名称不一致'; field.focus(); return }
          deleting = true; const submit = form.querySelector('[type="submit"]'); submit.disabled = true; submit.setAttribute('aria-busy', 'true')
          try {
            await api(`/v1/admin/shops/${shop.id}/delete`, { method: 'POST', body: JSON.stringify({ confirmName: field.value }) })
            deleting = false; popup.close(); toast('远端店铺资料已删除'); await renderShops()
          } catch (error) { if (!error.handled) { box.hidden = false; box.textContent = error.message } }
          finally { deleting = false; submit.disabled = false; submit.removeAttribute('aria-busy') }
        } })
      popup.dialog.querySelector('.modal-actions [data-close]')?.focus()
    }))
    document.querySelectorAll('[data-shop-test]').forEach(button => button.addEventListener('click', async () => {
      button.disabled = true; button.setAttribute('aria-busy', 'true')
      try { await api(`/v1/admin/shops/${button.dataset.shopTest}/test`, { method: 'POST', body: '{}' }); toast('接口连接成功') }
      catch (error) { if (!error.handled) toast(error.message, 'error') }
      finally { button.disabled = false; button.removeAttribute('aria-busy') }
    }))
  }

  async function openShopModal(selected, trigger) {
    if (!state.data.tenants.length) { toast('请先新增客户', 'error'); return }
    trigger.disabled = true; trigger.setAttribute('aria-busy', 'true')
    let draft
    try {
      draft = selected
        ? { id: selected.id, ...(await api(`/v1/admin/shops/${selected.id}/callback-config`, { method: 'POST', body: '{}' })) }
        : await api('/v1/admin/shops/drafts', { method: 'POST', body: '{}' })
    } catch (error) { if (!error.handled) toast(error.message, 'error'); return }
    finally { trigger.disabled = false; trigger.removeAttribute('aria-busy') }
    if (state.activeSection !== 'shops') return
    let pending = false, rotationConfirmed = ''
    const original = { token: draft.token, encodingAESKey: draft.encodingAESKey }
    const view = modal({
      title: selected ? `配置 ${selected.name}` : '新增店铺',
      description: '',
      variant: 'shop',
      leftAction: '重新生成新的回调',
      confirm: '保存小店配置',
      canClose: () => !pending,
      body: `<div class="modal-body"><div class="form-stack"><div class="form-error" data-form-error role="alert" hidden></div>${choiceField('tenantId', '所属客户', state.data.tenants.map(item => ({ value: item.id, title: item.name, meta: `客户编号：${item.slug}` })), '')}${shopModalField('name', '店铺名称', selected?.name || '')}${shopModalField('appId', '小店 AppID', selected?.appId || '', Boolean(selected))}${shopModalField('appSecret', '小店 AppSecret')}${shopModalField('shop-callback-url', '服务器地址', shopCallbackUrl(draft.id), true)}${shopModalField('token', 'Token令牌', draft.token, true)}${shopModalField('encodingAESKey', '消息密钥', draft.encodingAESKey, true)}</div></div>`,
      onSubmit: async (event, close) => {
        event.preventDefault()
        if (pending) return
        form.querySelectorAll('[aria-invalid]').forEach(item => item.removeAttribute('aria-invalid'))
        form.querySelectorAll('.field-error').forEach(item => { item.textContent = '' })
        if (!validate(form)) return
        const body = values(form); delete body['shop-callback-url']
        if (selected) {
          body.id = selected.id; body.tenantId = selected.tenantId
          const changed = body.token !== original.token || body.encodingAESKey !== original.encodingAESKey
          if (changed && rotationConfirmed !== JSON.stringify(body)) {
            rotationConfirmed = JSON.stringify(body)
            box.hidden = false; box.textContent = '将更新该店铺的回调密钥，旧参数将失效。请确认会同步到小店后台，再次点击保存以确认更新。'; return
          }
          if (!changed) { delete body.token; delete body.encodingAESKey }
        } else { body.callbackId = draft.id; body.draftRequired = true }
        setBusy(true); box.hidden = true
        try { await api('/v1/admin/shops', { method: 'POST', body: JSON.stringify(body) }); pending = false; close(); toast('小店配置已保存'); await renderShops() }
        catch (error) { if (!error.handled) { box.hidden = false; box.textContent = error.message } }
        finally { setBusy(false) }
      }
    })
    const form = view.form, box = form.querySelector('[data-form-error]')
    function setBusy(value) {
      pending = value
      view.dialog.setAttribute('aria-busy', String(value))
      view.dialog.querySelectorAll('button').forEach(button => { button.disabled = value })
    }
    form.querySelectorAll('input[name="tenantId"]').forEach(input => {
      if (selected) { input.checked = input.value === selected.tenantId; input.disabled = true }
    })
    for (const name of ['name', 'appId', ...(!selected ? ['appSecret'] : [])]) form.elements[name].required = true
    form.querySelectorAll('[data-shop-copy]').forEach(button => {
      button.disabled = false
      button.addEventListener('click', async () => {
        const input = form.querySelector(`#${CSS.escape(button.dataset.shopCopy)}`)
        if (!input.value) { toast('此项尚未填写', 'error'); return }
        try { await navigator.clipboard.writeText(input.value); toast('已复制') }
        catch { input.focus(); input.select(); toast('自动复制失败，请手动复制已选中的内容', 'error') }
      })
    })
    form.querySelector('[data-modal-left]').addEventListener('click', async () => {
      if (pending) return
      setBusy(true); box.hidden = true
      try {
        const generated = selected ? generateShopCallbackValues() : await api('/v1/admin/shops/drafts', { method: 'POST', body: JSON.stringify({ replaceId: draft.id }) })
        draft = { ...draft, ...generated }
        form.elements.token.value = draft.token
        form.elements.encodingAESKey.value = draft.encodingAESKey
        form.querySelector('#shop-callback-url').value = shopCallbackUrl(draft.id)
        rotationConfirmed = ''
      } catch (error) { if (!error.handled) { box.hidden = false; box.textContent = error.message } }
      finally { setBusy(false) }
    })
    form.querySelector('[data-modal-left]').disabled = false
  }

  function passwordField(name, label, autocomplete, hint = '') {
    return `<div class="form-field"><label for="${name}">${label}</label><div class="secret-control"><input id="${name}" name="${name}" type="password" autocomplete="${autocomplete}" required><button type="button" class="secret-toggle" data-action="secret-toggle" data-secret-toggle="${name}" onclick="void 0" aria-label="显示 ${label}">显示</button></div>${hint ? `<span class="field-hint">${hint}</span>` : ''}<span class="field-error"></span></div>`
  }

  function bindModelForm() {
    const form = document.getElementById('model-form')
    async function submit(testOnly) {
      const button = testOnly ? form.querySelector('[data-test-model]') : form.querySelector('button[type="submit"]')
      const body = values(form); body.temperature = Number(body.temperature); body.maxTokens = Number(body.maxTokens)
      button.disabled = true; button.setAttribute('aria-busy', 'true'); form.querySelector('[data-form-error]').hidden = true
      try {
        if (testOnly) { const result = await api('/v1/admin/ai/test', { method: 'POST', body: JSON.stringify(body) }); toast(`连接成功，耗时 ${result.latencyMs}ms`) }
        else { await api('/v1/admin/ai/config', { method: 'PUT', body: JSON.stringify(body) }); toast('模型配置已保存并启用') }
        await renderAdmin('ai')
      } catch (error) { const box = form.querySelector('[data-form-error]'); box.hidden = false; box.textContent = error.message }
      finally { button.disabled = false; button.removeAttribute('aria-busy') }
    }
    form.addEventListener('submit', event => { event.preventDefault(); submit(false) })
    form.querySelector('[data-test-model]').addEventListener('click', () => submit(true))
  }

  function stopInboxPolling() {
    if (state.inboxPollTimer) window.clearTimeout(state.inboxPollTimer)
    state.inboxPollTimer = null
    state.inboxPollGeneration += 1
  }

  function scheduleInboxPolling(generation) {
    if (generation !== state.inboxPollGeneration || state.activeSection !== 'inbox') return
    if (state.inboxPollTimer) window.clearTimeout(state.inboxPollTimer)
    state.inboxPollTimer = window.setTimeout(() => pollInbox(generation), INBOX_POLL_INTERVAL_MS)
  }

  function setInboxLiveStatus(text, offline = false) {
    const status = document.querySelector('[data-inbox-live-status]')
    if (!status) return
    status.textContent = text
    status.classList.toggle('offline', offline)
  }

  function inboxSignature(inbox) {
    return JSON.stringify(inbox)
  }

  async function pollInbox(generation) {
    state.inboxPollTimer = null
    if (generation !== state.inboxPollGeneration || state.activeSection !== 'inbox') return
    if (document.hidden || state.inboxBusy || state.modalCleanup) {
      scheduleInboxPolling(generation)
      return
    }
    const conversationId = state.inbox?.selected?.id || ''
    try {
      const inbox = await api(`/v1/admin/inbox${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ''}`)
      if (generation !== state.inboxPollGeneration || state.activeSection !== 'inbox') return
      if (inboxSignature(inbox) !== inboxSignature(state.inbox)) renderInboxView(inbox, { preserveUi: true })
      else setInboxLiveStatus('自动更新中')
    } catch (error) {
      if (!error.handled) setInboxLiveStatus('自动更新重试中', true)
    } finally {
      scheduleInboxPolling(generation)
    }
  }

  async function renderInbox(conversationId = '') {
    stopInboxPolling()
    const generation = state.inboxPollGeneration
    const inbox = await api(`/v1/admin/inbox${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ''}`)
    if (generation !== state.inboxPollGeneration) return
    renderInboxView(inbox)
    scheduleInboxPolling(generation)
  }

  function renderInboxView(inbox, { preserveUi = false } = {}) {
    const previousConversationId = state.inbox?.selected?.id || ''
    const previousStream = document.querySelector('.message-stream')
    const previousTextarea = document.getElementById('reply-text')
    const draftText = preserveUi ? previousTextarea?.value || '' : ''
    const restoreFocus = preserveUi && document.activeElement === previousTextarea
    const previousScrollTop = previousStream?.scrollTop || 0
    const wasNearBottom = !previousStream || previousStream.scrollHeight - previousStream.scrollTop - previousStream.clientHeight < 72
    state.inbox = inbox
    const list = inbox.conversations.length ? inbox.conversations.map(item => `<button class="conversation-item" data-conversation="${item.id}" ${item.id === inbox.selected?.id ? 'aria-current="true"' : ''}><span class="conversation-avatar" aria-hidden="true">${escapeHtml((item.customerName || '客').slice(0,1))}</span><span><strong>${escapeHtml(item.customerName)}</strong><small>${item.channel === 'wechat_shop' ? '微信小店' : '企业微信'} · ${escapeHtml(item.lastMessagePreview || '等待消息')}</small></span>${item.unreadCount ? `<b aria-label="${item.unreadCount} 条未读">${number(item.unreadCount)}</b>` : ''}</button>`).join('') : '<div class="empty-state compact"><div><strong>还没有客服消息</strong><p>完成通道接入并收到客户消息后，会话会显示在这里。</p></div></div>'
    const messages = inbox.messages.map(item => `<article class="message ${item.direction}"><span class="message-meta">${item.sender === 'customer' ? '客户' : item.sender === 'ai' ? 'AI 建议' : '人工客服'} · ${date(item.createdAt)}</span>${item.messageType === 'image' && item.mediaUrl ? `<figure class="message-image"><img src="${escapeHtml(item.mediaUrl)}" alt="客户发送的图片" loading="lazy"><figcaption>图片消息</figcaption></figure>` : `<p>${escapeHtml(item.text)}</p>`}${item.direction === 'draft' ? '<span class="draft-label">未发送</span>' : ''}</article>`).join('')
    shell(`<section class="section-head"><div><p class="eyebrow">WeCom Inbox</p><h2>消息工作台</h2><p>测试阶段采用“AI 建议 + 人工确认”；只有点击发送才会回复客户。</p></div><span class="status" data-inbox-live-status aria-live="polite">自动更新中</span></section><section class="inbox-shell"><aside class="conversation-list" aria-label="客服会话"><div class="conversation-list-head"><strong>全部会话</strong><span>${inbox.conversations.length}</span></div>${list}</aside><section class="chat-panel">${inbox.selected ? `<header class="chat-head"><div><strong>${escapeHtml(inbox.selected.customerName)}</strong><span class="mono">${escapeHtml(inbox.selected.externalUserId)}</span></div><span class="status">测试会话</span></header><div class="message-stream" aria-live="polite">${messages || '<div class="empty-state compact"><strong>会话中还没有消息</strong></div>'}</div><form id="reply-form" class="reply-composer" novalidate><div class="form-error" data-form-error hidden></div><label for="reply-text">回复内容</label><textarea id="reply-text" class="resize-none" name="text" rows="4" placeholder="输入人工回复，或先生成 AI 建议"></textarea><div class="composer-actions"><span class="field-hint">发送后不能撤回，请先确认企业和客户。</span><div class="action-row"><button type="button" class="btn btn-secondary" data-action="generate" data-generate onclick="void 0">生成 AI 建议</button><button type="submit" class="btn btn-primary">发送回复</button></div></div></form>` : '<div class="empty-state"><div><strong>选择一条会话开始处理</strong><p>完成企业微信授权后，消息会自动进入这里。</p></div></div>'}</section></section>`, 'inbox')
    document.querySelectorAll('[data-conversation]').forEach(button => button.addEventListener('click', () => renderInbox(button.dataset.conversation)))
    if (inbox.selected?.channel === 'wechat_shop') {
      const selected = inbox.selected
      const head = document.querySelector('.chat-head')
      head.querySelector('.status')?.remove()
      const actions = document.createElement('div'); actions.className = 'action-row customer-actions'
      actions.innerHTML = '<button type="button" class="btn btn-secondary" data-customer-orders>关联订单</button>'
      head.append(actions)
      actions.querySelector('[data-customer-orders]').addEventListener('click', () => viewCustomerOrders(selected))
    }
    document.querySelectorAll('.message-image img').forEach(image => image.addEventListener('error', () => {
      const figure = image.closest('.message-image')
      image.hidden = true
      figure.classList.add('failed')
      figure.querySelector('figcaption').textContent = '图片暂时无法加载，请刷新重试'
    }))
    const currentStream = document.querySelector('.message-stream')
    const sameConversation = previousConversationId === (inbox.selected?.id || '')
    if (inbox.selected) {
      bindReplyForm(inbox.selected.id)
      const textarea = document.getElementById('reply-text')
      if (preserveUi && sameConversation) textarea.value = draftText
      if (inbox.pendingReply) {
        state.replyRequests.set(inbox.selected.id, { text: inbox.pendingReply.text, requestId: inbox.pendingReply.requestId })
        if (!textarea.value) textarea.value = inbox.pendingReply.text
        const box = document.querySelector('#reply-form [data-form-error]')
        box.hidden = false; box.textContent = '上次发送结果未确认。保持内容不变重试，将复用同一任务编号；请勿另发一条相同回复。'
      }
      if (restoreFocus && sameConversation) textarea.focus({ preventScroll: true })
    }
    if (currentStream) {
      if (!preserveUi || !sameConversation || wasNearBottom) currentStream.scrollTop = currentStream.scrollHeight
      else currentStream.scrollTop = previousScrollTop
    }
  }

  function bindReplyForm(conversationId) {
    const form = document.getElementById('reply-form'); const textarea = form.elements.text
    form.querySelector('[data-generate]').addEventListener('click', async event => {
      const button = event.currentTarget; button.disabled = true; button.setAttribute('aria-busy','true')
      state.inboxBusy = true
      try { const draft = await api(`/v1/admin/inbox/${conversationId}/draft`, { method: 'POST', body: '{}' }); textarea.value = draft.text; toast('AI 建议已生成，请检查后再发送'); await renderInbox(conversationId); document.getElementById('reply-text').value = draft.text }
      catch (error) { const box = form.querySelector('[data-form-error]'); box.hidden = false; box.textContent = error.message }
      finally { state.inboxBusy = false; button.disabled = false; button.removeAttribute('aria-busy') }
    })
    form.addEventListener('submit', async event => {
      event.preventDefault(); const text = textarea.value.trim(); const box = form.querySelector('[data-form-error]')
      if (!text) { box.hidden = false; box.textContent = '请输入回复内容'; textarea.focus(); return }
      const button = form.querySelector('button[type="submit"]'); button.disabled = true; button.setAttribute('aria-busy','true'); box.hidden = true
      state.inboxBusy = true
      let request = state.replyRequests.get(conversationId)
      if (!request || request.text !== text) { request = { text, requestId: crypto.randomUUID() }; state.replyRequests.set(conversationId, request) }
      try { await api(`/v1/admin/inbox/${conversationId}/replies`, { method: 'POST', body: JSON.stringify(request) }); state.replyRequests.delete(conversationId); toast('回复已发送'); await renderInbox(conversationId) }
      catch (error) { if (error.code === 'shop_api_error') state.replyRequests.delete(conversationId); box.hidden = false; box.textContent = error.message }
      finally { state.inboxBusy = false; button.disabled = false; button.removeAttribute('aria-busy') }
    })
  }

  function viewCustomerOrders(conversation) {
    let pending = false; let cursor = null; let loaded = false; let orders = []
    const result = modal({ title: '关联订单', description: `${conversation.customerName} · 最近 7 天订单及最近发来的订单卡片`, confirm: '查询关联订单', canClose: () => !pending,
      body: '<div class="modal-body form-stack"><div class="form-error" data-form-error role="alert" hidden></div><p class="field-hint">只显示已核对当前客户身份的订单摘要，不读取地址或电话。</p><div data-order-results aria-live="polite">点击下方按钮查询；不会发送客服消息。</div></div>',
      onSubmit: async event => {
        event.preventDefault(); if (pending) return
        const form = event.currentTarget; const box = form.querySelector('[data-form-error]'); const button = form.querySelector('[type="submit"]')
        pending = true; button.disabled = true; button.setAttribute('aria-busy', 'true'); box.hidden = true
        try {
          const response = await api(`/v1/admin/inbox/${conversation.id}/orders`, { method: 'POST', body: JSON.stringify({ cursor: loaded ? cursor : null }) })
          if (!result.form.isConnected) return
          orders = [...new Map([...orders, ...response.orders].map(order => [order.orderId, order])).values()]; cursor = response.cursor; loaded = true
          const relationships = { buyer: '购买人', gift_recipient: '礼物收件人', gift_giver: '送礼人' }
          form.querySelector('[data-order-results]').innerHTML = orders.length ? orders.map(order => `<article class="customer-order"><strong class="mono">订单 ${escapeHtml(order.orderId)}</strong><p>${escapeHtml(relationships[order.relationship])} · 状态码 ${escapeHtml(order.status ?? '未知')} · ${date(order.createdAt)}</p><ul>${order.products.map(product => `<li>${escapeHtml(product.title || '商品')} × ${escapeHtml(product.quantity ?? '?')}${product.attributes.length ? ` · ${escapeHtml(product.attributes.map(attr => `${attr.name}：${attr.value}`).join('，'))}` : ''}</li>`).join('')}</ul><strong>${order.totalFen === null ? '金额未返回' : new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(order.totalFen / 100)}</strong>${order.orderUser ? `<p>订单昵称：${escapeHtml(order.orderUser.nickname)}（不是客服备注）</p>` : ''}</article>`).join('') : '<p>该范围内没有可确认关联的订单；无订单不代表客户身份丢失。</p>'
          if (response.unavailableCount || response.unrelatedCount) { box.hidden = false; box.textContent = `${response.unavailableCount} 条详情暂不可读取，${response.unrelatedCount} 条未确认归属；可重新查询。` }
          button.textContent = cursor ? '加载更多订单' : '重新查询订单'
          if (!cursor) { loaded = false; orders = [] }
        } catch (error) { if (!error.handled) { box.hidden = false; box.textContent = error.message; if (error.code === 'shop_order_invalid') { loaded = false; cursor = null; orders = []; button.textContent = '重新查询订单' } } }
        finally { pending = false; button.disabled = false; button.removeAttribute('aria-busy') }
      }
    })
    result.form.querySelector('[type="submit"]').focus()
  }

  function tenantColumns() { return [
    { label: '客户名称 / 客户编号', render: row => `<strong>${escapeHtml(row.name)}</strong><br><span class="mono">${escapeHtml(row.slug)}</span>` },
    { label: '状态', render: row => `<span class="status">${row.status === 'active' ? '启用' : escapeHtml(row.status)}</span>` },
    { label: '人民币余额', render: row => `<span class="mono">${money(row.moneyBalance)}</span>` },
    { label: '企微 / 设备', render: row => `${number(row.wecom)} / ${number(row.devices)}` },
    { label: '创建时间', render: row => date(row.createdAt) }
  ] }
  function wecomColumns() { return [
    { label: '企业', render: row => `<strong>${escapeHtml(row.companyName || '未命名企业')}</strong>` },
    { label: '企业 CorpID', render: row => `<span class="mono">${escapeHtml(row.corpId)}</span>` },
    { label: '绑定客户', render: row => { const tenant = state.data.tenants.find(item => item.id === row.tenantId); return tenant ? `<strong>${escapeHtml(tenant.name)}</strong><br><span class="mono">${escapeHtml(tenant.slug)}</span>` : '<span class="status pending">尚未绑定</span>' } },
    { label: '回调标识', render: row => `<span class="mono">${escapeHtml(row.callbackKey)}</span>` },
    { label: '状态', render: row => {
      const labels = {
        pending_callback: '待配置回调',
        pending_tenant_assignment: '待绑定客户',
        authorized: '已授权',
        active: '接收消息中'
      }
      return `<span class="status pending">${escapeHtml(labels[row.status] || row.status || '未知')}</span>`
    } },
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
      shell(`<section class="balance-hero"><div><p class="eyebrow">当前可用额度</p><div class="balance-value">${number(data.balance)}</div><div class="balance-unit">CREDITS · 模型调用前预留，完成后按实际用量结算</div></div><button class="btn btn-secondary" data-contact>联系服务商购买额度</button></section><div class="privacy-banner"><strong>数据边界：</strong>客服消息会经过服务商云端完成同步与模型回复，并按租户隔离；PDF、知识库、订单等业务数据仍可保留在客户自己的系统中。</div><div class="dashboard-grid"><section class="panel"><div class="panel-head"><h3>接入概况</h3><span>${escapeHtml(data.tenant.slug)}</span></div><div class="panel-body"><div class="signal-rail"><div class="signal-node"><i class="node-dot"></i><div class="node-copy"><strong>账户与套餐</strong><span>${escapeHtml(data.plan?.name || '未分配套餐')} · ${escapeHtml(data.subscription?.status || '未启用')}</span></div><span class="node-state">正常</span></div><div class="signal-node"><i class="node-dot ${data.installations.length ? 'pending' : 'pending'}"></i><div class="node-copy"><strong>企业微信</strong><span>${data.installations.length ? `${data.installations.length} 个企业已登记` : '等待服务商登记企业安装'}</span></div><span class="node-state">${data.installations.length ? '待联调' : '待配置'}</span></div><div class="signal-node"><i class="node-dot ${data.devices.length ? '' : 'pending'}"></i><div class="node-copy"><strong>本地客服端</strong><span>${data.devices.length ? `${data.devices.length} 个设备凭证` : '尚未签发设备凭证'}</span></div><span class="node-state">${data.devices.length ? '已签发' : '待配置'}</span></div></div></div></section><aside class="panel"><div class="panel-head"><h3>下一步</h3><span>上线清单</span></div><div class="panel-body"><p class="field-hint">1. 签发本地设备凭证<br>2. 在本地程序中配置 API 网关<br>3. 完成企业微信回调验证<br>4. 用测试额度完成一次模型调用</p></div></aside></div>`, section)
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

  function modal({ title, description, body, confirm = '保存', tone = 'primary', variant = '', leftAction = '', canClose = () => true, onSubmit }) {
    state.modalCleanup?.()
    const root = document.getElementById('modal-root')
    const previous = document.activeElement
    root.innerHTML = `<div class="modal-backdrop"><section class="modal ${variant === 'shop' ? 'shop-config-modal' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title" ${description ? 'aria-describedby="modal-description"' : ''}><div class="modal-head"><div><h2 id="modal-title">${escapeHtml(title)}</h2>${description ? `<p id="modal-description">${escapeHtml(description)}</p>` : ''}</div><button type="button" class="icon-button" data-close aria-label="关闭对话框">×</button></div><form id="modal-form" novalidate>${body}<div class="modal-actions"><button type="button" class="btn btn-secondary" ${leftAction ? 'data-modal-left disabled' : 'data-close'}>${escapeHtml(leftAction || '取消')}</button><button type="submit" class="btn btn-${tone}">${escapeHtml(confirm)}</button></div></form></section></div>`
    const dialog = root.querySelector('.modal')
    const controller = new AbortController()
    const previousOverflow = document.body.style.overflow
    app.inert = true; document.body.style.overflow = 'hidden'
    const cleanup = () => { controller.abort(); root.replaceChildren(); app.inert = false; document.body.style.overflow = previousOverflow; state.modalCleanup = null }
    state.modalCleanup = cleanup
    const close = () => { if (!canClose() || root.querySelector('#modal-form')?.dataset.pending === 'true') return; cleanup(); previous?.focus?.() }
    root.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', close))
    root.querySelector('.modal-backdrop').addEventListener('mousedown', event => { if (event.target === event.currentTarget) close() })
    const keyHandler = event => {
      if (event.key === 'Escape') close()
      if (event.key === 'Tab') {
        const focusable = [...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),a[href]')]
        const first = focusable[0], last = focusable.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', keyHandler, { signal: controller.signal })
    root.querySelector('input')?.focus()
    root.querySelector('#modal-form').addEventListener('submit', event => onSubmit(event, close))
    return { form: root.querySelector('#modal-form'), dialog, close }
  }

  function formFields(fields, extra = '') { return `${fields.map(field => { const input = `<input id="${field.name}" name="${field.name}" type="${field.type || 'text'}" ${field.type === 'number' ? 'step="any"' : ''} autocomplete="${field.autocomplete || 'off'}" ${field.min ? `min="${field.min}"` : ''} value="${escapeHtml(field.value ?? '')}" required aria-describedby="${field.name}-hint ${field.name}-error">`; return `<div class="form-field"><label for="${field.name}">${escapeHtml(field.label)}</label>${field.type === 'password' ? `<div class="secret-control">${input}<button type="button" class="secret-toggle" data-action="secret-toggle" data-secret-toggle="${field.name}" onclick="void 0" aria-label="显示 ${escapeHtml(field.label)}">显示</button></div>` : input}<span id="${field.name}-hint" class="field-hint">${escapeHtml(field.hint || '')}</span><span id="${field.name}-error" class="field-error"></span></div>` }).join('')}${extra}` }
  function formBody(fields, extra = '') { return `<div class="modal-body"><div class="form-stack"><div class="form-error" data-form-error hidden></div>${formFields(fields, extra)}</div></div>` }
  function choiceField(name, label, options, hint) {
    return `<fieldset class="choice-field" aria-describedby="${name}-hint ${name}-error"><legend>${escapeHtml(label)}</legend><span id="${name}-hint" class="field-hint">${escapeHtml(hint)}</span><div class="choice-list">${options.map(option => `<label class="choice-option"><input type="radio" name="${name}" value="${escapeHtml(option.value)}" required><span><strong>${escapeHtml(option.title)}</strong><small>${escapeHtml(option.meta)}</small></span></label>`).join('')}</div><span id="${name}-error" class="field-error"></span></fieldset>`
  }
  function values(form) { return Object.fromEntries(new FormData(form).entries()) }
  function validate(form) {
    const requiredRadios = [...new Set([...form.querySelectorAll('input[type="radio"][required]')].map(input => input.name))]
    const missingRadio = requiredRadios.find(name => !form.querySelector(`input[name="${CSS.escape(name)}"]:checked`))
    if (missingRadio) {
      const input = form.querySelector(`input[name="${CSS.escape(missingRadio)}"]`)
      const fieldset = input.closest('fieldset'); fieldset.setAttribute('aria-invalid', 'true')
      document.getElementById(`${missingRadio}-error`).textContent = '请选择一项'; input.focus(); return false
    }
    const invalid = [...form.querySelectorAll('input[required]:not([type="radio"])')].find(input => !input.value.trim())
    if (!invalid) return true
    invalid.setAttribute('aria-invalid', 'true'); document.getElementById(`${invalid.id}-error`).textContent = '请填写此项'; invalid.focus(); return false
  }
  async function submitModal(event, close, path, success, transform = value => value) {
    event.preventDefault(); const form = event.currentTarget
    if (form.dataset.pending === 'true') return
    form.querySelectorAll('input, fieldset').forEach(input => input.removeAttribute('aria-invalid'))
    form.querySelectorAll('.field-error').forEach(item => { item.textContent = '' })
    if (!validate(form)) return
    form.dataset.pending = 'true'
    const button = form.querySelector('button[type="submit"]'); button.disabled = true; button.setAttribute('aria-busy', 'true')
    try { await api(path, { method: 'POST', body: JSON.stringify(transform(values(form))) }); form.dataset.pending = 'false'; close(); toast(success); await loadDashboard() }
    catch (error) { const box = form.querySelector('[data-form-error]'); box.hidden = false; box.textContent = error.message }
    finally { form.dataset.pending = 'false'; button.disabled = false; button.removeAttribute('aria-busy') }
  }

  function bindAdminActions() {
    document.querySelectorAll('[data-action="tenant"]').forEach(button => button.addEventListener('click', () => modal({ title: '新增客户租户', description: '创建独立客户边界与账户中心登录。', body: formBody([{ name: 'name', label: '客户名称' }, { name: 'slug', label: '客户编号', hint: '仅小写英文、数字与连字符' }, { name: 'accountUsername', label: '账户中心用户名', autocomplete: 'username' }, { name: 'accountPassword', label: '初始密码', type: 'password', autocomplete: 'new-password', hint: '至少 12 个字符，请通过安全渠道交付客户' }]), onSubmit: (event, close) => submitModal(event, close, '/v1/admin/tenants', '客户租户已创建') })))
    document.querySelectorAll('[data-action="wecom"]').forEach(button => button.addEventListener('click', () => {
      const installations = state.data.installations.filter(item => !item.tenantId)
      if (!state.data.tenants.length) return toast('请先在总览中新增客户', 'error')
      if (!installations.length) return toast('当前没有待绑定的企业', 'error')
      modal({ title: '绑定企业微信到客户', description: '客户编号是新增客户时填写的编号；系统内部 ID 不需要手工复制。', confirm: '确认绑定', body: `<div class="modal-body"><div class="form-stack"><div class="form-error" data-form-error hidden></div>${choiceField('installationId', '授权企业', installations.map(item => ({ value: item.id, title: item.companyName || '未命名企业', meta: `CorpID：${item.corpId}` })), '选择刚完成授权的企业。')}${choiceField('tenantId', '所属客户', state.data.tenants.map(item => ({ value: item.id, title: item.name, meta: `客户编号：${item.slug}` })), '选择这家企业属于哪个客户账户。')}</div></div>`, onSubmit: (event, close) => submitModal(event, close, '/v1/admin/wecom/installations', '企业已绑定到客户', value => { const installation = installations.find(item => item.id === value.installationId); return { tenantId: value.tenantId, companyName: installation.companyName, corpId: installation.corpId, callbackKey: installation.callbackKey } }) })
    }))
    document.querySelectorAll('[data-action="grant"]').forEach(button => button.addEventListener('click', async () => { await renderBilling('credits'); document.querySelector('[data-set-balance]')?.click() }))
    document.querySelectorAll('[data-action="install-link"]').forEach(button => button.addEventListener('click', async () => {
      button.disabled = true; button.setAttribute('aria-busy', 'true')
      try { const result = await api('/v1/admin/wecom/install-url', { method: 'POST', body: '{}' }); window.open(result.url, '_blank', 'noopener,noreferrer'); toast('测试安装链接已生成') }
      catch (error) { toast(error.message, 'error') }
      finally { button.disabled = false; button.removeAttribute('aria-busy') }
    }))
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

  async function logout() { stopInboxPolling(); try { await api('/v1/auth/logout', { method: 'POST', body: '{}' }) } finally { state.user = null; state.data = null; state.inbox = null; state.shops = []; state.shopDraft = null; state.replyRequests.clear(); renderLogin() } }
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
  document.addEventListener('click', event => {
    const toggle = event.target.closest('[data-secret-toggle]')
    if (!toggle) return
    const input = document.getElementById(toggle.dataset.secretToggle)
    if (input.classList.contains('api-secret-input')) {
      const masked = input.classList.toggle('is-masked')
      toggle.textContent = masked ? '显示' : '隐藏'
      toggle.setAttribute('aria-label', `${masked ? '显示' : '隐藏'}${input.labels?.[0]?.textContent || '密钥'}`)
      toggle.setAttribute('aria-pressed', String(!masked))
      input.focus()
      return
    }
    const visible = input.type === 'text'
    input.type = visible ? 'password' : 'text'
    toggle.textContent = visible ? '显示' : '隐藏'
    toggle.setAttribute('aria-label', `${visible ? '显示' : '隐藏'}${input.labels?.[0]?.textContent || '密钥'}`)
    input.focus()
  })
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.activeSection === 'inbox' && !state.inboxPollTimer) scheduleInboxPolling(state.inboxPollGeneration)
  })
  boot()
})()
