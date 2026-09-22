import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isRegionSelected,
  parseMarkdownRegions
} from '../markdown-parser.js'

const blockTypes = new Set(['heading', 'blockquote', 'code-block'])

const blocks = (doc) =>
  parseMarkdownRegions(doc)
    .filter(region => blockTypes.has(region.type))
    .map(region => ({
      type: region.type,
      from: region.from,
      to: region.to,
      startLine: region.meta.startLine,
      endLine: region.meta.endLine,
      closed: region.meta.close !== undefined ? region.meta.close !== null : undefined
    }))

const selectLine = (region, line) =>
  isRegionSelected(region, [{ startNumber: line, endNumber: line }], null)

test('adjacent headings, blockquotes and fences keep independent line boundaries', () => {
  const doc = '# First\n# Second\n> one\n> two\n\n> three\n```js\nconst a = 1\n```\n# Third'
  assert.deepEqual(blocks(doc), [
    { type: 'heading', from: 0, to: 7, startLine: 0, endLine: 0, closed: undefined },
    { type: 'heading', from: 8, to: 16, startLine: 1, endLine: 1, closed: undefined },
    { type: 'blockquote', from: 17, to: 28, startLine: 2, endLine: 3, closed: undefined },
    { type: 'blockquote', from: 30, to: 37, startLine: 5, endLine: 5, closed: undefined },
    { type: 'code-block', from: 38, to: 59, startLine: 6, endLine: 8, closed: true },
    { type: 'heading', from: 60, to: 67, startLine: 9, endLine: 9, closed: undefined }
  ])

  const parsed = parseMarkdownRegions(doc)
  const cases = [
    [0, 'heading'],
    [1, 'heading'],
    [2, 'blockquote'],
    [3, 'blockquote'],
    [4, null],
    [5, 'blockquote'],
    [6, 'code-block'],
    [7, 'code-block'],
    [8, 'code-block'],
    [9, 'heading']
  ]
  for (const [line, expectedType] of cases) {
    const active = parsed
      .filter(region => region.meta?.scope === 'block')
      .filter(region => selectLine(region, line))
    assert.deepEqual(active.map(region => region.type), expectedType ? [expectedType] : [])
  }
})

test('consecutive blank lines do not bridge or expand block regions', () => {
  const doc = '# A\n\n\n\n> quote\n\n\n```js\na\n```\n\n'
  const parsed = parseMarkdownRegions(doc)

  for (const region of parsed.filter(item => item.meta?.scope === 'block')) {
    for (const blankLine of [1, 2, 3, 5, 6, 10]) {
      assert.equal(selectLine(region, blankLine), false)
    }
  }

  assert.deepEqual(blocks(doc).map(item => [item.type, item.startLine, item.endLine]), [
    ['heading', 0, 0],
    ['blockquote', 4, 4],
    ['code-block', 7, 9]
  ])
})

test('unclosed fences include every following content line but never a closing marker', () => {
  const doc = 'plain\n\n```js\n# heading-looking\n> quote-looking\n\n\nlast line\n'
  const fences = parseMarkdownRegions(doc).filter(region => region.type === 'code-block')
  assert.equal(fences.length, 1)
  assert.equal(fences[0].meta.close, null)
  assert.equal(fences[0].meta.closePrefix, null)
  assert.equal(fences[0].meta.openPrefix.from, doc.indexOf('```js'))
  assert.equal(fences[0].meta.openPrefix.to, doc.indexOf('```js') + 5)
  assert.deepEqual([fences[0].meta.startLine, fences[0].meta.endLine], [2, 7])
  assert.equal(fences[0].to, doc.length - 1)
  assert.deepEqual(blocks(doc).map(item => item.type), ['code-block'])
})

test('fences distinguish opening/closing characters and lengths', () => {
  const doc = '```\n~~~\n```\n~~~~\n```js\n````\n'
  const fences = parseMarkdownRegions(doc).filter(region => region.type === 'code-block')
  assert.equal(fences.length, 2)
  assert.deepEqual([fences[0].meta.startLine, fences[0].meta.endLine], [0, 2])
  assert.deepEqual([fences[0].meta.openPrefix.from, fences[0].meta.openPrefix.to], [0, 3])
  assert.deepEqual([fences[0].meta.closePrefix.from, fences[0].meta.closePrefix.to], [8, 11])
  assert.deepEqual([fences[1].meta.startLine, fences[1].meta.endLine], [3, 5])
})

test('a mixed document leaves unknown paragraph/list lines outside block scopes', () => {
  const doc = '# Title\n\nparagraph\n\n- bullet\n\n> quote with **bold**\n\n1. ordered\n\n```\ncode\n```'
  const parsed = parseMarkdownRegions(doc)
  const list = parsed.filter(region => ['list-bullet', 'list-ordered'].includes(region.type))
  assert.equal(list.every(region => region.meta.scope === 'inline'), true)

  const paragraphLine = 2
  const expanded = parsed
    .filter(region => region.meta?.scope === 'block')
    .filter(region => selectLine(region, paragraphLine))
  assert.deepEqual(expanded, [])

  const quote = parsed.find(region => region.type === 'blockquote')
  const bold = parsed.find(region => region.type === 'bold')
  assert.equal(selectLine(quote, 6), true)
  assert.equal(isRegionSelected(bold, [{ from: 0, to: 0 }], null), false)
  assert.equal(isRegionSelected(bold, [
    { from: bold.from, to: bold.from }
  ], null), true)
})

test('headings resolve marker ranges without trailing spaces or raw hashes', () => {
  const doc = '#\n# \n#  Heading\n#no heading'
  const headings = parseMarkdownRegions(doc).filter(region => region.type === 'heading')
  assert.equal(headings.length, 3)
  assert.deepEqual(headings.map(region => [
    region.meta.markFrom,
    region.meta.markTo,
    region.contentFrom,
    region.contentTo
  ]), [
    [0, 1, 1, 1],
    [2, 4, 4, 4],
    [5, 8, 8, 15]
  ])
})
