import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const readSource = relativePath => readFileSync(new URL(relativePath, import.meta.url), 'utf8')

test('workbench passes read-only channel policy into the chat window', () => {
  const source = readSource('../../views/Workbench/WorkbenchView.vue')

  assert.match(source, /readOnlyChannels:\s*\{\s*type:\s*Array/)
  assert.match(source, /:read-only-channels="props\.readOnlyChannels"/)
  assert.match(source, /:read-only-reason="props\.readOnlyReason"/)
})

test('chat window disables the composer and blocks send for read-only conversation channels', () => {
  const source = readSource('../../components/Chat/ChatWindow.vue')

  assert.match(source, /const transportReadOnly = computed/)
  assert.match(source, /props\.readOnlyChannels\.includes\(props\.conversation\?\.channel\)/)
  assert.match(source, /:disabled="sending \|\| transportReadOnly"/)
  assert.match(source, /if \(transportReadOnly\.value\) return/)
  assert.match(source, /需要在线桌面节点/)
})
