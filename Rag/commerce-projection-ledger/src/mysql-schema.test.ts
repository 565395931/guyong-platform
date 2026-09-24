import { describe, expect, it } from 'vitest'
import {
  COMMERCE_PROJECTION_SCHEMA_STATEMENTS,
  ensureCommerceProjectionSchema,
} from './mysql-schema'

describe('commerce projection MySQL schema', () => {
  it('declares five idempotent tables with the required identity keys', () => {
    const sql = COMMERCE_PROJECTION_SCHEMA_STATEMENTS.join('\n')

    for (const table of [
      'commerce_account_mappings',
      'commerce_sku_mappings',
      'commerce_order_links',
      'commerce_projection_jobs',
      'commerce_projection_audit_logs',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }

    expect(sql).toMatch(/UNIQUE KEY uk_commerce_account_mapping \(channel, account_id\)/)
    expect(sql).toMatch(/UNIQUE KEY uk_commerce_sku_mapping \(channel, account_id, external_sku\)/)
    expect(sql).toMatch(/PRIMARY KEY \(channel, account_id, external_order_id\)/)
    expect(sql).toMatch(/UNIQUE KEY uk_commerce_projection_event \(event_inbox_id\)/)
    expect(sql).toMatch(/INDEX idx_commerce_projection_claim \(status, next_attempt_at, locked_at\)/)
    expect(sql).toMatch(/INDEX idx_commerce_projection_audit_job \(job_id, created_at\)/)
  })

  it('does not persist full command or platform payload JSON', () => {
    const sql = COMMERCE_PROJECTION_SCHEMA_STATEMENTS.join('\n')

    expect(sql).toContain('command_ref VARCHAR(512) NOT NULL')
    expect(sql).not.toMatch(/command_json|payload_json|customer_json|address_json/i)
  })

  it('executes every statement in a stable order', async () => {
    const calls: string[] = []
    await ensureCommerceProjectionSchema({
      query: async (sql) => {
        calls.push(sql)
        return [[], {}]
      },
    })

    expect(calls).toEqual(COMMERCE_PROJECTION_SCHEMA_STATEMENTS)
  })
})
