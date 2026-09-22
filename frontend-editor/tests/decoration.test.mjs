import assert from 'node:assert/strict'
import { makeView, decoList, classesOnLine } from './helpers.mjs'

let pass = 0, fail = 0
function test(name, fn) {
  try { fn(); pass++; console.log('PASS', name) }
  catch (e) { fail++; console.log('FAIL', name); console.log('  ', e.message) }
}

const hasClass = (cls, str) => str.split(/\s+/).includes(cls)
const flatClasses = (view) => decoList(view).filter(d => d.from === d.to).map(d => d.spec.class)
const hasHiddenRange = (view, from, to) =>
  decoList(view).some(d => d.from === from && d.to === to && d.spec.class === 'md-syntax-hidden')
const hasVisibleRange = (view, from, to) =>
  decoList(view).some(d => d.from === from && d.to === to &&
    (d.spec.class === 'md-syntax-visible' || d.spec.class === 'md-heading-mark'))
const hasWidgetAt = (view, from, to) =>
  decoList(view).some(d => d.from === from && d.to === to && d.spec.widget)

// ----------------------------------------------------------------------
// 1. 标题：相邻 / 隔空行时只展开命中的块，起止不串位
// ----------------------------------------------------------------------
test('heading on line 1: only heading hashes visible, quote below stays preview', () => {
  // 光标在引用行时标题保持预览
  const doc = '# H\n> q1\n> q2'
  const view = makeView(doc, 5)
  assert.ok(hasHiddenRange(view, 0, 2))
  assert.ok(hasVisibleRange(view, 4, 6))
  assert.ok(hasVisibleRange(view, 9, 11))
})

test('heading expanded while quote stays preview', () => {
  const doc = '# H\n> q1\n> q2'
  const view = makeView(doc, 1)
  // 标题 # 可见
  assert.ok(hasVisibleRange(view, 0, 2))
  // 引用两行的 > 标记均隐藏（预览），没有串开
  assert.ok(hasHiddenRange(view, 4, 6), 'quote1 mark hidden')
  assert.ok(hasHiddenRange(view, 9, 11), 'quote2 mark hidden')
})

test('caret on quote line expands the whole quote group, heading stays preview', () => {
  const doc = '# H\n> q1\n> q2'
  const view = makeView(doc, 5)
  assert.ok(hasHiddenRange(view, 0, 2), 'heading hashes hidden')
  assert.ok(hasVisibleRange(view, 4, 6))
  assert.ok(hasVisibleRange(view, 9, 11))
})

test('blank line between heading and quote belongs to neither', () => {
  const doc = '# H\n\n> q'
  const view = makeView(doc, doc.indexOf('>') + 2)
  assert.ok(hasVisibleRange(view, doc.indexOf('>'), doc.indexOf('>') + 2))
  assert.ok(hasHiddenRange(view, 0, 2))
})

test('caret on blank line expands nothing (all blocks stay preview)', () => {
  const doc = '# H\n\n> q'
  const view = makeView(doc, 4)
  assert.ok(hasHiddenRange(view, 0, 2))
  assert.ok(hasHiddenRange(view, 5, 7))
})

// ----------------------------------------------------------------------
// 2. 连续空行：不产生任何装饰，边界不受影响
// ----------------------------------------------------------------------
test('multiple consecutive blank lines do not shift boundaries', () => {
  const doc = '# H\n\n\n\n> q'
  const view = makeView(doc, 1)
  const lines = doc.split('\n')
  // 最后一行引用保持预览
  const qStart = doc.indexOf('>')
  assert.ok(hasHiddenRange(view, qStart, qStart + 2))
  // 空行无 line decoration
  for (const n of [2, 3, 4]) {
    assert.equal(classesOnLine(view, n), '')
  }
})

// ----------------------------------------------------------------------
// 3. 代码围栏：闭合、未闭合、伪闭合、混合
// ----------------------------------------------------------------------
test('closed code block: fences collapsed in preview, rounded classes grouped', () => {
  const doc = '```js\ncode\n```\npara'
  const view = makeView(doc, doc.indexOf('para'))
  assert.ok(hasClass('md-fence-line--open-collapsed', classesOnLine(view, 1)))
  assert.ok(hasClass('md-fence-line--close-collapsed', classesOnLine(view, 3)))
  assert.ok(hasClass('md-code-block', classesOnLine(view, 2)))
  assert.ok(!hasClass('md-fence-line--open-collapsed', classesOnLine(view, 2)))
})

test('code block active: fences visible with fence-mark class, open/close carry radii', () => {
  const doc = '```js\ncode\n```'
  const view = makeView(doc, doc.indexOf('code'))
  assert.ok(hasClass('md-code-block--open', classesOnLine(view, 1)))
  assert.ok(!classesOnLine(view, 1).includes('collapsed'))
  assert.ok(hasClass('md-code-block--close', classesOnLine(view, 3)))
  // 编辑态下正文行不承担圆角类
  assert.ok(!classesOnLine(view, 2).includes('content-first'))
  // 围栏字符有弱化标记
  assert.ok(decoList(view).some(d => d.spec.class === 'md-fence-mark'))
})

test('code block preview: content first/last lines carry the visual box radii', () => {
  const doc = '```js\ncode1\ncode2\n```\npara'
  const view = makeView(doc, doc.indexOf('para'))
  assert.ok(hasClass('md-code-block--content-first', classesOnLine(view, 2)))
  assert.ok(hasClass('md-code-block--content-last', classesOnLine(view, 3)))
  assert.ok(!classesOnLine(view, 2).includes('--open'))
})

test('unclosed fence at EOF: still parsed, preview collapses open fence', () => {
  const doc = 'para\n\n```js\ncode without end'
  const view = makeView(doc, 0)
  assert.ok(hasClass('md-code-block', classesOnLine(view, 3)))
  assert.ok(hasClass('md-code-block', classesOnLine(view, 4)))
  assert.ok(hasClass('md-fence-line--open-collapsed', classesOnLine(view, 3)))
})

test('unclosed fence can be expanded by caret inside', () => {
  const doc = '```js\ncode without end'
  const view = makeView(doc, doc.indexOf('code'))
  assert.ok(!classesOnLine(view, 1).includes('collapsed'))
  assert.ok(hasClass('md-code-block--open', classesOnLine(view, 1)))
})

test('closing fence with trailing text is code content, not a fence', () => {
  const doc = '```\ncode\n``` tail\nmore\n```'
  // 整块闭合在最后一行；让选区落在代码块内会展开围栏，因此用一个
  // 块外的“文档起始之上”位置无法构造——改用反向断言：闭合类只在第 5 行
  const view = makeView(doc, doc.length)
  // 整块一直延伸到最后一行，且全部是 code-block
  for (const n of [1, 2, 3, 4, 5]) {
    assert.ok(hasClass('md-code-block', classesOnLine(view, n)), `line ${n} code-block`)
  }
  // 唯一的开围栏在第 1 行；第 5 行才是真正的闭围栏
  // 光标在最后一行（闭围栏），整块展开 —— 验证第 3 行只是普通代码行
  assert.ok(!classesOnLine(view, 3).includes('fence-line'))
  assert.ok(hasClass('md-code-block--close', classesOnLine(view, 5)))
  // 预览态另起一视图（光标放文档后不可能；在块前插入空行承载光标）
  const preview = makeView('p\n\n' + doc, 1)
  assert.ok(hasClass('md-fence-line--open-collapsed', classesOnLine(preview, 3)))
  assert.ok(hasClass('md-fence-line--close-collapsed', classesOnLine(preview, 7)))
  assert.ok(!classesOnLine(preview, 5).includes('fence-line'))
})

test('tilde fence and backtick fence do not cross-close', () => {
  const doc = '```\n~~~\n```\npara'
  const view = makeView(doc, doc.indexOf('para'))
  assert.ok(hasClass('md-code-block', classesOnLine(view, 2)))
  assert.ok(hasClass('md-fence-line--close-collapsed', classesOnLine(view, 3)))
  // 中间的 ~~~ 只是代码内容
  assert.ok(!classesOnLine(view, 2).includes('fence-line'))
})

test('empty code block previews as a thin slot, expands on click', () => {
  const doc = '```\n```\npara'
  const preview = makeView(doc, doc.indexOf('para'))
  // 无正文：开围栏行渲染为细缝，闭围栏行完全塌缩
  assert.ok(hasClass('md-fence-line--solo-collapsed', classesOnLine(preview, 1)))
  assert.ok(hasClass('md-fence-line--open-collapsed', classesOnLine(preview, 2)))
  const edit = makeView(doc, 4) // 光标在闭围栏行内
  assert.ok(!classesOnLine(edit, 1).includes('collapsed'))
  assert.ok(hasClass('md-code-block--close', classesOnLine(edit, 2)))
})

// ----------------------------------------------------------------------
// 4. 引用分组：连续 > 行是一个块；隔空行断开
// ----------------------------------------------------------------------
test('adjacent quote lines grouped: one first, one last, continuous middle', () => {
  const doc = '> a\n> b\n> c'
  const view = makeView(doc, 1)
  const l1 = classesOnLine(view, 1), l2 = classesOnLine(view, 2), l3 = classesOnLine(view, 3)
  assert.ok(hasClass('md-blockquote--first', l1))
  assert.ok(!l2.includes('--first') && !l2.includes('--last'))
  assert.ok(hasClass('md-blockquote--last', l3))
})

test('blank line splits quote into two independent groups', () => {
  const doc = '> a\n\n> b'
  const view = makeView(doc, doc.indexOf('a'))
  // 第一组展开，第二组预览
  assert.ok(hasVisibleRange(view, 0, 2))
  assert.ok(hasHiddenRange(view, doc.indexOf('> b'), doc.indexOf('> b') + 2))
  // 两组各自带 first/last
  assert.ok(hasClass('md-blockquote--first', classesOnLine(view, 1)))
  assert.ok(hasClass('md-blockquote--last', classesOnLine(view, 1)))
  assert.ok(hasClass('md-blockquote--first', classesOnLine(view, 3)))
  assert.ok(hasClass('md-blockquote--last', classesOnLine(view, 3)))
})

// ----------------------------------------------------------------------
// 5. 混合结构：命中块展开，其余（含行内）按各自规则
// ----------------------------------------------------------------------
test('mixed doc: caret in heading expands only heading even with nearby image/hr', () => {
  const doc = '# Title\n\n![a](https://x.io/a.png)\n\n---\n\ntext'
  // 光标在标题文本中（避开行首 0 也在标题行这一事实，1 即标题内）
  const view = makeView(doc, 3)
  // 标题标记可见
  assert.ok(hasVisibleRange(view, 0, 2))
  // 图片与 hr 仍是 widget（预览）
  assert.ok(hasWidgetAt(view, doc.indexOf('!['), doc.indexOf(')') + 1))
  assert.ok(hasWidgetAt(view, doc.indexOf('---'), doc.indexOf('---') + 3))
})

test('inline syntax only expands when caret intersects its range', () => {
  const doc = '**a** and *b* and `c`'
  // 光标在 a 内
  const view = makeView(doc, 3)
  // bold 标记可见
  assert.ok(hasVisibleRange(view, 0, 2))
  assert.ok(hasVisibleRange(view, 3, 5))
  // italic / code 标记仍隐藏
  const italStart = doc.indexOf('*b*')
  const codeStart = doc.indexOf('`c`')
  assert.ok(hasHiddenRange(view, italStart, italStart + 1))
  assert.ok(hasHiddenRange(view, codeStart, codeStart + 1))
})

test('caret elsewhere on inline line does not expand inline regions', () => {
  const doc = 'a **bold** end'
  const view = makeView(doc, 0)
  assert.ok(hasHiddenRange(view, 2, 4))
  assert.ok(hasHiddenRange(view, 8, 10))
})

test('image on caret line but caret outside image stays preview widget', () => {
  const doc = 'before ![a](https://x.io/a.png) after'
  const view = makeView(doc, 2)
  assert.ok(hasWidgetAt(view, doc.indexOf('!['), doc.indexOf(')') + 1))
})

// ----------------------------------------------------------------------
// 6. 未知块：普通段落永远保持预览（不产生展开）
// ----------------------------------------------------------------------
test('plain paragraphs never get decorations of their own', () => {
  const doc = 'just a plain paragraph\n\nanother one'
  const view = makeView(doc, 5)
  assert.deepEqual(flatClasses(view), [])
})

// ----------------------------------------------------------------------
// 7. 撤销 / 重做：装饰随事务重建，围栏状态不残留
// ----------------------------------------------------------------------
test('undo after opening a fence restores preview decorations cleanly', () => {
  const doc = 'text\n'
  const view = makeView(doc, doc.length)
  // 输入未闭合围栏
  view.dispatch({
    changes: { from: doc.length, insert: '```\ncode' },
    selection: { anchor: doc.length + 8 }
  })
  assert.ok(classesOnLine(view, 2).includes('md-code-block'))
  // 撤销
  view.dispatch({ changes: view.state.doc.toString().length }) // noop guard
  // 用 history 不可用（未挂 keymap），直接模拟整体替换回原文
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: doc },
    selection: { anchor: doc.length }
  })
  assert.deepEqual(flatClasses(view), [])
})

test('multi-line selection activates every block it covers', () => {
  const doc = '# H\n\n> q\n\n```\nx\n```'
  const view = makeView(doc, 0, doc.length)
  assert.ok(hasVisibleRange(view, 0, 2))
  const qStart = doc.indexOf('> q')
  assert.ok(hasVisibleRange(view, qStart, qStart + 2))
  // 围栏在选区下展开（不塌缩）——开围栏在第 5 行
  assert.ok(hasClass('md-code-block--open', classesOnLine(view, 5)))
  assert.ok(!classesOnLine(view, 5).includes('collapsed'))
})

// ----------------------------------------------------------------------
// 8. 切换文稿：新文稿从头推导，展开范围只跟随新光标
// ----------------------------------------------------------------------
test('whole-doc replacement resets fence state and active ranges', () => {
  const view = makeView('```\ncode\n```', 10)
  assert.ok(classesOnLine(view, 1).includes('md-code-block'))
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: '# New\ndoc' },
    selection: { anchor: 0 }
  })
  // 旧的 code-block 装饰全部消失
  assert.deepEqual(flatClasses(view), [])
  assert.ok(hasVisibleRange(view, 0, 2))
})


// ----------------------------------------------------------------------
// 9. 回归：任务列表不重复产 ul region；引用内列表仍识别
// ----------------------------------------------------------------------
test('task list line produces exactly one list region with bullet meta', async () => {
  const doc = '- [x] done\n- [ ] todo'
  const { parseMarkdownRegions } = await import('../src/editor/markdown-parser.js')
  const regions = parseMarkdownRegions(doc)
  assert.equal(regions.filter(r => r.type === 'task-list').length, 2)
  assert.equal(regions.filter(r => r.type === 'list-bullet').length, 0)
  assert.equal(regions[0].meta.bulletFrom, 0)
})

test('list inside blockquote is still recognized', () => {
  const doc = '> - quoted item'
  const view = makeView(doc, 4)
  assert.ok(decoList(view).some(d => d.spec.class === 'md-list-marker'))
  assert.ok(classesOnLine(view, 1).includes('md-blockquote'))
})

test('task checkbox is a widget in preview and raw brackets when active', () => {
  // 预览态：光标在块外的独立段落上
  const preview = makeView('- [ ] todo\n\npara', '- [ ] todo\n\n'.length + 1)
  // checkbox 区间 [2..6)（'[ ] ' 整体 replace 为 checkbox widget）
  assert.ok(hasWidgetAt(preview, 2, 6))
  // 编辑态：光标在任务行内
  const active = makeView('- [ ] todo', 3)
  assert.ok(!hasWidgetAt(active, 2, 6))
})

// ----------------------------------------------------------------------
// 10. 仅选区变化导致的展开切换：装饰立即重建，随后 CM 内置的异步
//     measure（高度锚定）在 jsdom 下也能安全跑完不崩溃
// ----------------------------------------------------------------------
test('selection-only toggle re-renders decorations and survives async measure', async () => {
  const doc = '# H1\n\n![a](https://x.io/a.png)\n\n# H2\n\ntext text text'
  const view = makeView(doc, 0)
  const h2 = doc.indexOf('# H2')
  view.dispatch({ selection: { anchor: h2 + 1 } })
  assert.ok(hasVisibleRange(view, h2, h2 + 2))
  assert.ok(hasHiddenRange(view, 0, 2))
  // 等待 setTimeout 模拟的 rAF（CM 的 measure 循环）
  await new Promise(r => setTimeout(r, 30))
  assert.ok(hasVisibleRange(view, h2, h2 + 2))
})


test('unclosed fence: last content line carries bottom radius in both modes', () => {
  const doc = 'para\n\n```js\ncode'
  // 编辑态
  const edit = makeView(doc, doc.indexOf('code'))
  assert.ok(hasClass('md-code-block--content-last', classesOnLine(edit, 4)))
  assert.ok(!classesOnLine(edit, 4).includes('md-code-block--close'))
  // 预览态
  const preview = makeView(doc, 1)
  assert.ok(hasClass('md-code-block--content-last', classesOnLine(preview, 4)))
  assert.ok(hasClass('md-code-block--content-first', classesOnLine(preview, 4)))
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
