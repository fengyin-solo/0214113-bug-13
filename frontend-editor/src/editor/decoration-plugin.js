import {
  ViewPlugin,
  Decoration,
  WidgetType
} from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
import { parseMarkdownRegions, isRegionActive } from './markdown-parser'

/**
 * HR Widget — renders a horizontal rule
 */
class HrWidget extends WidgetType {
  toDOM() {
    const hr = document.createElement('hr')
    hr.className = 'md-hr'
    return hr
  }
  ignoreEvent() { return false }
}

/**
 * Image Widget — renders an image preview
 */
class ImageWidget extends WidgetType {
  constructor(alt, url) {
    super()
    this.alt = alt
    this.url = url
  }

  /**
   * 检测是否为本地文件系统路径
   */
  isLocalPath(path) {
    if (!path) return false
    // Windows: C:\, D:\, \\network\path
    if (/^[a-zA-Z]:\\/.test(path) || path.startsWith('\\\\')) return true
    // Unix/Mac: /absolute/path or ~/home/path or file://
    if (path.startsWith('file://') || (path.startsWith('/') && !path.startsWith('//'))) return true
    // Relative paths: ./path or ../path
    if (path.startsWith('./') || path.startsWith('../')) return true
    return false
  }

  /**
   * 检测是否为网络路径
   */
  isNetworkPath(path) {
    if (!path) return false
    return /^https?:\/\//i.test(path) || path.startsWith('//')
  }

  toDOM() {
    const wrapper = document.createElement('span')
    wrapper.className = 'md-image-placeholder'

    // 检查是否为网络路径
    if (this.isNetworkPath(this.url)) {
      const img = document.createElement('img')
      img.src = this.url
      img.alt = this.alt || ''
      img.className = 'md-image-widget'
      img.style.maxWidth = '100%'
      img.onerror = () => {
        wrapper.innerHTML = `
          <div style="display: flex; align-items: center; gap: 8px;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              <circle cx="8.5" cy="8.5" r="1.5"/>
              <polyline points="21 15 16 10 5 21"/>
            </svg>
            <span>图片加载失败: ${this.alt || this.url}</span>
          </div>
        `
        wrapper.className = 'md-image-placeholder'
      }
      wrapper.textContent = ''
      wrapper.className = ''
      wrapper.appendChild(img)
    }
    // 检查是否为本地文件系统路径
    else if (this.isLocalPath(this.url)) {
      wrapper.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 8px; align-items: center;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <span>浏览器无法访问本地路径: ${this.url}</span>
          </div>
          <span style="font-size: 11px; opacity: 0.7;">提示：请使用 http:// 或 https:// 开头的网络图片地址</span>
        </div>
      `
    }
    // 其他情况（可能是相对路径或无效路径）
    else {
      wrapper.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21 15 16 10 5 21"/>
          </svg>
          <span>${this.alt || '图片'}: ${this.url || '未指定路径'}</span>
        </div>
      `
    }
    return wrapper
  }
  ignoreEvent() { return false }
  eq(other) { return other.url === this.url && other.alt === this.alt }
}

/**
 * Checkbox Widget for task lists
 */
class CheckboxWidget extends WidgetType {
  constructor(checked) {
    super()
    this.checked = checked
  }
  toDOM() {
    const span = document.createElement('span')
    span.className = `md-task-checkbox${this.checked ? ' md-task-checkbox--checked' : ''}`
    if (!this.checked) {
      span.innerHTML = '&nbsp;'
    }
    return span
  }
  ignoreEvent() { return false }
  eq(other) { return other.checked === this.checked }
}

// Decoration marks
const headingDeco = (level) => Decoration.mark({ class: `md-heading md-heading--${level}` })
const boldDeco = Decoration.mark({ class: 'md-bold' })
const italicDeco = Decoration.mark({ class: 'md-italic' })
const strikeDeco = Decoration.mark({ class: 'md-strikethrough' })
const inlineCodeDeco = Decoration.mark({ class: 'md-inline-code' })
const linkDeco = Decoration.mark({ class: 'md-link' })
const syntaxHiddenDeco = Decoration.mark({ class: 'md-syntax-hidden' })
const syntaxVisibleDeco = Decoration.mark({ class: 'md-syntax-visible' })
const listMarkerDeco = Decoration.mark({ class: 'md-list-marker' })
const headingMarkDeco = Decoration.mark({ class: 'md-heading-mark' })
const fenceMarkDeco = Decoration.mark({ class: 'md-fence-mark' })

// line decoration 按行首位置缓存（同一行只能有一个 Decoration.line，
// 因此 code-block / quote 等贡献的 class 必须合并到同一个 class 串）
const lineDecoCache = new Map()
function lineDeco(pos, classes) {
  const key = pos + '\0' + classes
  let deco = lineDecoCache.get(key)
  if (!deco) {
    deco = Decoration.line({ class: classes })
    lineDecoCache.set(key, deco)
  }
  return deco
}

/**
 * 统一的选区描述：每个选区携带覆盖的起止行号（1-based），
 * 供 block 区域按行、inline 区域按字符区间统一判定。
 */
function getSelectionRanges(state) {
  const ranges = []
  for (const sel of state.selection.ranges) {
    const lineFrom = state.doc.lineAt(sel.from)
    const lineTo = state.doc.lineAt(sel.to)
    ranges.push({
      from: sel.from,
      to: sel.to,
      startLine: lineFrom.number,
      endLine: lineTo.number
    })
  }
  return ranges
}

/**
 * Build decorations for the entire document.
 *
 * 统一规则：
 * - 是否展开（编辑态）一律由 isRegionActive 决定：
 *   block 按选区覆盖行、inline 按选区字符区间，半开区间求交
 * - 只展开命中的块；未命中的块保持渲染预览；未识别的普通文本
 *   不产生 region，天然保持预览
 * - 相邻块 / 隔空行块的边界来自解析器统一的 region 区间，不会串位
 */
function buildDecorations(view) {
  const { state } = view
  const doc = state.doc.toString()
  const regions = parseMarkdownRegions(doc)
  const selections = getSelectionRanges(state)

  // 行级 class 合并表：lineFrom -> Set<className>
  const lineClasses = new Map()
  const addLineClass = (linePos, cls) => {
    let set = lineClasses.get(linePos)
    if (!set) lineClasses.set(linePos, (set = new Set()))
    set.add(cls)
  }

  // 普通 mark / replace 装饰（from < to 才有效）
  const marks = []

  for (const region of regions) {
    const active = isRegionActive(region, selections)

    switch (region.type) {
      case 'heading': {
        const { level, markFrom, markTo } = region.meta
        // 标题正文样式始终生效
        if (region.contentFrom < region.to) {
          marks.push({ from: region.contentFrom, to: region.to, deco: headingDeco(level) })
        }
        if (active) {
          marks.push({ from: markFrom, to: markTo, deco: headingMarkDeco })
        } else {
          marks.push({ from: markFrom, to: markTo, deco: syntaxHiddenDeco })
        }
        break
      }

      case 'bold': {
        marks.push({ from: region.contentFrom, to: region.contentTo, deco: boldDeco })
        if (!active) {
          marks.push({ from: region.from, to: region.contentFrom, deco: syntaxHiddenDeco })
          marks.push({ from: region.contentTo, to: region.to, deco: syntaxHiddenDeco })
        } else {
          marks.push({ from: region.from, to: region.contentFrom, deco: syntaxVisibleDeco })
          marks.push({ from: region.contentTo, to: region.to, deco: syntaxVisibleDeco })
        }
        break
      }

      case 'italic': {
        marks.push({ from: region.contentFrom, to: region.contentTo, deco: italicDeco })
        if (!active) {
          marks.push({ from: region.from, to: region.contentFrom, deco: syntaxHiddenDeco })
          marks.push({ from: region.contentTo, to: region.to, deco: syntaxHiddenDeco })
        } else {
          marks.push({ from: region.from, to: region.contentFrom, deco: syntaxVisibleDeco })
          marks.push({ from: region.contentTo, to: region.to, deco: syntaxVisibleDeco })
        }
        break
      }

      case 'strikethrough': {
        marks.push({ from: region.contentFrom, to: region.contentTo, deco: strikeDeco })
        if (!active) {
          marks.push({ from: region.from, to: region.contentFrom, deco: syntaxHiddenDeco })
          marks.push({ from: region.contentTo, to: region.to, deco: syntaxHiddenDeco })
        } else {
          marks.push({ from: region.from, to: region.contentFrom, deco: syntaxVisibleDeco })
          marks.push({ from: region.contentTo, to: region.to, deco: syntaxVisibleDeco })
        }
        break
      }

      case 'inline-code': {
        marks.push({ from: region.contentFrom, to: region.contentTo, deco: inlineCodeDeco })
        const markerLen = region.meta.markerLen
        if (!active) {
          marks.push({ from: region.from, to: region.from + markerLen, deco: syntaxHiddenDeco })
          marks.push({ from: region.to - markerLen, to: region.to, deco: syntaxHiddenDeco })
        } else {
          marks.push({ from: region.from, to: region.from + markerLen, deco: syntaxVisibleDeco })
          marks.push({ from: region.to - markerLen, to: region.to, deco: syntaxVisibleDeco })
        }
        break
      }

      case 'link': {
        marks.push({ from: region.contentFrom, to: region.contentTo, deco: linkDeco })
        if (!active) {
          // [ 与 ](url) 在预览态隐藏
          marks.push({ from: region.from, to: region.contentFrom, deco: syntaxHiddenDeco })
          marks.push({ from: region.contentTo, to: region.to, deco: syntaxHiddenDeco })
        } else {
          marks.push({ from: region.from, to: region.contentFrom, deco: syntaxVisibleDeco })
          marks.push({ from: region.contentTo, to: region.to, deco: syntaxVisibleDeco })
        }
        break
      }

      case 'image': {
        if (!active) {
          // 仅预览态：整段图片语法替换为图片 widget
          marks.push({
            from: region.from,
            to: region.to,
            deco: Decoration.replace({
              widget: new ImageWidget(region.meta.alt, region.meta.url)
            })
          })
        }
        // 编辑态：原始语法直接可见，不加任何装饰
        break
      }

      case 'hr': {
        if (!active) {
          marks.push({
            from: region.from,
            to: region.to,
            deco: Decoration.replace({ widget: new HrWidget() })
          })
        }
        break
      }

      case 'blockquote': {
        const { marks: quoteMarks } = region.meta
        for (let i = 0; i < quoteMarks.length; i++) {
          const linePos = state.doc.line(region.startLine + i).from
          // 整行加引用样式；组内首/末行负责圆角方向，保证连续行视觉成组
          addLineClass(linePos, 'md-blockquote')
          if (i === 0) addLineClass(linePos, 'md-blockquote--first')
          if (i === quoteMarks.length - 1) addLineClass(linePos, 'md-blockquote--last')
          const m = quoteMarks[i]
          marks.push({
            from: m.from,
            to: m.to,
            deco: active ? syntaxVisibleDeco : syntaxHiddenDeco
          })
        }
        break
      }

      case 'list-bullet': {
        const { markerFrom, markerTo } = region.meta
        marks.push({ from: markerFrom, to: markerTo, deco: listMarkerDeco })
        break
      }

      case 'list-ordered': {
        const { markerFrom, markerTo } = region.meta
        marks.push({ from: markerFrom, to: markerTo, deco: listMarkerDeco })
        break
      }

      case 'task-list': {
        // checkbox 之前的 - / * / + 保持列表标记样式
        if (region.meta.bulletFrom !== undefined) {
          marks.push({
            from: region.meta.bulletFrom,
            to: region.meta.bulletFrom + 1,
            deco: listMarkerDeco
          })
        }
        if (!active) {
          const { checkFrom, checkTo, checked } = region.meta
          marks.push({
            from: checkFrom,
            to: checkTo + 1,
            deco: Decoration.replace({ widget: new CheckboxWidget(checked) })
          })
        }
        break
      }

      case 'code-block': {
        const { startLine, endLine, meta } = region
        // 是否存在正文行：开、闭围栏不同行时，二者之间的行均为正文；
        // 未闭合块的最后一行也可能是正文。
        const lastContentLineNo = meta.closed ? endLine - 1 : endLine
        const hasContent = lastContentLineNo >= startLine + 1

        for (let n = startLine; n <= endLine; n++) {
          const ln = state.doc.line(n)
          const isOpen = n === startLine
          const isClose = meta.closed && n === endLine
          addLineClass(ln.from, 'md-code-block')
          if (isOpen) addLineClass(ln.from, 'md-code-block--open')
          if (isClose) addLineClass(ln.from, 'md-code-block--close')

          if (!active) {
            // 预览态：围栏行塌缩，不保留深色底条；空块仅保留一条细缝。
            // 圆角/padding 交给正文首末行（见循环后）。
            if (isOpen) {
              addLineClass(ln.from, hasContent
                ? 'md-fence-line--open-collapsed'
                : 'md-fence-line--solo-collapsed')
            }
            // 闭围栏无正文时同样塌缩（细缝样式由开围栏行承担）
            if (isClose) {
              addLineClass(ln.from, hasContent
                ? 'md-fence-line--close-collapsed'
                : 'md-fence-line--open-collapsed')
            }
          } else {
            // 编辑态：围栏字符弱化高亮
            if (isOpen) {
              const om = meta.openMarker
              marks.push({ from: om.from, to: om.to, deco: fenceMarkDeco })
            }
            if (isClose) {
              const cm = meta.closeMarker
              marks.push({ from: cm.from, to: cm.to, deco: fenceMarkDeco })
            }
          }
        }

        // 正文首/末行承担视觉盒的圆角与上下间距：
        // - 已闭合块编辑态：围栏行可见，由 --open/--close 自身承担
        // - 预览态：围栏行塌缩，由正文首/末行承担；空块用细缝类承担
        // - 未闭合块：无论编辑/预览都没有闭围栏行，末行始终承担底圆角
        if (hasContent) {
          if (!active) {
            addLineClass(state.doc.line(startLine + 1).from, 'md-code-block--content-first')
          }
          if (!meta.closed || !active) {
            addLineClass(state.doc.line(lastContentLineNo).from, 'md-code-block--content-last')
          }
        }
        break
      }
    }
  }

  const builder = new RangeSetBuilder()
  const all = []

  for (const [linePos, classes] of lineClasses) {
    all.push({ from: linePos, to: linePos, deco: lineDeco(linePos, [...classes].join(' ')) })
  }
  for (const d of marks) {
    if (d.from < d.to) all.push(d)
  }

  // RangeSetBuilder 要求按 from 升序添加；同一位置的 line decoration
  // 必须先于 mark decoration；同位置同为 mark 时按 to 升序，区间稳定。
  const isLineDeco = d => d.from === d.to
  all.sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from
    const al = isLineDeco(a), bl = isLineDeco(b)
    if (al !== bl) return al ? -1 : 1
    return b.to - a.to
  })
  for (const d of all) builder.add(d.from, d.to, d.deco)

  return builder.finish()
}

/**
 * The main ViewPlugin that drives live markdown rendering.
 *
 * 滚动稳定性：展开/收起会改变行高（图片/HR widget 与源码行互换、围栏
 * 行塌缩、标题字号切换等）。本插件只负责装饰集；CodeMirror 在装饰重绘
 * 后会自行 requestMeasure，其 measure 循环在重算高度图前后锚定视口
 * 顶部行块并修正 scrollTop —— 文档变更与纯装饰重绘走同一套机制，
 * 因此切换文稿、撤销、光标移动触发的展开切换都不会产生非预期滚动。
 */
export const markdownDecorationPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildDecorations(view)
    }

    update(update) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  {
    decorations: (v) => v.decorations
  }
)
