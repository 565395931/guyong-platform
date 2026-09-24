import { ElNotification } from 'element-plus'

const STORAGE_KEY = 'platform_message_reminder_settings'
const DEFAULT_SETTINGS = {
  soundEnabled: true,
  soundTone: 'classic',
  desktopEnabled: false,
  toastEnabled: true
}

const NOTIFY_POOLS = new Set(['pending_human', 'public', 'private', 'long_term'])

export const SOUND_TONE_OPTIONS = [
  { value: 'classic', label: '经典叮咚' },
  { value: 'bright', label: '清脆双音' },
  { value: 'soft', label: '柔和提示' },
  { value: 'urgent', label: '急促三连' },
  { value: 'low', label: '低音提醒' }
]

const TONE_PRESETS = {
  classic: [
    { frequency: 880, duration: 0.16 },
    { frequency: 660, duration: 0.18 }
  ],
  bright: [
    { frequency: 1046, duration: 0.1 },
    { frequency: 1318, duration: 0.14 }
  ],
  soft: [
    { frequency: 523, duration: 0.18 },
    { frequency: 659, duration: 0.2 }
  ],
  urgent: [
    { frequency: 988, duration: 0.08 },
    { frequency: 988, duration: 0.08 },
    { frequency: 784, duration: 0.12 }
  ],
  low: [
    { frequency: 440, duration: 0.18 },
    { frequency: 330, duration: 0.2 }
  ]
}

const normalizeSoundTone = (tone) => (
  TONE_PRESETS[tone] ? tone : DEFAULT_SETTINGS.soundTone
)

const readSettings = () => {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

const writeSettings = (settings) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

class MessageReminder {
  constructor() {
    this.settings = readSettings()
    this.settings.soundTone = normalizeSoundTone(this.settings.soundTone)
    this.baseTitle = typeof document !== 'undefined' ? document.title : '聚合平台'
    this.unreadCount = 0
    this.titleTimer = null
    this.titleVisible = false
    this.audioContext = null
    this.audioElements = new Map()
    this.audioUnlocked = false
    this.initialized = false
    this.lastAudioBlockedNoticeAt = 0
    this.recentMessageIds = new Set()
  }

  init() {
    if (typeof window === 'undefined') return
    if (this.initialized) return
    this.initialized = true
    const unlock = () => this.unlockAudio()
    window.addEventListener('pointerdown', unlock, { passive: true })
    window.addEventListener('keydown', unlock)
    window.addEventListener('focus', () => this.stopTitleFlash())
  }

  getSettings() {
    return { ...this.settings }
  }

  updateSettings(nextSettings) {
    this.settings = {
      ...this.settings,
      ...nextSettings,
      soundTone: normalizeSoundTone(nextSettings.soundTone || this.settings.soundTone)
    }
    writeSettings(this.settings)
  }

  getDesktopPermission() {
    if (typeof window !== 'undefined' && !window.isSecureContext) return 'insecure'
    if (typeof Notification === 'undefined') return 'unsupported'
    return Notification.permission
  }

  async requestDesktopPermission() {
    if (typeof window !== 'undefined' && !window.isSecureContext) return 'insecure'
    if (typeof Notification === 'undefined') return 'unsupported'
    try {
      const permission = await Notification.requestPermission()
      if (permission === 'granted') {
        this.updateSettings({ desktopEnabled: true })
      }
      return permission
    } catch {
      return 'denied'
    }
  }

  shouldNotify(message, conversation) {
    if (!message || !conversation) return false
    if (message.direction && message.direction !== 'inbound') return false
    if (message.senderType && message.senderType !== 'customer') return false
    if (!NOTIFY_POOLS.has(conversation.pool_type)) return false
    if (message.conversationId && conversation.id && message.conversationId !== conversation.id) return false
    if (message.id && this.recentMessageIds.has(message.id)) return false
    return true
  }

  notify({ message, conversation, summary, isCurrentConversation }) {
    if (!this.shouldNotify(message, conversation)) return

    if (message.id) {
      this.recentMessageIds.add(message.id)
      setTimeout(() => this.recentMessageIds.delete(message.id), 30 * 1000)
    }

    const title = conversation.user_name || conversation.whatsapp_name || conversation.customer_phone || '新客户消息'
    const body = summary || conversation.last_message || '[新消息]'
    const shouldInterrupt = !isCurrentConversation || document.hidden

    if (this.settings.soundEnabled) {
      this.playSound()
    }

    if (this.settings.toastEnabled && shouldInterrupt) {
      ElNotification({
        title: '收到新消息',
        message: `${title}: ${body}`,
        type: 'warning',
        duration: 4500,
        position: 'bottom-right'
      })
    }

    if (shouldInterrupt) {
      this.startTitleFlash()
      this.showDesktopNotification(title, body, conversation.id)
    }
  }

  setUnreadCount(count) {
    this.unreadCount = Math.max(0, Number(count) || 0)
    if (document.hidden && this.unreadCount > 0) {
      this.startTitleFlash()
    } else if (this.unreadCount === 0) {
      this.stopTitleFlash()
    }
  }

  async unlockAudio() {
    if (!this.settings.soundEnabled || this.audioUnlocked) return
    try {
      this.ensureAudioContext()
      if (this.audioContext?.state === 'suspended') {
        await this.audioContext.resume()
      }
      this.audioUnlocked = !this.audioContext || this.audioContext.state === 'running'
    } catch {
      this.audioUnlocked = false
    }
  }

  async testSound(tone = this.settings.soundTone) {
    const soundTone = normalizeSoundTone(tone)
    this.updateSettings({ soundEnabled: true, soundTone })
    try {
      const audio = this.ensureAudioElement(soundTone)
      audio.pause()
      audio.currentTime = 0
      await audio.play()
      this.audioUnlocked = true
      return true
    } catch {
      return this.playSound(soundTone)
    }
  }

  ensureAudioContext() {
    if (!this.audioContext) {
      const AudioContext = window.AudioContext || window.webkitAudioContext
      if (AudioContext) this.audioContext = new AudioContext()
    }
    return this.audioContext
  }

  ensureAudioElement(tone = this.settings.soundTone) {
    const soundTone = normalizeSoundTone(tone)
    if (this.audioElements.has(soundTone)) return this.audioElements.get(soundTone)

    const sampleRate = 8000
    const segments = TONE_PRESETS[soundTone]
    const gapDuration = 0.025
    const duration = segments.reduce((sum, segment) => sum + segment.duration, 0) + gapDuration * (segments.length - 1)
    const samples = Math.floor(sampleRate * duration)
    const buffer = new ArrayBuffer(44 + samples * 2)
    const view = new DataView(buffer)
    const writeString = (offset, value) => {
      for (let i = 0; i < value.length; i++) {
        view.setUint8(offset + i, value.charCodeAt(i))
      }
    }

    writeString(0, 'RIFF')
    view.setUint32(4, 36 + samples * 2, true)
    writeString(8, 'WAVE')
    writeString(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    writeString(36, 'data')
    view.setUint32(40, samples * 2, true)

    const timeline = []
    let cursor = 0
    segments.forEach((segment, index) => {
      timeline.push({
        ...segment,
        start: cursor,
        end: cursor + segment.duration
      })
      cursor += segment.duration
      if (index < segments.length - 1) cursor += gapDuration
    })

    for (let i = 0; i < samples; i++) {
      const t = i / sampleRate
      const segment = timeline.find(item => t >= item.start && t < item.end)
      if (!segment) {
        view.setInt16(44 + i * 2, 0, true)
        continue
      }
      const localT = t - segment.start
      const localSample = Math.floor(localT * sampleRate)
      const localSamples = Math.floor(segment.duration * sampleRate)
      const fade = Math.min(1, localSample / 80, (localSamples - localSample) / 120)
      const value = Math.sin(2 * Math.PI * segment.frequency * localT) * 0.6 * fade
      view.setInt16(44 + i * 2, value * 0x7fff, true)
    }

    const blob = new Blob([buffer], { type: 'audio/wav' })
    const audioElement = new Audio(URL.createObjectURL(blob))
    audioElement.preload = 'auto'
    audioElement.volume = 0.9
    this.audioElements.set(soundTone, audioElement)
    return audioElement
  }

  showAudioBlockedNotice() {
    const now = Date.now()
    if (now - this.lastAudioBlockedNoticeAt < 120000) return
    this.lastAudioBlockedNoticeAt = now
    ElNotification({
      title: '声音提醒未激活',
      message: '请点击顶部铃铛里的“试听”，浏览器放行后新消息会自动播放音效。',
      type: 'warning',
      duration: 7000,
      position: 'bottom-right'
    })
  }

  async playSound(tone = this.settings.soundTone) {
    const soundTone = normalizeSoundTone(tone)
    const segments = TONE_PRESETS[soundTone]
    let lastError = null

    try {
      const audioContext = this.ensureAudioContext()
      if (audioContext?.state === 'suspended') {
        await audioContext.resume()
      }
      if (audioContext?.state === 'running') {
        this.audioUnlocked = true
        let startOffset = 0
        segments.forEach((segment) => {
          const oscillator = audioContext.createOscillator()
          const gain = audioContext.createGain()
          const startAt = audioContext.currentTime + startOffset
          const endAt = startAt + segment.duration
          oscillator.type = 'sine'
          oscillator.frequency.setValueAtTime(segment.frequency, startAt)
          gain.gain.setValueAtTime(0.0001, startAt)
          gain.gain.exponentialRampToValueAtTime(0.22, startAt + 0.02)
          gain.gain.exponentialRampToValueAtTime(0.0001, endAt)
          oscillator.connect(gain)
          gain.connect(audioContext.destination)
          oscillator.start(startAt)
          oscillator.stop(endAt)
          startOffset += segment.duration + 0.025
        })
        return true
      }
    } catch (error) {
      lastError = error
    }

    try {
      const audio = this.ensureAudioElement(soundTone)
      audio.pause()
      audio.currentTime = 0
      await audio.play()
      this.audioUnlocked = true
      return true
    } catch (error) {
      console.warn('[Reminder] 播放新消息音效失败:', error || lastError)
      this.showAudioBlockedNotice()
      return false
    }
  }

  startTitleFlash() {
    if (typeof document === 'undefined') return
    if (this.titleTimer) return
    this.titleTimer = setInterval(() => {
      this.titleVisible = !this.titleVisible
      const countText = this.unreadCount > 0 ? `(${this.unreadCount}) ` : ''
      document.title = this.titleVisible ? `${countText}新消息 - ${this.baseTitle}` : this.baseTitle
    }, 1000)
  }

  stopTitleFlash() {
    if (this.titleTimer) {
      clearInterval(this.titleTimer)
      this.titleTimer = null
    }
    this.titleVisible = false
    if (typeof document !== 'undefined') {
      document.title = this.unreadCount > 0 ? `(${this.unreadCount}) ${this.baseTitle}` : this.baseTitle
    }
  }

  showDesktopNotification(title, body, conversationId) {
    if (typeof window !== 'undefined' && !window.isSecureContext) return
    if (!this.settings.desktopEnabled || typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted') return

    try {
      const notification = new Notification('聚合平台新消息', {
        body: `${title}: ${body}`,
        tag: conversationId || 'platform-new-message',
        renotify: true,
        silent: true
      })
      notification.onclick = () => {
        window.focus()
        notification.close()
      }
    } catch (error) {
      console.warn('[Reminder] 显示桌面通知失败:', error)
    }
  }
}

export const messageReminder = new MessageReminder()
