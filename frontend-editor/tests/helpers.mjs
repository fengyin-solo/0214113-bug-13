// 轻量集成测试工具：在 jsdom 中启动真实的 CodeMirror EditorView + 本插件
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
  pretendToBeVisual: true
})
for (const key of ['window', 'document', 'navigator', 'MutationObserver', 'getSelection',
  'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'matchMedia']) {
  if (dom.window[key] !== undefined && globalThis[key] === undefined) globalThis[key] = dom.window[key]
}
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.getSelection = () => dom.window.getSelection()
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
dom.window.HTMLElement.prototype.scrollIntoView = function () {}
globalThis.MutationObserver = dom.window.MutationObserver || class {
  observe(){} unobserve(){} disconnect(){} takeRecords(){ return [] }
}
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} }
}
if (!dom.window.matchMedia) {
  dom.window.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){} })
}

dom.window.Element.prototype.getBoundingClientRect = function () {
  return {
    top: 0, left: 0, right: 700, bottom: 28, width: 700, height: 28, x: 0, y: 0,
    toJSON() { return {} }
  }
}
// CodeMirror 异步测量时会调用 Range.getClientRects
if (dom.window.Range) {
  dom.window.Range.prototype.getClientRects = () => []
  dom.window.Range.prototype.getBoundingClientRect = () => ({
    top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0
  })
}

const { EditorState } = await import('@codemirror/state')
const { EditorView } = await import('@codemirror/view')
const { markdown, markdownLanguage } = await import('@codemirror/lang-markdown')
const { markdownDecorationPlugin } = await import('../src/editor/decoration-plugin.js')

export function makeView(doc, anchor = 0, head = anchor) {
  const host = document.getElementById('host')
  host.innerHTML = ''
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage }), markdownDecorationPlugin],
    selection: { anchor, head }
  })
  return new EditorView({ state, parent: host })
}

// 从插件取装饰集并展开为 {from,to,spec} 列表
export function decoList(view) {
  const plugin = view.plugin(markdownDecorationPlugin)
  const set = plugin.decorations
  const list = []
  const cursor = set.iter()
  while (cursor.value) {
    list.push({ from: cursor.from, to: cursor.to, spec: cursor.value.spec })
    cursor.next()
  }
  return list
}

export function classesOnLine(view, lineNo) {
  const line = view.state.doc.line(lineNo)
  return decoList(view)
    .filter(d => d.from === line.from && d.from === d.to)
    .map(d => d.spec.class || '')
    .join(' ')
}

export function marksBetween(view, from, to) {
  return decoList(view).filter(d => d.from < d.to && d.from >= from && d.to <= to)
}
