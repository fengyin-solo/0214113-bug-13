/**
 * Markdown parser utilities.
 * Parses raw markdown text and identifies syntax regions for decoration.
 *
 * Each region has: { type, from, to, contentFrom, contentTo, meta }
 * - from/to: full range including syntax markers
 * - contentFrom/contentTo: range of the actual content (excluding markers)
 * - meta: additional info (heading level, language, url, etc.)
 */

/**
 * @typedef {Object} MarkdownRegion
 * @property {string} type
 * @property {number} from
 * @property {number} to
 * @property {number} contentFrom
 * @property {number} contentTo
 * @property {Object} [meta]
 */

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const CLOSE_FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const BACKTICK_CLOSE_FENCE_RE = /^ {0,3}(`{3,})$/
const HEADING_RE = /^(#{1,6})(?=[ \t]|$)[ \t]*(.*)$/
const HR_RE = /^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/
const BLOCKQUOTE_RE = /^ {0,3}(>(?:[ \t]?|$))(.*)$/
const UL_RE = /^(\s*)([-*+])(?:[ \t]+(.*))?$/
const OL_RE = /^(\s*)(\d+)(\.)(?:[ \t]+(.*))?$/
const TASK_RE = /^(\s*[-*+][ \t]+)(\[[xX ]\])(?:[ \t]+(.*))?$/

/**
 * Parse a document string and return all markdown regions.
 *
 * Block regions (heading, blockquote and fenced code) are the only regions
 * whose edit state follows the cursor. Their boundaries are always resolved
 * as complete line ranges; blank lines never bridge two block regions.
 *
 * @param {string} doc - The full document text
 * @returns {MarkdownRegion[]}
 */
export function parseMarkdownRegions(doc) {
  const regions = []
  const lines = doc.split('\n')
  const lineStarts = [0]
  for (const line of lines) {
    lineStarts.push(lineStarts[lineStarts.length - 1] + line.length + 1)
  }
  // Text#split('\n') adds a synthetic empty item for a document ending in a
  // newline. It is a position, not a line, and must not receive block styles.
  const lineCount = doc.endsWith('\n') ? lines.length - 1 : lines.length

  let i = 0
  while (i < lineCount) {
    const line = lines[i]
    const lineStart = lineStarts[i]
    const lineEnd = lineStart + line.length

    const fence = line.match(FENCE_RE)
    if (fence) {
      const marker = fence[1]
      const markerChar = marker[0]
      const markerLen = marker.length
      const language = fence[2].trim()
      let closeIndex = -1
      let closeMarkerLen = 0

      for (let j = i + 1; j < lineCount; j++) {
        const closeMatch = lines[j].match(markerChar === '`'
          ? BACKTICK_CLOSE_FENCE_RE
          : CLOSE_FENCE_RE)
        if (
          closeMatch &&
          closeMatch[1][0] === markerChar &&
          closeMatch[1].length >= markerLen
        ) {
          closeIndex = j
          closeMarkerLen = closeMatch[1].length
          break
        }
      }

      const lastIndex = closeIndex === -1 ? lineCount - 1 : closeIndex
      const bodyEnd = closeIndex === -1 ? lastIndex : Math.max(i, closeIndex - 1)
      const lastMeaningfulIndex = findLastMeaningfulLine(lines, i + 1, bodyEnd)
      const endLine = closeIndex === -1 ? lineCount - 1 : closeIndex
      const to = lineStarts[endLine] + lines[endLine].length
      const contentFrom = lineStart + fence[0].length
      const contentTo = closeIndex === -1
        ? to
        : Math.max(contentFrom, lineStarts[closeIndex])
      const opening = fence[0].match(/(`{3,}|~{3,})/)
      let closing = null
      if (closeIndex !== -1) {
        closing = lines[closeIndex].match(/(`{3,}|~{3,})/)
      }

      regions.push({
        type: 'code-block',
        from: lineStart,
        to,
        contentFrom,
        contentTo,
        meta: {
          scope: 'block',
          language,
          startLine: i,
          endLine,
          lastContentLine: lastMeaningfulIndex,
          open: {
            from: lineStart + opening.index,
            to: lineStart + opening.index + opening[1].length
          },
          openPrefix: {
            from: lineStart,
            to: contentFrom
          },
          close: closeIndex === -1
            ? null
            : {
                from: lineStarts[closeIndex] + closing.index,
                to: lineStarts[closeIndex] + closing.index + closing[1].length
              },
          closePrefix: closeIndex === -1
            ? null
            : {
                from: lineStarts[closeIndex],
                to: lineStarts[closeIndex] + lines[closeIndex].length
              }
        }
      })

      i = lastIndex + 1
      continue
    }

    if (BLOCKQUOTE_RE.test(line)) {
      const startLine = i
      let endLine = i
      const marks = []

      do {
        const match = lines[endLine].match(BLOCKQUOTE_RE)
        const start = lineStarts[endLine]
        marks.push({
          from: start + match[1].indexOf('>'),
          to: start + match[1].lastIndexOf('>') + 1
        })
        parseInlineRegions(lines[endLine], lineStarts[endLine], regions)
        endLine++
      } while (endLine < lineCount && BLOCKQUOTE_RE.test(lines[endLine]))

      regions.push({
        type: 'blockquote',
        from: lineStarts[startLine],
        to: lineStarts[endLine - 1] + lines[endLine - 1].length,
        contentFrom: lineStarts[startLine],
        contentTo: lineStarts[endLine - 1] + lines[endLine - 1].length,
        meta: {
          scope: 'block',
          startLine,
          endLine: endLine - 1,
          marks
        }
      })

      i = endLine
      continue
    }

    const heading = line.match(HEADING_RE)
    if (heading) {
      const level = heading[1].length
      const contentText = heading[2] ?? ''
      const leadingSpaceEnd = lineStart + level + line.slice(level, line.length - contentText.length).length
      const contentFrom = lineStart + line.length - contentText.length
      const contentTo = contentFrom + contentText.length

      regions.push({
        type: 'heading',
        from: lineStart,
        to: lineEnd,
        contentFrom,
        contentTo,
        meta: {
          scope: 'block',
          level,
          line: i,
          startLine: i,
          endLine: i,
          markFrom: lineStart,
          markTo: leadingSpaceEnd
        }
      })
      if (contentText) parseInlineRegions(contentText, contentFrom, regions)

      i++
      continue
    }

    if (HR_RE.test(line)) {
      regions.push({
        type: 'hr',
        from: lineStart,
        to: lineEnd,
        contentFrom: lineStart,
        contentTo: lineEnd,
        meta: { scope: 'inline' }
      })
      i++
      continue
    }

    parseContainerLine(line, lineStart, regions)
    i++
  }

  regions.sort((a, b) => a.from - b.from || a.to - b.to)
  return regions
}

function findLastMeaningfulLine(lines, start, fallback) {
  for (let i = fallback; i >= start; i--) {
    if (lines[i].length > 0) return i
  }
  return start - 1
}

/**
 * Parse list and task markers on one non-block line, followed by inline syntax.
 */
function parseContainerLine(line, lineStart, regions) {
  const taskMatch = line.match(TASK_RE)
  if (taskMatch) {
    const prefix = taskMatch[1]
    const checkbox = taskMatch[2]
    const contentText = taskMatch[3] ?? ''
    const checkFrom = lineStart + prefix.length
    const checkTo = checkFrom + checkbox.length

    regions.push({
      type: 'task-list',
      from: lineStart,
      to: lineStart + line.length,
      contentFrom: checkTo + (contentText ? 1 : 0),
      contentTo: lineStart + line.length,
      meta: {
        scope: 'inline',
        checked: checkbox[1].toLowerCase() === 'x',
        checkFrom,
        checkTo
      }
    })
  }

  const ulMatch = line.match(UL_RE)
  if (ulMatch) {
    const indent = ulMatch[1].length
    const markerStart = lineStart + indent

    regions.push({
      type: 'list-bullet',
      from: lineStart,
      to: lineStart + line.length,
      contentFrom: markerStart + 2,
      contentTo: lineStart + line.length,
      meta: {
        scope: 'inline',
        marker: ulMatch[2],
        markerFrom: markerStart,
        markerTo: markerStart + 1,
        indent
      }
    })
  }

  const olMatch = line.match(OL_RE)
  if (olMatch) {
    const indent = olMatch[1].length
    const markerStart = lineStart + indent
    const markerEnd = markerStart + olMatch[2].length + olMatch[3].length

    regions.push({
      type: 'list-ordered',
      from: lineStart,
      to: lineStart + line.length,
      contentFrom: markerEnd + 1,
      contentTo: lineStart + line.length,
      meta: {
        scope: 'inline',
        number: olMatch[2],
        markerFrom: markerStart,
        markerTo: markerEnd,
        indent
      }
    })
  }

  parseInlineRegions(line, lineStart, regions)
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
      type: 'image',
      from: lineStart + m.index,
      to: lineStart + m.index + m[0].length,
      contentFrom: lineStart + m.index + 2,
      contentTo: lineStart + m.index + 2 + m[1].length,
      meta: { scope: 'inline', alt: m[1], url: m[2] }
    })
  }

  // Link: [text](url) — but not images
  const linkRe = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g
  while ((m = linkRe.exec(line)) !== null) {
    regions.push({
      type: 'link',
      from: lineStart + m.index,
      to: lineStart + m.index + m[0].length,
      contentFrom: lineStart + m.index + 1,
      contentTo: lineStart + m.index + 1 + m[1].length,
      meta: { scope: 'inline', text: m[1], url: m[2] }
    })
  }

  // Bold: **text** or __text__
  const boldRe = /(\*\*|__)(?!\s)(.+?)(?<!\s)\1/g
  while ((m = boldRe.exec(line)) !== null) {
    regions.push({
      type: 'bold',
      from: lineStart + m.index,
      to: lineStart + m.index + m[0].length,
      contentFrom: lineStart + m.index + 2,
      contentTo: lineStart + m.index + 2 + m[2].length,
      meta: { scope: 'inline', marker: m[1] }
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
      type: 'italic',
      from: fullFrom,
      to: fullFrom + m[0].length,
      contentFrom: fullFrom + 1,
      contentTo: fullFrom + 1 + m[2].length,
      meta: { scope: 'inline', marker: m[1] }
    })
  }

  // Strikethrough: ~~text~~
  const strikeRe = /~~(?!\s)(.+?)(?<!\s)~~/g
  while ((m = strikeRe.exec(line)) !== null) {
    regions.push({
      type: 'strikethrough',
      from: lineStart + m.index,
      to: lineStart + m.index + m[0].length,
      contentFrom: lineStart + m.index + 2,
      contentTo: lineStart + m.index + 2 + m[1].length,
      meta: { scope: 'inline' }
    })
  }

  // Inline code: `code`
  const codeRe = /(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g
  while ((m = codeRe.exec(line)) !== null) {
    const markerLen = m[1].length
    regions.push({
      type: 'inline-code',
      from: lineStart + m.index,
      to: lineStart + m.index + m[0].length,
      contentFrom: lineStart + m.index + markerLen,
      contentTo: lineStart + m.index + markerLen + m[2].length,
      meta: { scope: 'inline', markerLen }
    })
  }
}

/**
 * Return the selection line ranges used to determine whether a block region
 * is active. A block starts/ends on line boundaries, so a cursor immediately
 * before or after it does not activate that block.
 */
export function getSelectionLineRanges(state) {
  return state.selection.ranges.map(range => {
    const startLine = state.doc.lineAt(range.from)
    const endLine = state.doc.lineAt(range.to)
    return {
      from: startLine.from,
      to: endLine.to,
      startNumber: startLine.number,
      endNumber: endLine.number
    }
  })
}

/**
 * Determine whether a region is selected.
 *
 * Block regions are checked by complete line number. Inline regions use range
 * intersection. This keeps adjacent headings, blockquotes and fences from
 * expanding across blank lines or into neighboring blocks.
 */
export function isRegionSelected(region, selectionRanges, doc) {
  if (region.meta?.scope === 'block') {
    const startNumber = region.meta.startLine ?? region.meta.line
    const endNumber = region.meta.endLine ?? region.meta.line
    return selectionRanges.some(range => {
      const rangeStart = range.startNumber ?? doc.lineAt(range.from).number
      const rangeEnd = range.endNumber ?? doc.lineAt(range.to).number
      return rangeStart <= endNumber && rangeEnd >= startNumber
    })
  }

  return selectionRanges.some(range => region.from <= range.to && region.to >= range.from)
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
 * Check whether a character range overlaps a region.
 * New callers that need block-aware line matching should use isRegionSelected.
 *
 * @param {MarkdownRegion} region
 * @param {number} from
 * @param {number} [to]
 * @returns {boolean}
 */
export function cursorOnRegion(region, lineFrom, lineTo = lineFrom) {
  return region.from <= lineTo && region.to >= lineFrom
}
