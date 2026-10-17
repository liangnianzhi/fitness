import test from 'node:test'
import assert from 'node:assert/strict'

import {
  cnDate,
  cnDateFull,
  cnMonth,
  coachLine,
  currentProgress,
  isChecked,
  isoWeek,
  monthDetail,
  monthGrid,
  monthKey,
  monthReview,
  parseYmd,
  rangeKeys,
  startOfWeek,
  statsFor,
  streak,
  weekDetail,
  weekKey,
  weekReview,
  ymd,
} from '../public/analysis.js'
import { markDay, mergeStates, unmarkDay, emptyState } from '../public/store.js'

/** 时间戳种子：跨 build() 调用单调递增，保证「后建的状态更新」 */
let tSeed = 1000

/** 造一个有打卡记录的状态：{ '2026-10-05': { mins, kind } } */
function build(entries) {
  let s = emptyState()
  for (const [key, patch] of Object.entries(entries)) {
    s = markDay(s, key, { t: (tSeed += 1000), mins: patch.mins, name: patch.name })
  }
  return s
}

test('日期基础：解析与格式化', () => {
  assert.equal(ymd(new Date(2026, 9, 17)), '2026-10-17')
  assert.equal(ymd(parseYmd('2026-10-17')), '2026-10-17')
  assert.equal(cnDate('2026-10-17'), '2026/10/17')
  assert.equal(cnMonth('2026-10'), '2026年10月')
  assert.equal(cnMonth('2026-01'), '2026年1月')
  assert.equal(cnDateFull('2026-10-17'), '10月17日 周六')
})

test('周起点：周一为一周之始，跨月跨年都正确', () => {
  assert.equal(ymd(startOfWeek(new Date(2026, 9, 17))), '2026-10-12') // 周六 -> 本周一
  assert.equal(ymd(startOfWeek(new Date(2026, 9, 12))), '2026-10-12') // 周一 -> 自身
  assert.equal(ymd(startOfWeek(new Date(2026, 9, 18))), '2026-10-12') // 周日 -> 本周一（不是下周一）
  assert.equal(ymd(startOfWeek(new Date(2026, 0, 1))), '2025-12-29')
})

test('ISO 周序号：跨年周归属周四所在年份', () => {
  assert.deepEqual(isoWeek(new Date(2026, 9, 17)), { year: 2026, week: 42 })
  assert.equal(weekKey(new Date(2026, 9, 17)), '2026-W42')
  assert.equal(weekKey(new Date(2025, 11, 29)), '2026-W01') // 周一，属于 2026 年第 1 周
  assert.equal(weekKey(new Date(2026, 0, 4)), '2026-W01') // 周日，仍是第 1 周
  assert.equal(weekKey(new Date(2026, 0, 5)), '2026-W02')
  assert.equal(weekKey(new Date(2026, 0, 1)), '2026-W01')
})

test('月键与日期区间', () => {
  assert.equal(monthKey(new Date(2026, 9, 17)), '2026-10')
  assert.equal(rangeKeys('2026-10-05', '2026-10-11').length, 7)
  assert.equal(rangeKeys('2026-02-27', '2026-03-02').join(','), '2026-02-27,2026-02-28,2026-03-01,2026-03-02')
})

test('月视图网格：周一对齐、6 行、跨月标记正确', () => {
  const grid = monthGrid(new Date(2026, 9, 1))
  assert.equal(grid[0].key, '2026-09-28') // 2026-10-01 是周四，前面补到周一
  assert.equal(grid[0].inMonth, false)
  assert.equal(grid.length % 7, 0)
  const inMonth = grid.filter((c) => c.inMonth)
  assert.equal(inMonth.length, 31)
  assert.equal(inMonth[0].key, '2026-10-01')
  assert.equal(inMonth[30].key, '2026-10-31')
})

test('打卡状态：取消打卡时间更新则视为未打卡（多设备 last-write-wins）', () => {
  let s = build({ '2026-10-17': { mins: 45 } })
  assert.equal(isChecked(s, '2026-10-17'), true)
  s = unmarkDay(s, '2026-10-17')
  assert.equal(isChecked(s, '2026-10-17'), false)
  s = markDay(s, '2026-10-17', { t: Date.now() + 100000 })
  assert.equal(isChecked(s, '2026-10-17'), true)
})

test('区间统计：次数、时长、项目分布', () => {
  const s = build({
    '2026-10-05': { mins: 30, name: '跑步机' },
    '2026-10-07': { mins: 45, name: '团操' },
    '2026-10-11': { mins: 20, name: '跑步机' },
    '2026-10-20': { mins: 60, name: '跑步机' }, // 区间外
  })
  const st = statsFor(s, '2026-10-05', '2026-10-11')
  assert.equal(st.count, 3)
  assert.equal(st.minutes, 95)
  assert.deepEqual(st.byKind, { 跑步机: 2, 团操: 1 })
  assert.equal(st.days.filter((d) => d.checked).length, 3)
  assert.equal(st.days.length, 7)
})

test('上周回顾：给出次数、目标、与前一周的差值', () => {
  // 今天是 2026-10-17（周六，W42）；上周 = 10-05 ~ 10-11（W41）
  const s = build({
    '2026-10-05': { mins: 30 },
    '2026-10-07': { mins: 30 },
    '2026-10-09': { mins: 30 },
    '2026-10-11': { mins: 30 },
    '2026-09-28': { mins: 30 }, // 前一周（W40）1 次
  })
  const r = weekReview(s, '2026-10-17')
  assert.equal(r.type, 'week')
  assert.equal(r.periodKey, '2026-W41')
  assert.equal(r.label, '2026/10/05 – 2026/10/11')
  assert.equal(r.count, 4)
  assert.equal(r.goal, 3)
  assert.equal(r.prevCount, 1)
  assert.equal(r.delta, 3)
  assert.match(r.text, /上周打卡 4 次/)
  assert.ok(r.text.split(/[。！？]/).filter((x) => x.trim()).length <= 2, `最多两句话: ${r.text}`)
})

test('教练文案：四档强度都说人话且不超过两句', () => {
  const goal = 3
  const cases = [
    { count: 5, expect: /超额|达成/ },
    { count: 2, expect: /略松懈/ },
    { count: 1, expect: /比较多/ },
    { count: 0, expect: /一次都没打卡/ },
  ]
  for (const c of cases) {
    const text = coachLine({ type: 'week', unit: '上周', count: c.count, goal, prevCount: 3, delta: c.count - 3, hasPrevData: true, empty: c.count === 0 })
    assert.match(text, c.expect, `count=${c.count} -> ${text}`)
    assert.ok(text.split(/[。！？]/).filter((x) => x.trim()).length <= 2, `最多两句话: ${text}`)
    assert.ok(text.length <= 90, `文案别太长: ${text}`)
  }
})

test('上月回顾：按月聚合', () => {
  const s = build({
    '2026-09-02': { mins: 30 },
    '2026-09-09': { mins: 30 },
    '2026-09-16': { mins: 30 },
    '2026-08-05': { mins: 30 },
  })
  const r = monthReview(s, '2026-10-17')
  assert.equal(r.periodKey, '2026-09')
  assert.equal(r.label, '2026年9月')
  assert.equal(r.count, 3)
  assert.equal(r.prevCount, 1)
  assert.match(r.text, /上月/)
})

test('连续打卡：当前连续与历史最长', () => {
  const s = build({
    '2026-10-14': { mins: 30 },
    '2026-10-15': { mins: 30 },
    '2026-10-16': { mins: 30 },
    '2026-10-17': { mins: 30 },
    '2026-09-01': { mins: 30 },
    '2026-09-02': { mins: 30 },
  })
  assert.deepEqual(streak(s, '2026-10-17'), { current: 4, best: 4 })
  // 今天没打卡时，从昨天往前算，不算断
  assert.equal(streak(s, '2026-10-18').current, 4)
  // 断档后重新计数
  assert.equal(streak(s, '2026-10-20').current, 0)
})

test('周明细与进行中进度', () => {
  const s = build({ '2026-10-12': { mins: 30 }, '2026-10-14': { mins: 45 } })
  const w = weekDetail(s, '2026-10-17')
  assert.equal(w.startKey, '2026-10-12')
  assert.equal(w.endKey, '2026-10-18')
  assert.equal(w.count, 2)
  const p = currentProgress(s, '2026-10-17')
  assert.equal(p.weekGoal, 3)
  assert.equal(p.weekRemain, 1)
  assert.equal(p.remainDays, 2) // 17、18
  assert.match(p.hint, /还差 1 次/)
  assert.equal(currentProgress(build({ '2026-10-12': {}, '2026-10-13': {}, '2026-10-14': {} }), '2026-10-17').hint, '本周目标已完成')
})

test('月明细：天数与统计', () => {
  const s = build({ '2026-10-01': { mins: 30 }, '2026-10-31': { mins: 30 } })
  const m = monthDetail(s, '2026-10-17')
  assert.equal(m.keys.length, 31)
  assert.equal(m.count, 2)
  assert.equal(m.minutes, 60)
})

test('月合并：按天取最新，设置按 settingsAt 取最新', () => {
  const a = mergeStates(
    build({ '2026-10-01': { mins: 30 } }),
    build({ '2026-10-01': { mins: 90 }, '2026-10-02': { mins: 30 } })
  )
  assert.equal(a.marks['2026-10-01'].mins, 90)
  assert.equal(a.marks['2026-10-02'].mins, 30)
  assert.equal(Object.keys(a.marks).length, 2)
})

test('页面元素选择器都能命中：app.js 里 $("…") 的 id 必须存在于 index.html', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const path = await import('node:path')
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const html = readFileSync(path.join(root, 'public/index.html'), 'utf8')
  const js = readFileSync(path.join(root, 'public/app.js'), 'utf8')

  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))
  const used = new Set([...js.matchAll(/\$\('([A-Za-z][\w-]*)'\)/g)].map((m) => m[1]))
  const missing = [...used].filter((id) => !ids.has(id))
  assert.deepEqual(missing, [], `index.html 缺少这些 id: ${missing.join(', ')}`)
  assert.ok(used.size > 10, '应该检查到足够多的元素')
})

test('HTML 里引用的本地资源都存在', async () => {
  const { readFileSync, existsSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const path = await import('node:path')
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const html = readFileSync(path.join(root, 'public/index.html'), 'utf8')
  const refs = [...html.matchAll(/(?:href|src)="\.\/([^"]+)"/g)].map((m) => m[1])
  assert.ok(refs.length >= 4)
  for (const ref of refs) {
    assert.ok(existsSync(path.join(root, 'public', ref)), `缺少资源: ${ref}`)
  }
})

test('page-agent 的分析管道：history → 最终文案', async () => {
  const { fileURLToPath } = await import('node:url')
  const path = await import('node:path')
  const { readFileSync } = await import('node:fs')
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const source = readFileSync(path.join(root, 'public/app.js'), 'utf8')

  // 从源码里抽出两个纯函数来验证（它们不依赖 DOM）
  const start = source.indexOf('function extractFinalText')
  const end = source.indexOf('/** 手动触发 AI 分析')
  assert.ok(start > 0 && end > start, '找不到 extractFinalText / cleanAgentText')
  const code = source.slice(start, end)
  const factory = new Function(`${code}; return { extractFinalText, cleanAgentText }`)
  const { extractFinalText, cleanAgentText } = factory()

  // 正常：agent.execute 返回 { success, data, history }
  const history = [
    { type: 'step', action: { name: 'noop', output: '第一步' } },
    { type: 'step', action: { name: 'noop', output: '上周打卡 2 次，差 1 次，略松懈。本周补 3 次。' } },
  ]
  assert.equal(extractFinalText({ success: true, data: '', history }), '上周打卡 2 次，差 1 次，略松懈。本周补 3 次。')
  // 兼容：直接给数组 / 字符串
  assert.equal(extractFinalText(history), '上周打卡 2 次，差 1 次，略松懈。本周补 3 次。')
  assert.equal(extractFinalText('纯字符串结论'), '纯字符串结论')
  assert.equal(extractFinalText({ history: [{ type: 'observation', content: '观察' }] }), '观察')
  assert.equal(extractFinalText(null), '')
  assert.equal(extractFinalText({ history: [] }), '')

  // Markdown 残留被清掉、长度受限
  assert.equal(cleanAgentText('**上周打卡 2 次**。\n\n- 本周补 3 次。'), '上周打卡 2 次。\n本周补 3 次。')
  assert.equal(cleanAgentText('x'.repeat(400)).length, 160)
})
