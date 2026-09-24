const assert = require('node:assert/strict')
const {
  extractWhatsAppPhone,
  selectNationalityByPhone,
  selectNationalityByLanguage,
  extractLanguageCode
} = require('../src/modules/nationality/nationality.service')
const { NATIONALITY_SEEDS } = require('../src/modules/nationality/nationality.seed')

const dictionary = [
  { code: 'US', phonePrefixes: ['1'], languageCodes: ['en'], priority: 100 },
  { code: 'BS', phonePrefixes: ['1242'], languageCodes: ['en'], priority: 60 },
  { code: 'CN', phonePrefixes: ['86'], languageCodes: ['zh'], priority: 100 },
  { code: 'ES', phonePrefixes: ['34'], languageCodes: ['es'], priority: 100 },
  { code: 'MX', phonePrefixes: ['52'], languageCodes: ['es'], priority: 90 }
]

assert.equal(extractWhatsAppPhone('8613800000000@c.us'), '8613800000000')
assert.equal(extractWhatsAppPhone('123456789@lid'), null)
assert.equal(extractWhatsAppPhone('120363000000@g.us'), null)
assert.equal(selectNationalityByPhone('8613800000000', dictionary).code, 'CN')
assert.equal(selectNationalityByPhone('+1 242 555 0100', dictionary).code, 'BS')
assert.equal(selectNationalityByPhone('+1 415 555 0100', dictionary).code, 'US')
assert.equal(selectNationalityByLanguage('es', dictionary).code, 'ES')
assert.equal(extractLanguageCode({ originalLang: 'PT' }), 'pt')
assert.equal(extractLanguageCode({ text: '你好，请问价格是多少？' }), 'zh')

const fullDictionary = NATIONALITY_SEEDS.map(([code, name, nameEn, phonePrefixes, languageCodes, priority]) => ({
  code,
  name,
  nameEn,
  phonePrefixes,
  languageCodes,
  priority
}))
assert.equal(NATIONALITY_SEEDS.length, 250)
assert.equal(new Set(NATIONALITY_SEEDS.map(item => item[0])).size, 250)
assert.ok(NATIONALITY_SEEDS.every(([code, name, nameEn, prefixes, languages]) => (
  /^[A-Z]{2}$/.test(code) &&
  Boolean(name) &&
  Boolean(nameEn) &&
  prefixes.every(prefix => /^\d+$/.test(prefix)) &&
  languages.every(language => /^[a-z]{2}$/.test(language))
)))
assert.equal(selectNationalityByPhone('+262 692 00 00 00', fullDictionary).code, 'RE')
assert.equal(selectNationalityByPhone('+262 639 00 00 00', fullDictionary).code, 'YT')
assert.equal(selectNationalityByPhone('+1 416 555 0100', fullDictionary).code, 'CA')
assert.equal(selectNationalityByPhone('+1 415 555 0100', fullDictionary).code, 'US')
assert.equal(selectNationalityByPhone('+7 701 000 0000', fullDictionary).code, 'KZ')
assert.equal(selectNationalityByLanguage('fr', fullDictionary).code, 'FR')

console.log('nationality service tests passed')
