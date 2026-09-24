import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizePriceForm,
  normalizeFreightForm,
  validatePriceForm,
  validateFreightForm
} from './catalogForm.js'

test('normalizes numeric price form fields before submission', () => {
  assert.deepEqual(normalizePriceForm({
    skuCode: ' coat-1kg ',
    minQuantity: '10',
    maxQuantity: '',
    unitPrice: '160',
    currency: 'usd',
    unit: 'KG',
    customerType: 'WHOLESALE'
  }), {
    id: undefined,
    skuCode: 'COAT-1KG',
    minQuantity: 10,
    maxQuantity: null,
    unitPrice: 160,
    currency: 'USD',
    unit: 'kg',
    customerType: 'wholesale',
    effectiveFrom: null,
    effectiveTo: null,
    status: 'active'
  })
})

test('validates required and positive price fields', () => {
  assert.deepEqual(validatePriceForm({
    skuCode: '', minQuantity: 0, unitPrice: 0, currency: '', unit: ''
  }), [
    'SKU 不能为空',
    '起订数量必须大于 0',
    '单价必须大于 0',
    '币种不能为空',
    '单位不能为空'
  ])
})

test('manual freight confirmation may omit fees', () => {
  const input = normalizeFreightForm({
    regionCode: ' by ', deliveryTerm: 'ddu', baseWeightKg: '0.5',
    currency: 'usd', manualConfirmation: true
  })
  assert.equal(input.regionCode, 'BY')
  assert.deepEqual(validateFreightForm(input), [])
})

test('freight validation messages are readable', () => {
  assert.deepEqual(validateFreightForm({
    regionCode: '', baseWeightKg: 0, baseFee: 0, currency: '', manualConfirmation: false
  }), [
    '国家或区域编码不能为空',
    '首重必须大于 0',
    '币种不能为空',
    '基础运费必须大于 0'
  ])
})
