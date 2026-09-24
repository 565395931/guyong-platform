const test = require('node:test')
const assert = require('node:assert/strict')

const { createHtmlQuery } = require('./localParserService')

test('htmlparser facade preserves Word block traversal, text and table cells', () => {
  const $ = createHtmlQuery(
    '<html><body><h1>Title</h1><p>Hello <strong>world</strong></p>' +
    '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></body></html>'
  )
  const tags = []
  const paragraphs = []
  const rows = []

  $('body').children().each((_index, element) => {
    tags.push(element.tagName)
    if (element.tagName === 'p') paragraphs.push($(element).text().trim())
    if (element.tagName === 'table') {
      $(element).find('tr').each((_rowIndex, row) => {
        const cells = []
        $(row).find('td, th').each((_cellIndex, cell) => cells.push($(cell).text().trim()))
        rows.push(cells)
      })
    }
  })

  assert.deepEqual(tags, ['h1', 'p', 'table'])
  assert.deepEqual(paragraphs, ['Hello world'])
  assert.deepEqual(rows, [['A', 'B'], ['1', '2']])
})
