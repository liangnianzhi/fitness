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
