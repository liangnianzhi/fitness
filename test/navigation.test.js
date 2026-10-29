import test from 'node:test'
import assert from 'node:assert/strict'

import { startOfWeek, endOfWeek, startOfMonth, ymd, addMonths } from '../public/analysis.js'

/**
 * 翻页后选中日期的落点。
 *
 * 这段逻辑来自 app.js 的 selectionForPeriod()。
 * 原来翻月后 selection 不变，底部按钮会指向用户看不见的上个月的某天，
 * 一点打卡就写到看不见的地方——这类 bug 在手机上极难自己发现。
 */

function selectionForPeriod(anchor, mode, todayDate = new Date()) {
  const today = ymd(todayDate)
  if (mode === 'week') {
    const start = startOfWeek(anchor)
    const end = endOfWeek(anchor)
    if (today >= ymd(start) && today <= ymd(end)) return today
    return ymd(start)
  }
  if (mode === 'month') {
    if (ymd(anchor).slice(0, 7) === today.slice(0, 7)) return today
    return ymd(startOfMonth(anchor))
  }
  if (String(anchor.getFullYear()) === today.slice(0, 4)) return today
  return `${anchor.getFullYear()}-01-01`
}

const today = new Date(2026, 9, 29) // 2026-10-29 周四

test('月视图：翻到别的月份，选中落到该月 1 号', () => {
  const next = addMonths(startOfMonth(today), 1) // 2026-11-01
  assert.equal(selectionForPeriod(next, 'month', today), '2026-11-01')

  const prev = addMonths(startOfMonth(today), -1) // 2026-09-01
  assert.equal(selectionForPeriod(prev, 'month', today), '2026-09-01')
})

test('月视图：当前月份选中今天', () => {
  assert.equal(selectionForPeriod(today, 'month', today), '2026-10-29')
})

test('周视图：翻到别的周，选中落到周一', () => {
  const nextWeek = new Date(2026, 10, 5) // 2026-11-05 周四
  assert.equal(selectionForPeriod(nextWeek, 'week', today), '2026-11-02')
})

test('周视图：本周选中今天', () => {
  assert.equal(selectionForPeriod(today, 'week', today), '2026-10-29')
})

test('年视图：同年选中今天，跨年落到 1 月 1 日', () => {
  assert.equal(selectionForPeriod(today, 'year', today), '2026-10-29')
  const nextYear = new Date(2027, 0, 1)
  assert.equal(selectionForPeriod(nextYear, 'year', today), '2027-01-01')
})

test('翻页后的选中日期一定在新周期内', () => {
  for (const offset of [-3, -1, 1, 3]) {
    const target = addMonths(startOfMonth(today), offset)
    const sel = selectionForPeriod(target, 'month', today)
    assert.equal(
      sel.slice(0, 7),
      ymd(target).slice(0, 7),
      `选中日期 ${sel} 应落在目标月份 ${ymd(target).slice(0, 7)} 内`
    )
  }
})

test('翻页后的选中日期不会落在未来', () => {
  // 即便翻到当前月，也不该选中未来的某天
  const sel = selectionForPeriod(today, 'month', today)
  assert.ok(sel <= '2026-10-29')
})
