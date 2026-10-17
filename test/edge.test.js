import test from 'node:test'
import assert from 'node:assert/strict'

import { monthDetail, monthReview, isChecked } from '../public/analysis.js'
import { emptyState, mergeStates, markDay } from '../public/store.js'

test('月合并：按天取最新', () => {
  const a = mergeStates(
    markDay(emptyState(), '2026-10-01', { t: 1000, mins: 30 }),
    markDay(emptyState(), '2026-10-01', { t: 2000, mins: 90 })
  )
  assert.equal(a.marks['2026-10-01'].mins, 90)
})

test('上月回顾文案里不能出现 undefined', () => {
  const s = markDay(markDay(emptyState(), '2026-09-02', { t: 1 }), '2026-09-09', { t: 2 })
  const r = monthReview(s, '2026-10-17')
  assert.ok(!/undefined|NaN/.test(r.text), r.text)
  const r2 = monthReview(emptyState(), '2026-10-17')
  assert.ok(!/undefined|NaN/.test(r2.text), r2.text)
  assert.match(r2.text, /上月一次都没打卡/)
})

test('0 次且有前值：文案会提到下降幅度', () => {
  // 9 月 0 次、8 月 3 次
  let s = emptyState()
  s = markDay(s, '2026-08-05', { t: 1 })
  s = markDay(s, '2026-08-12', { t: 2 })
  s = markDay(s, '2026-08-19', { t: 3 })
  const r = monthReview(s, '2026-10-17')
  assert.equal(r.count, 0)
  assert.equal(r.prevCount, 3)
  assert.match(r.text, /少了 3 次/)
})

test('月明细跨年边界', () => {
  let s = emptyState()
  s = markDay(s, '2025-12-31', { t: 1 })
  s = markDay(s, '2026-01-01', { t: 2 })
  const dec = monthDetail(s, '2025-12-15')
  assert.equal(dec.count, 1)
  assert.equal(dec.keys.length, 31)
  assert.equal(monthDetail(s, '2026-02-10').keys.length, 28)
  assert.equal(monthDetail(s, new Date(2024, 1, 10)).keys.length, 29) // 闰年
  assert.ok(isChecked(s, '2026-01-01'))
})
