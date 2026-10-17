import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BUILTIN_QUICK_ITEMS,
  EFFORT_IDS,
  EFFORT_LEVELS,
  addCustomTag,
  deriveDay,
  effortRank,
  emptyState,
  markDay,
  mergeStates,
  normalizeEffort,
  normalizeState,
  rememberItemMins,
  removeCustomTag,
} from '../public/store.js'
import { isChecked, statsFor } from '../public/analysis.js'

test('辛苦程度：五档、默认适中、非法值回落', () => {
  assert.equal(EFFORT_LEVELS.length, 5)
  assert.deepEqual(EFFORT_IDS, ['easy', 'normal', 'hard', 'drained', 'maxed'])
  assert.equal(normalizeEffort('maxed'), 'maxed')
  assert.equal(normalizeEffort('随便写的'), 'normal')
  assert.equal(normalizeEffort(undefined), 'normal')
  // 档位数字用于比较强弱
  assert.ok(effortRank('maxed') > effortRank('drained'))
  assert.ok(effortRank('drained') > effortRank('hard'))
  assert.ok(effortRank('hard') > effortRank('easy'))
})

test('多项目：总时长求和，辛苦程度取最高档', () => {
  let s = markDay(emptyState(), '2026-10-17', {
    items: [
      { name: '跑步机', mins: 30, effort: 'normal' },
      { name: '团操', mins: 45, effort: 'hard' },
      { name: '拉伸', mins: 10, effort: 'easy' },
    ],
  })
  const m = s.marks['2026-10-17']
  assert.equal(m.items.length, 3)
  assert.equal(m.mins, 85)
  assert.equal(m.effort, 'hard')
  assert.equal(isChecked(s, '2026-10-17'), true)

  // 单个项目时辛苦程度就是它自己的
  const d = deriveDay([{ name: '游泳', mins: 40, effort: 'drained' }])
  assert.deepEqual(d, { mins: 40, effort: 'drained' })
  // 空项目不炸
  assert.deepEqual(deriveDay([]).mins, 0)
})

test('单项目打卡：name / mins / effort 会转成一条项目记录', () => {
  const s = markDay(emptyState(), '2026-10-01', { name: '爬楼机', mins: 25, effort: 'maxed' })
  const m = s.marks['2026-10-01']
  assert.equal(m.items[0].name, '爬楼机')
  assert.equal(m.items[0].mins, 25)
  assert.equal(m.items[0].effort, 'maxed')
  assert.equal(m.mins, 25)
  assert.equal(m.effort, 'maxed')
})

test('自定义标签：添加、去重、记住时长、可删除', () => {
  let s = addCustomTag(emptyState(), '  战绳  ', 25)
  assert.deepEqual(s.settings.customTags, ['战绳'])
  assert.ok(s.settings.quickItems.includes('战绳'))
  assert.equal(s.settings.itemMins['战绳'], 25)
  // 同名再添加不会重复
  s = addCustomTag(s, '战绳', 30)
  assert.equal(s.settings.customTags.filter((t) => t === '战绳').length, 1)
  assert.equal(s.settings.itemMins['战绳'], 30)

  // 名字清洗：压缩空格 + 截断到 12 字
  const long = addCustomTag(emptyState(), 'a' + '很长的名字'.repeat(6), 20)
  assert.ok(long.settings.customTags[0].length <= 12)

  // 删除时连带清掉快捷项与时长记忆
  s = removeCustomTag(s, '战绳')
  assert.deepEqual(s.settings.customTags, [])
  assert.ok(!s.settings.quickItems.includes('战绳'))
  assert.equal(s.settings.itemMins['战绳'], undefined)
})

test('内置项目不可被删除', () => {
  const s = removeCustomTag(emptyState(), BUILTIN_QUICK_ITEMS[0])
  assert.ok(s.settings.customTags.length === 0)
  assert.equal(BUILTIN_QUICK_ITEMS[0], '跑步机')
})

test('rememberItemMins：记住每个标签上次用的时长', () => {
  let s = rememberItemMins(emptyState(), '动感单车', 55)
  assert.equal(s.settings.itemMins['动感单车'], 55)
  s = rememberItemMins(s, '动感单车', 999)
  assert.equal(s.settings.itemMins['动感单车'], 600) // 上限夹紧（单项目最长 10 小时）
  s = rememberItemMins(s, '动感单车', 0)
  assert.equal(s.settings.itemMins['动感单车'], 1) // 下限夹紧
  // 空名字不写入
  const same = rememberItemMins(s, '   ', 30)
  assert.deepEqual(same.settings.itemMins, s.settings.itemMins)
})

test('多设备合并：自定义标签与时长记忆取并集', () => {
  const a = addCustomTag(emptyState(), '战绳', 25)
  const b = addCustomTag(emptyState(), '爬楼机', 35)
  const m = mergeStates(a, b)
  assert.deepEqual(m.settings.customTags.sort(), ['爬楼机', '战绳'].sort())
  assert.equal(m.settings.itemMins['战绳'], 25)
  assert.equal(m.settings.itemMins['爬楼机'], 35)
})

test('脏数据：多项目缺失 / 时长非法都能兜住', () => {
  const s = normalizeState({
    marks: {
      '2026-10-02': { t: 1, items: [{ name: '  ', mins: 30 }, { name: '划船机', mins: 'abc', effort: 'weird' }] },
      '2026-10-03': { t: 2, items: [] },
    },
  })
  // 名字为空的那条被丢掉，只保留合法的
  assert.equal(s.marks['2026-10-02'].items.length, 1)
  assert.equal(s.marks['2026-10-02'].items[0].name, '划船机')
  assert.equal(s.marks['2026-10-02'].items[0].effort, 'normal')
  // items 为空时兜底成一条默认项目，不会产生 0 项日程
  assert.equal(s.marks['2026-10-03'].items.length, 1)
})

test('统计：按项目名分组，时长按项目累加', () => {
  let s = emptyState()
  s = markDay(s, '2026-10-05', {
    items: [
      { name: '跑步机', mins: 30, effort: 'normal' },
      { name: '拉伸', mins: 10, effort: 'easy' },
    ],
  })
  s = markDay(s, '2026-10-07', { name: '跑步机', mins: 45, effort: 'hard' })
  const st = statsFor(s, '2026-10-05', '2026-10-11')
  assert.equal(st.count, 2)
  assert.equal(st.minutes, 85)
  assert.deepEqual(st.byKind, { 跑步机: 2, 拉伸: 1 })
})
