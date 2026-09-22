import { parseMarkdownRegions, isRegionActive } from '../src/editor/markdown-parser.js'

let pass = 0, fail = 0
function check(name, cond, extra='') {
  if (cond) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, extra) }
}

const doc1 = '# H\n\n```\na\nb\n```\n\n> q1\n> q2\n\npara'
const r1 = parseMarkdownRegions(doc1)
const cb = r1.find(r => r.type === 'code-block')
const bq = r1.find(r => r.type === 'blockquote')
const hd = r1.find(r => r.type === 'heading')
const closeAt = doc1.indexOf('```', 6)
check('code block boundaries', cb.from === 5 && cb.to === closeAt + 3, `${cb.from}..${cb.to} closeAt=${closeAt}`)
check('code block lines', cb.startLine === 3 && cb.endLine === 6)
check('code block closed', cb.meta.closed === true)
check('code content excludes fences', cb.contentFrom === doc1.indexOf('a') && cb.contentTo === closeAt, `${cb.contentFrom}..${cb.contentTo}`)
check('quote grouped across adjacent > lines', bq.startLine === 8 && bq.endLine === 9)
check('quote marks collected per line', bq.meta.marks.length === 2)
check('heading single line', hd.startLine === 1 && hd.endLine === 1)

// unclosed —— 注意 d2 末尾换行形成第4个空行
const d2 = 'text\n\n```\nx\n'
const r2 = parseMarkdownRegions(d2)
const u = r2.find(r => r.type === 'code-block')
check('unclosed fence reaches EOF', u && u.to === d2.length && u.meta.closed === false)
check('unclosed fence endLine includes trailing empty line (CommonMark)', u.endLine === 5, `endLine=${u.endLine}`)
// 无末尾换行时
const r2b = parseMarkdownRegions('text\n\n```\nx')
check('unclosed fence endLine no trailing NL', r2b.find(r=>r.type==='code-block').endLine === 4, 'endLine=' + r2b.find(r=>r.type==='code-block').endLine)

const r3 = parseMarkdownRegions('```\ncode\n``` tail\nmore\n```')
check('trailing-text fence not closing', r3.filter(r=>r.type==='code-block').length === 1 && r3[0].to === '```\ncode\n``` tail\nmore\n```'.length)

check('tilde fence', parseMarkdownRegions('~~~\nx\n~~~')[0].meta.closed)
check('tilde does not close backtick', parseMarkdownRegions('```\n~~~\n```')[0].to === '```\n~~~\n```'.length)
check('shorter fence not closing', parseMarkdownRegions('````\nx\n```\n````')[0].endLine === 4)
check('inline kind', parseMarkdownRegions('a **b** c').some(r => r.type==='bold' && r.kind==='inline'))
check('plain text has no regions', parseMarkdownRegions('just a plain paragraph\n\nanother').length === 0)
check('4-space indent no fence', parseMarkdownRegions('    ```\n    x\n    ```').length === 0)
check('hr only', (() => { const r = parseMarkdownRegions('---'); return r.length === 1 && r[0].type === 'hr' })())

const r11 = parseMarkdownRegions('##  Title  ')
check('heading mark includes separating spaces (two spaces here)', r11[0].meta.markFrom === 0 && r11[0].meta.markTo === 4,
  `markTo=${r11[0].meta.markTo}`)
check('heading mark single space', parseMarkdownRegions('## Title')[0].meta.markTo === 3)
check('heading without trailing space', parseMarkdownRegions('# H')[0].meta.markTo === 2)
check('empty heading only hashes mark', parseMarkdownRegions('##')[0].meta.markTo === 2)

// --- isRegionActive ---
const da = '# H\n\n> q1\n> q2'
const ra = parseMarkdownRegions(da)
const h = ra.find(r=>r.type==='heading'), q = ra.find(r=>r.type==='blockquote')
const sel = (sl, el) => [{from:0,to:0,startLine:sl,endLine:el}]
check('caret heading activates only heading', isRegionActive(h, sel(1,1)) && !isRegionActive(q, sel(1,1)))
check('caret blank line activates nothing', !isRegionActive(h, sel(2,2)) && !isRegionActive(q, sel(2,2)))
check('caret quote line 3 activates whole quote group', isRegionActive(q, sel(3,3)) && !isRegionActive(h, sel(3,3)))
check('caret quote line 4 also activates group', isRegionActive(q, sel(4,4)))
check('selection spanning blocks activates both', isRegionActive(h, sel(1,3)) && isRegionActive(q, sel(1,3)))

const db = 'a **bold** c'
const bold = parseMarkdownRegions(db).find(r=>r.type==='bold')
const selPos = (a,b) => [{from:a,to:b,startLine:1,endLine:1}]
check('caret inside bold active', isRegionActive(bold, selPos(3,3)))
check('caret outside bold inactive', !isRegionActive(bold, selPos(0,0)))
check('caret exactly at marker start inactive (half-open)', !isRegionActive(bold, selPos(2,2)))
check('caret at content start active', isRegionActive(bold, selPos(4,4)))
check('caret at end boundary inactive', !isRegionActive(bold, selPos(10,10)))
check('selection covering bold active', isRegionActive(bold, selPos(0,11)))

const rc = parseMarkdownRegions('**a** and *b*')
const b2 = rc.find(r=>r.type==='bold'), i2 = rc.find(r=>r.type==='italic')
check('only hit inline expands', isRegionActive(b2, selPos(1,1)) && !isRegionActive(i2, selPos(1,1)))
check('no selections -> inactive', !isRegionActive(bold, []))

// 混合结构：引用里的加粗，引用展开时加粗按行内区间独立判定
const dmix = '> **bold** text'
const rmix = parseMarkdownRegions(dmix)
const qmix = rmix.find(r=>r.type==='blockquote'), bmix = rmix.find(r=>r.type==='bold')
check('mixed: block caret on line activates quote', isRegionActive(qmix, sel(1,1)))
check('mixed: inline only active when caret inside it', !isRegionActive(bmix, selPos(0,0)) && isRegionActive(bmix, selPos(4,4)))

// 未闭合块可展开
const ruc = parseMarkdownRegions('```\nx')
const uc = ruc.find(r=>r.type==='code-block')
check('unclosed block can be active', isRegionActive(uc, sel(1,2)) && !isRegionActive(uc, sel(3,3)))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
