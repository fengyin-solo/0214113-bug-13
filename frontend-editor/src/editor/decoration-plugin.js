import {
  EditorView,
  ViewPlugin,
  Decoration,
  WidgetType
} from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
import {
  getSelectionLineRanges,
  isRegionSelected,
  parseMarkdownRegions
} from './markdown-parser'

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
const blockquoteDeco = Decoration.line({ class: 'md-blockquote' })
const blockquoteMarkHiddenDeco = Decoration.mark({ class: 'md-syntax-hidden md-syntax-hidden--block' })
const blockquoteMarkVisibleDeco = Decoration.mark({ class: 'md-syntax-visible' })
const fenceMarkHiddenDeco = Decoration.mark({ class: 'md-fence-mark md-fence-mark--hidden' })
const fenceMarkVisibleDeco = Decoration.mark({ class: 'md-syntax-visible md-fence-mark--visible' })
const syntaxHiddenDeco = Decoration.mark({ class: 'md-syntax-hidden' })
const syntaxVisibleDeco = Decoration.mark({ class: 'md-syntax-visible' })
const codeBlockDeco = Decoration.line({ class: 'md-code-block' })
const listMarkerDeco = Decoration.mark({ class: 'md-list-marker' })
const headingMarkDeco = Decoration.mark({ class: 'md-heading-mark' })

/**
 * Capture the visual line aligned with the scroller before a decoration-only
 * update, then restore it after CodeMirror has rebuilt the DOM. Document edits
 * and undo/redo use the editor's own change anchor instead.
 */
const SCROLL_ANCHOR_KEY = 'md-decoration-scroll-anchor'

function getScrollAnchor(view) {
  const scrollDOM = view.scrollDOM
  const top = scrollDOM.scrollTop
  const block = view.elementAtHeight(top + scrollDOM.clientTop)
  const line = view.lineBlockAt(block.from)
  return {
    pos: block.from,
    // Distance from the block's top edge to the current scroll position.
    offset: top - line.top,
    left: scrollDOM.scrollLeft
  }
}

function restoreScrollAnchor(view, anchor) {
  view.requestMeasure({
    key: SCROLL_ANCHOR_KEY,
    read() {
      const line = view.lineBlockAt(Math.min(anchor.pos, view.state.doc.length))
      return line.top + anchor.offset
    },
    write(top) {
      const maxTop = Math.max(0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight)
      view.scrollDOM.scrollTop = Math.max(0, Math.min(top, maxTop))
      view.scrollDOM.scrollLeft = Math.min(anchor.left, Math.max(0, view.scrollDOM.scrollWidth - view.scrollDOM.clientWidth))
    }
  })
}

/**
 * Build decorations for the entire document.
 * Core logic: if a selected region contains the cursor, show syntax marks;
 * otherwise, hide them and show rendered result. Only the selected block is
 * expanded — adjacent blocks and blank lines remain in their preview state.
 */
function buildDecorations(view) {
  const { state } = view
  const doc = state.doc.toString()
  const regions = parseMarkdownRegions(doc)
  const selectionRanges = getSelectionLineRanges(state)
  const builder = new RangeSetBuilder()

  // We need to collect all decorations and sort them by from position
  const decos = []

  for (const region of regions) {
    const cursorOn = isRegionSelected(region, selectionRanges, state.doc)

    switch (region.type) {
      case 'heading': {
        const { level, markFrom, markTo } = region.meta
        // Always apply heading style to content
        decos.push({ from: region.contentFrom, to: region.to, deco: headingDeco(level) })
        if (cursorOn) {
          // Show the hash marks with special styling
          decos.push({ from: markFrom, to: markTo, deco: headingMarkDeco })
        } else {
          // Hide the hash marks
          decos.push({ from: markFrom, to: markTo, deco: syntaxHiddenDeco })
        }
        break
      }

      case 'bold': {
        // Apply bold to content
        decos.push({ from: region.contentFrom, to: region.contentTo, deco: boldDeco })
        if (!cursorOn) {
          // Hide markers
          decos.push({ from: region.from, to: region.contentFrom, deco: syntaxHiddenDeco })
          decos.push({ from: region.contentTo, to: region.to, deco: syntaxHiddenDeco })
        } else {
          decos.push({ from: region.from, to: region.contentFrom, deco: syntaxVisibleDeco })
          decos.push({ from: region.contentTo, to: region.to, deco: syntaxVisibleDeco })
        }
        break
      }

      case 'italic': {
        decos.push({ from: region.contentFrom, to: region.contentTo, deco: italicDeco })
        if (!cursorOn) {
          decos.push({ from: region.from, to: region.contentFrom, deco: syntaxHiddenDeco })
          decos.push({ from: region.contentTo, to: region.to, deco: syntaxHiddenDeco })
        } else {
          decos.push({ from: region.from, to: region.contentFrom, deco: syntaxVisibleDeco })
          decos.push({ from: region.contentTo, to: region.to, deco: syntaxVisibleDeco })
        }
        break
      }

      case 'strikethrough': {
        decos.push({ from: region.contentFrom, to: region.contentTo, deco: strikeDeco })
        if (!cursorOn) {
          decos.push({ from: region.from, to: region.contentFrom, deco: syntaxHiddenDeco })
          decos.push({ from: region.contentTo, to: region.to, deco: syntaxHiddenDeco })
        } else {
          decos.push({ from: region.from, to: region.contentFrom, deco: syntaxVisibleDeco })
          decos.push({ from: region.contentTo, to: region.to, deco: syntaxVisibleDeco })
        }
        break
      }

      case 'inline-code': {
        decos.push({ from: region.contentFrom, to: region.contentTo, deco: inlineCodeDeco })
        if (!cursorOn) {
          const markerLen = region.meta.markerLen
          decos.push({ from: region.from, to: region.from + markerLen, deco: syntaxHiddenDeco })
          decos.push({ from: region.to - markerLen, to: region.to, deco: syntaxHiddenDeco })
        } else {
          const markerLen = region.meta.markerLen
          decos.push({ from: region.from, to: region.from + markerLen, deco: syntaxVisibleDeco })
          decos.push({ from: region.to - markerLen, to: region.to, deco: syntaxVisibleDeco })
        }
        break
      }

      case 'link': {
        if (!cursorOn) {
          // Show only the link text with link styling
          decos.push({ from: region.contentFrom, to: region.contentTo, deco: linkDeco })
          // Hide [
          decos.push({ from: region.from, to: region.contentFrom, deco: syntaxHiddenDeco })
          // Hide ](url)
          decos.push({ from: region.contentTo, to: region.to, deco: syntaxHiddenDeco })
        } else {
          decos.push({ from: region.contentFrom, to: region.contentTo, deco: linkDeco })
          decos.push({ from: region.from, to: region.contentFrom, deco: syntaxVisibleDeco })
          decos.push({ from: region.contentTo, to: region.to, deco: syntaxVisibleDeco })
        }
        break
      }

      case 'image': {
        if (!cursorOn) {
          // Replace the entire image syntax with a widget
          decos.push({
            from: region.from,
            to: region.to,
            deco: Decoration.replace({
              widget: new ImageWidget(region.meta.alt, region.meta.url)
            })
          })
        }
        // When cursor is on it, show raw syntax (no decoration needed)
        break
      }

      case 'hr': {
        if (!cursorOn) {
          decos.push({
            from: region.from,
            to: region.to,
            deco: Decoration.replace({
              widget: new HrWidget()
            })
          })
        }
        break
      }

      case 'blockquote': {
        const { marks } = region.meta
        for (let lineNum = region.meta.startLine + 1; lineNum <= region.meta.endLine + 1; lineNum++) {
          const line = state.doc.line(lineNum)
          decos.push({ from: line.from, to: line.from, deco: blockquoteDeco, isLine: true })
        }
        const markDeco = cursorOn ? blockquoteMarkVisibleDeco : blockquoteMarkHiddenDeco
        for (const mark of marks) {
          decos.push({ from: mark.from, to: mark.to, deco: markDeco })
        }
        break
      }

      case 'list-bullet': {
        const { markerFrom, markerTo } = region.meta
        decos.push({ from: markerFrom, to: markerTo, deco: listMarkerDeco })
        break
      }

      case 'list-ordered': {
        const { markerFrom, markerTo } = region.meta
        decos.push({ from: markerFrom, to: markerTo, deco: listMarkerDeco })
        break
      }

      case 'task-list': {
        if (!cursorOn) {
          const { checkFrom, checkTo, checked } = region.meta
          decos.push({
            from: checkFrom,
            to: checkTo + 1,
            deco: Decoration.replace({
              widget: new CheckboxWidget(checked)
            })
          })
        }
        break
      }

      case 'code-block': {
        // Apply the same line decoration to every line that belongs to the
        // fenced region. The range is resolved from parser line numbers, so it
        // cannot spill into a neighboring heading/quote or across blank lines.
        for (let lineNum = region.meta.startLine + 1; lineNum <= region.meta.endLine + 1; lineNum++) {
          const line = state.doc.line(lineNum)
          decos.push({ from: line.from, to: line.from, deco: codeBlockDeco, isLine: true })
        }

        if (cursorOn) {
          decos.push({ from: region.meta.open.from, to: region.meta.open.to, deco: fenceMarkVisibleDeco })
        } else {
          // Preview state hides the full fence syntax while keeping the line
          // height. The language label is part of the opening fence syntax.
          decos.push({ from: region.meta.openPrefix.from, to: region.meta.openPrefix.to, deco: fenceMarkHiddenDeco })
        }

        // An unclosed fence has no closing marker to hide or reveal.
        if (region.meta.close) {
          if (cursorOn) {
            decos.push({ from: region.meta.close.from, to: region.meta.close.to, deco: fenceMarkVisibleDeco })
          } else {
            decos.push({ from: region.meta.closePrefix.from, to: region.meta.closePrefix.to, deco: fenceMarkHiddenDeco })
          }
        }
        break
      }
    }
  }

  // Sort decorations by from position, then by whether they are line decorations
  decos.sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from
    // Line decorations should come before mark decorations at the same position
    if (a.isLine && !b.isLine) return -1
    if (!a.isLine && b.isLine) return 1
    return 0
  })

  // Filter out invalid ranges (from >= to for non-line decorations)
  for (const d of decos) {
    if (d.isLine) {
      builder.add(d.from, d.from, d.deco)
    } else if (d.from < d.to) {
      builder.add(d.from, d.to, d.deco)
    }
  }

  return builder.finish()
}

/**
 * The main ViewPlugin that drives live markdown rendering.
 */
export const markdownDecorationPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildDecorations(view)
    }

    update(update) {
      if (!(update.docChanged || update.selectionSet)) return

      // Cursor movement is a decoration-only change. Keep the rendered block at
      // the same viewport position when it expands/collapses. Explicit
      // scroll-into-view (e.g. selection commands) must still be respected.
      const shouldAnchorScroll = !update.docChanged && !update.transactions.some(transaction =>
        transaction.scrollIntoView ||
        transaction.effects.some(effect => effect.is(EditorView.scrollIntoView))
      )
      const anchor = shouldAnchorScroll ? getScrollAnchor(update.view) : null
      this.decorations = buildDecorations(update.view)
      if (anchor) restoreScrollAnchor(update.view, anchor)
    }
  },
  {
    decorations: (v) => v.decorations
  }
)
