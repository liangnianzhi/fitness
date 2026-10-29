import test from 'node:test'
import assert from 'node:assert/strict'

import { markDay, unmarkDay, emptyState, normalizeState } from '../public/store.js'
import { ymd, addDays, isChecked } from '../public/analysis.js'

/**
 * 交互逻辑的纯函数级验证。
 *
 * 页面里的点击处理没法直接单测（依赖 DOM），但它的核心判断可以：
 * 点某天到底该「选中」「编辑」还是「写入」，取决于 isChecked。
 * 这里把这条决策规则固化下来，避免以后改手势时又把「误触即打卡」改回去。
 */

const today = new Date()
const todayKey = ymd(today)
const pastKey = ymd(addDays(today, -1))
const futureKey = ymd(addDays(today, 1))

/** 复刻 handleDayTap 的决策：返回 'future' | 'edit' | 'select' */
function decideTap(state, key) {
  if (key > todayKey) return 'future'
  if (isChecked(state, key)) return 'edit'
  return 'select'
}

/** 复刻主按钮的决策：返回 'disabled' | 'edit' | 'write' */
function decideButton(state, key) {
  if (key > todayKey) return 'disabled'
  if (isChecked(state, key)) return 'edit'
  return 'write'
}

test('点击空白日期只选中，不写入数据', () => {
  const state = emptyState()
  assert.equal(decideTap(state, todayKey), 'select')
  // 关键：决策为 select 时不能调用 markDay，状态里不该出现打卡记录
  assert.equal(Object.keys(state.marks).length, 0)
})

test('点击已打卡日期进入编辑，而不是直接删除', () => {
  const state = markDay(emptyState(), todayKey, { name: '力量训练', mins: 45 })
  assert.equal(decideTap(state, todayKey), 'edit')
  // 决策为 edit 时数据必须原样保留，不能被撤销
  assert.ok(isChecked(state, todayKey), '已有记录不能被点击删掉')
})

test('点击未来日期不响应', () => {
  const state = emptyState()
  assert.equal(decideTap(state, futureKey), 'future')
  assert.equal(decideTap(state, pastKey), 'select')
})

test('主按钮：空白日期才写入，已打卡日期是编辑', () => {
  const empty = emptyState()
  assert.equal(decideButton(empty, todayKey), 'write')

  const marked = markDay(emptyState(), todayKey, { name: '拉伸', mins: 20 })
  assert.equal(decideButton(marked, todayKey), 'edit')
})

test('主按钮：未来日期禁用', () => {
  assert.equal(decideButton(emptyState(), futureKey), 'disabled')
})

test('取消打卡后，该天回到「可选中」状态', () => {
  let state = markDay(emptyState(), todayKey, { name: '力量训练', mins: 45 })
  assert.equal(decideButton(state, todayKey), 'edit')

  state = unmarkDay(state, todayKey)
  assert.equal(decideTap(state, todayKey), 'select', '取消后点击应回到选中')
  assert.equal(decideButton(state, todayKey), 'write', '取消后按钮应可再次打卡')
})

test('取消打卡留下的 tombstone 不影响其他日期', () => {
  let state = markDay(emptyState(), pastKey, { name: '跑步机', mins: 30 })
  state = markDay(state, todayKey, { name: '力量训练', mins: 45 })
  state = unmarkDay(state, todayKey)

  assert.ok(isChecked(state, pastKey), '其他日期的打卡不受影响')
  assert.equal(isChecked(state, todayKey), false)
})

test('同一天先打卡再取消，最终状态是未打卡', () => {
  let state = markDay(emptyState(), todayKey, { name: '拉伸', mins: 15 })
  state = unmarkDay(state, todayKey)
  assert.equal(isChecked(state, todayKey), false)
  assert.ok(normalizeState(state).unmarks[todayKey] > 0, '应留下取消时间戳用于多端合并')
})

/* ---------- 编辑保存：无改动不写时间戳 ---------- */

/** 复刻 app.js 的 sameItems */
function sameItems(a, b) {
  const listA = Array.isArray(a) ? a : []
  const listB = Array.isArray(b) ? b : []
  if (listA.length !== listB.length) return false
  for (let i = 0; i < listA.length; i++) {
    const x = listA[i]
    const y = listB[i]
    if (!x || !y) return false
    if (x.name !== y.name || Number(x.mins) !== Number(y.mins) || x.effort !== y.effort) return false
  }
  return true
}

test('sameItems：内容一致时判定为未改动', () => {
  const a = [{ name: '力量训练', mins: 45, effort: 'hard' }]
  const b = [{ name: '力量训练', mins: 45, effort: 'hard' }]
  assert.equal(sameItems(a, b), true)
})

test('sameItems：改时长算改动', () => {
  const a = [{ name: '力量训练', mins: 45, effort: 'hard' }]
  const b = [{ name: '力量训练', mins: 60, effort: 'hard' }]
  assert.equal(sameItems(a, b), false)
})

test('sameItems：改强度算改动', () => {
  const a = [{ name: '力量训练', mins: 45, effort: 'normal' }]
  const b = [{ name: '力量训练', mins: 45, effort: 'maxed' }]
  assert.equal(sameItems(a, b), false)
})

test('sameItems：增删项目算改动', () => {
  const a = [{ name: '力量训练', mins: 45, effort: 'normal' }]
  const b = [
    { name: '力量训练', mins: 45, effort: 'normal' },
    { name: '拉伸', mins: 15, effort: 'easy' },
  ]
  assert.equal(sameItems(a, b), false)
})

test('sameItems：空值容错', () => {
  assert.equal(sameItems(null, []), true)
  assert.equal(sameItems(undefined, [{ name: 'x', mins: 1, effort: 'easy' }]), false)
})

test('未改动时不应刷新打卡时间戳（多端合并安全）', () => {
  const t1 = 1000
  let state = markDay(emptyState(), todayKey, {
    t: t1,
    items: [{ name: '力量训练', mins: 45, effort: 'normal' }],
  })
  const beforeT = state.marks[todayKey].t

  // 模拟「打开抽屉什么都没改就保存」：sameItems 为 true，不应调用 markDay
  const draftItems = state.marks[todayKey].items.map((it) => ({ ...it }))
  const changed = !sameItems(state.marks[todayKey].items, draftItems)
  assert.equal(changed, false, '内容一致应判定未改动')
  assert.equal(state.marks[todayKey].t, beforeT, '时间戳不应被刷新')
})
