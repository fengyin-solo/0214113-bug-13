/**
 * Markdown parser utilities.
 * Parses raw markdown text and identifies syntax regions for decoration.
 *
 * 统一的区域模型：
 * - 每个 region 都有 kind: 'block' | 'inline' 以及半开区间 [from, to)
 * - block 区域额外携带 startLine / endLine（1-based，含首尾行），
 *   命中判定以“选区覆盖的行”为准（见 isRegionActive）
 * - inline 区域命中判定以“选区覆盖的字符区间”为准
 * - 块区间按“行尾 < 换行 < 下一行行首”排列，相邻块、隔空行块的
 *   区间永不相交，展开范围与渲染块严格同起止
 *
 * Each region has: { kind, type, from, to, contentFrom, contentTo, meta }
 * - from/to: full range including syntax markers（半开区间，不含行尾换行）
 * - contentFrom/contentTo: range of the actual content (excluding markers)
 * - meta: additional info (heading level, language, url, etc.)
 */

/**
 * @typedef {Object} MarkdownRegion
 * @property {'block'|'inline'} kind
 * @property {string} type
 * @property {number} from
 * @property {number} to
 * @property {number} contentFrom
 * @property {number} contentTo
 * @property {number} [startLine]
 * @property {number} [endLine]
 * @property {Object} [meta]
 */

// 块级语法行正则 —— 统一允许 CommonMark 规定的 0~3 个前导空格
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const BLOCKQUOTE_RE = /^( {0,3})(>)([ \t]?)/
const UL_RE = /^(\s*)([-*+])\s(.+)$/
const OL_RE = /^(\s*)(\d+)\.\s(.+)$/
const TASK_RE = /^(\s*[-*+]\s)\[([xX ])\]\s(.+)$/

/**
 * Parse a document string and return all markdown regions.
 * 纯函数：不保留任何跨调用状态。撤销（undo/redo）或整体替换文稿时，
 * 围栏开闭与引用分组都从新文稿重新推导，不会出现状态串位。
 * @param {string} doc - The full document text
 * @returns {MarkdownRegion[]}
 */
export function parseMarkdownRegions(doc) {
  const regions = []
  const lines = doc.split('\n')

  // 代码围栏状态 —— 唯一的跨行状态，遇闭合围栏或文稿结束时终结
  let fence = null // { char, markerLen, startLine, startPos, markerFrom, markerTo, lang }

  // 引用块分组状态 —— 连续的 > 行归为同一个 region，空行/非引用行终结
  let quote = null // { lines: [{from,to,markFrom,markTo}], startLine }

  let pos = 0

  const finishQuote = (endLine) => {
    if (!quote) return
    const first = quote.lines[0]
    const last = quote.lines[quote.lines.length - 1]
    regions.push({
      kind: 'block',
      type: 'blockquote',
      from: first.from,
      to: last.to,
      contentFrom: first.from,
      contentTo: last.to,
      startLine: quote.startLine,
      endLine: endLine - 1,
      meta: {
        marks: quote.lines.map(l => ({ from: l.markFrom, to: l.markTo }))
      }
    })
    quote = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineStart = pos
    const lineEnd = pos + line.length
    const lineNo = i + 1

    // ---- 1. 代码围栏：围栏内正文 / 闭合围栏 ----
    if (fence) {
      const fm = line.match(FENCE_RE)
      const isClose = fm
        && fm[1][0] === fence.char
        && fm[1].length >= fence.markerLen
        // CommonMark：闭合围栏之后只允许空白；带文字的围栏行仍是代码正文
        && fm[2].trim() === ''
      if (isClose) {
        const markerFrom = lineStart + line.indexOf(fm[1])
        // 内容终点 = 闭围栏行行首（不含闭围栏前的换行也不含闭围栏本身）
        pushCodeBlock(regions, fence, {
          to: lineEnd,
          contentTo: lineStart,
          endLine: lineNo,
          closeMarker: { from: markerFrom, to: markerFrom + fm[1].length }
        })
        fence = null
      }
      // 围栏内（包括伪闭合行）一律不解析行内语法
      pos = lineEnd + 1
      continue
    }

    // ---- 1b. 开启新围栏 ----
    const fenceMatch = line.match(FENCE_RE)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      const info = fenceMatch[2].trim()
      // CommonMark：反引号围栏的 info string 不允许再含反引号
      const validOpen = marker[0] === '~' || !info.includes('`')
      if (validOpen) {
        finishQuote(lineNo)
        const markerFrom = lineStart + line.indexOf(marker)
        fence = {
          char: marker[0],
          markerLen: marker.length,
          startLine: lineNo,
          startPos: lineStart,
          markerFrom,
          markerTo: markerFrom + marker.length,
          lang: info.split(/\s+/)[0] || ''
        }
        pos = lineEnd + 1
        continue
      }
    }

    // ---- 2. 标题 ----
    const headingMatch = line.match(HEADING_RE)
    if (headingMatch) {
      finishQuote(lineNo)
      const level = headingMatch[1].length
      const markFrom = lineStart
      // 标记范围含 # 与紧随其后的分隔空白（无正文时仅含 #）
      const afterHashes = line.slice(level)
      const contentLead = afterHashes.length - afterHashes.trimStart().length
      const markTo = markFrom + level + (headingMatch[2] !== undefined ? contentLead : 0)
      regions.push({
        kind: 'block',
        type: 'heading',
        from: lineStart,
        to: lineEnd,
        contentFrom: markTo,
        contentTo: lineEnd,
        startLine: lineNo,
        endLine: lineNo,
        meta: { level, markFrom, markTo }
      })
      pos = lineEnd + 1
      continue
    }

    // ---- 3. 分割线 ----
    if (HR_RE.test(line)) {
      finishQuote(lineNo)
      regions.push({
        kind: 'block',
        type: 'hr',
        from: lineStart,
        to: lineEnd,
        contentFrom: lineStart,
        contentTo: lineEnd,
        startLine: lineNo,
        endLine: lineNo,
        meta: {}
      })
      pos = lineEnd + 1
      continue
    }

    // ---- 4. 引用：连续 > 行分组，空行或其它块终结整组 ----
    const bqMatch = line.match(BLOCKQUOTE_RE)
    if (bqMatch) {
      const markFrom = lineStart + bqMatch[1].length
      const markTo = markFrom + 1 + bqMatch[3].length
      if (!quote) quote = { lines: [], startLine: lineNo }
      quote.lines.push({ from: lineStart, to: lineEnd, markFrom, markTo })
      // 引用行内仍可出现列表、加粗、链接等语法（去掉 '> ' 前缀后解析）
      parseListRegions(line.slice(markTo - lineStart), markTo, lineEnd, lineNo, regions)
      parseInlineRegions(line, lineStart, regions)
      pos = lineEnd + 1
      continue
    }
    finishQuote(lineNo)

    // ---- 5. 列表 / 任务列表（task 优先；命中 task 不再产出 ul）----
    parseListRegions(line, lineStart, lineEnd, lineNo, regions)

    // ---- 6. 行内语法（仅围栏外的普通行；标题/分割线行不解析）----
    parseInlineRegions(line, lineStart, regions)

    pos = lineEnd + 1
  }

  // 文稿结束：悬挂的引用封口；未闭合围栏延伸到文稿末尾
  finishQuote(lines.length + 1)
  if (fence) {
    // 未闭合：内容终点即文稿末尾，与闭合围栏走同一套 region 结构
    pushCodeBlock(regions, fence, {
      to: doc.length,
      contentTo: doc.length,
      endLine: lines.length,
      closeMarker: null
    })
  }

  return regions
}

/**
 * 生成 code-block region。闭合与未闭合（延伸至文稿末尾）走完全
 * 相同的结构与边界规则，仅终点不同。
 */
function pushCodeBlock(regions, fence, { to, contentTo, endLine, closeMarker }) {
  regions.push({
    kind: 'block',
    type: 'code-block',
    from: fence.startPos,
    to,
    contentFrom: fence.markerTo + 1,
    contentTo,
    startLine: fence.startLine,
    endLine,
    meta: {
      language: fence.lang,
      closed: closeMarker !== null,
      fenceChar: fence.char,
      markerLen: fence.markerLen,
      openMarker: { from: fence.markerFrom, to: fence.markerTo },
      closeMarker
    }
  })
}

/**
 * 解析单行上的列表结构（任务列表 / 无序 / 有序）。
 * @param {string} text  该行中参与列表判定的文本（引用行可传去掉 '> ' 的后缀）
 * @param {number} base  text 首字符在全文中的绝对位置
 * @param {number} lineEnd 该行行尾绝对位置
 * @param {number} lineNo 行号（1-based）
 */
function parseListRegions(text, base, lineEnd, lineNo, regions) {
  // 任务列表优先；命中后不再产出普通无序列表，避免 dash 标记重复
  const taskMatch = text.match(TASK_RE)
  if (taskMatch) {
    const checkStart = base + taskMatch[1].length
    regions.push({
      kind: 'block',
      type: 'task-list',
      from: base,
      to: lineEnd,
      contentFrom: checkStart + 4,
      contentTo: lineEnd,
      startLine: lineNo,
      endLine: lineNo,
      meta: {
        checked: taskMatch[2].toLowerCase() === 'x',
        checkFrom: checkStart,
        checkTo: checkStart + 3,
        bulletFrom: base + taskMatch[1].indexOf(taskMatch[1].trim())
      }
    })
    return
  }

  const ulMatch = text.match(UL_RE)
  if (ulMatch) {
    const indent = ulMatch[1].length
    const markerStart = base + indent
    regions.push({
      kind: 'block',
      type: 'list-bullet',
      from: base,
      to: lineEnd,
      contentFrom: markerStart + 2,
      contentTo: lineEnd,
      startLine: lineNo,
      endLine: lineNo,
      meta: { marker: ulMatch[2], markerFrom: markerStart, markerTo: markerStart + 1, indent }
    })
    return
  }

  const olMatch = text.match(OL_RE)
  if (olMatch) {
    const indent = olMatch[1].length
    const markerStart = base + indent
    const markerEnd = markerStart + olMatch[2].length + 1
    regions.push({
      kind: 'block',
      type: 'list-ordered',
      from: base,
      to: lineEnd,
      contentFrom: markerEnd + 1,
      contentTo: lineEnd,
      startLine: lineNo,
      endLine: lineNo,
      meta: { number: olMatch[2], markerFrom: markerStart, markerTo: markerEnd, indent }
    })
  }
}

/**
 * Parse inline markdown patterns within a single line.
 */
function parseInlineRegions(line, lineStart, regions) {
  // Image: ![alt](url)
  const imgRe = /!\[([^\]]*)\]\(([^)]+)\)/g
  let m
  while ((m = imgRe.exec(line)) !== null) {
    regions.push({
      kind: 'inline',
      type: 'image',
      from: lineStart + m.index,
      to: lineStart + m.index + m[0].length,
      contentFrom: lineStart + m.index + 2,
      contentTo: lineStart + m.index + 2 + m[1].length,
      meta: { alt: m[1], url: m[2] }
    })
  }

  // Link: [text](url) — but not images
  const linkRe = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g
  while ((m = linkRe.exec(line)) !== null) {
    regions.push({
      kind: 'inline',
      type: 'link',
      from: lineStart + m.index,
      to: lineStart + m.index + m[0].length,
      contentFrom: lineStart + m.index + 1,
      contentTo: lineStart + m.index + 1 + m[1].length,
      meta: { text: m[1], url: m[2] }
    })
  }

  // Bold: **text** or __text__
  const boldRe = /(\*\*|__)(?!\s)(.+?)(?<!\s)\1/g
  while ((m = boldRe.exec(line)) !== null) {
    regions.push({
      kind: 'inline',
      type: 'bold',
      from: lineStart + m.index,
      to: lineStart + m.index + m[0].length,
      contentFrom: lineStart + m.index + 2,
      contentTo: lineStart + m.index + 2 + m[2].length,
      meta: { marker: m[1] }
    })
  }

  // Italic: *text* or _text_ (not bold)
  const italicRe = /(?<!\*|\w)(\*|_)(?!\s|\1)(.+?)(?<!\s)\1(?!\*|\w)/g
  while ((m = italicRe.exec(line)) !== null) {
    // Skip if this is part of a bold marker
    const fullFrom = lineStart + m.index
    const isBold = regions.some(r => r.type === 'bold' && r.from <= fullFrom && r.to >= fullFrom + m[0].length)
    if (isBold) continue
    regions.push({
      kind: 'inline',
      type: 'italic',
      from: fullFrom,
      to: fullFrom + m[0].length,
      contentFrom: fullFrom + 1,
      contentTo: fullFrom + 1 + m[2].length,
      meta: { marker: m[1] }
    })
  }

  // Strikethrough: ~~text~~
  const strikeRe = /~~(?!\s)(.+?)(?<!\s)~~/g
  while ((m = strikeRe.exec(line)) !== null) {
    regions.push({
      kind: 'inline',
      type: 'strikethrough',
      from: lineStart + m.index,
      to: lineStart + m.index + m[0].length,
      contentFrom: lineStart + m.index + 2,
      contentTo: lineStart + m.index + 2 + m[1].length,
      meta: {}
    })
  }

  // Inline code: `code`
  const codeRe = /(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g
  while ((m = codeRe.exec(line)) !== null) {
    const markerLen = m[1].length
    regions.push({
      kind: 'inline',
      type: 'inline-code',
      from: lineStart + m.index,
      to: lineStart + m.index + m[0].length,
      contentFrom: lineStart + m.index + markerLen,
      contentTo: lineStart + m.index + markerLen + m[2].length,
      meta: { markerLen }
    })
  }
}

/**
 * 统一的“是否展开（编辑态）”判定。
 *
 * 判定条件（block 与 inline 共用同一条半开区间求交规则，只是粒度不同）：
 * - block 区域：与任一选区覆盖到的“行”求交（region.startLine..endLine）
 * - inline 区域：与任一选区的“字符区间”求交（[sel.from, sel.to)）
 *
 * 半开区间求交：fromA < toB && fromB < toA。
 * 这样：
 * - 光标在行首/行尾只会命中当前行，不会串到相邻块
 * - 相邻块（如 # 标题紧挨 > 引用）区间不相交，只展开命中的那一个
 * - 隔空行的块互不影响；空行本身不属于任何 region，保持预览
 * - 未识别的普通段落不出现在 regions 中，天然保持预览
 *
 * @param {MarkdownRegion} region
 * @param {{from:number,to:number,startLine:number,endLine:number}[]} selectionRanges
 *        选区数组（每个已预先带上覆盖的起止行号）
 * @returns {boolean}
 */
export function isRegionActive(region, selectionRanges) {
  if (!selectionRanges.length) return false
  if (region.kind === 'block') {
    return selectionRanges.some(s =>
      region.startLine <= s.endLine && s.startLine <= region.endLine
    )
  }
  return selectionRanges.some(s =>
    region.from < s.to && s.from < region.to
  )
}

/**
 * Check if a position falls within any region.
 * @param {MarkdownRegion[]} regions
 * @param {number} pos
 * @returns {MarkdownRegion|null}
 */
export function regionAtPos(regions, pos) {
  return regions.find(r => pos >= r.from && pos <= r.to) || null
}

/**
 * Check if a range overlaps with a region.
 * 保留旧导出名的兼容包装，内部统一走半开区间求交。
 * @param {MarkdownRegion} region
 * @param {number} lineFrom
 * @param {number} lineTo
 * @returns {boolean}
 */
export function cursorOnRegion(region, lineFrom, lineTo) {
  return region.from < lineTo && lineFrom < region.to
}
