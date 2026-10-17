import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createSync,
  emptyState,
  generateSyncId,
  isValidSyncId,
  loadLocal,
  markDay,
  mergeStates,
  normalizeState,
  pruneTombstones,
  saveLocal,
  setSettings,
  STORAGE_KEY,
  unmarkDay,
} from '../public/store.js'
import { isChecked } from '../public/analysis.js'

/** 内存版 localStorage */
function fakeStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  }
}

test('normalizeState：脏数据不炸，非法值被夹紧', () => {
  assert.equal(normalizeState(null).settings.weekGoal, 3)
  assert.equal(normalizeState('nope').settings.monthGoal, 12)
  const s = normalizeState({
    marks: {
      '2026-10-17': { t: 5, kind: 'cardio', mins: 30 },
      'bad-key': { t: 5 },
      '2026-10-18': 'not-an-object',
    },
    unmarks: { '2026-10-19': 7, bad: 9 },
    settings: { weekGoal: 999, monthGoal: -3, defaultMins: 100000, syncId: 'short' },
    meta: { lastWeeklySeen: '2026-W41' },
  })
  assert.deepEqual(Object.keys(s.marks), ['2026-10-17'])
  assert.deepEqual(s.unmarks, { '2026-10-19': 7 })
  // v1 的 kind 会被迁移成一条同名项目
  assert.equal(s.marks['2026-10-17'].items[0].name, 'cardio')
  assert.equal(s.marks['2026-10-17'].items[0].mins, 30)
  assert.equal(s.settings.weekGoal, 14)
  assert.equal(s.settings.monthGoal, 1)
  assert.equal(s.settings.defaultMins, 300)
  assert.equal(s.settings.syncId, '') // 非法同步口令被丢弃
  assert.equal(s.meta.lastWeeklySeen, '2026-W41')
})

test('markDay / unmarkDay：切换状态并保留项目与时长', () => {
  let s = markDay(emptyState(), '2026-10-17', { t: 100, kind: 'cardio', mins: 45 })
  assert.equal(isChecked(s, '2026-10-17'), true)
  assert.equal(s.marks['2026-10-17'].mins, 45)
  s = unmarkDay(s, '2026-10-17')
  assert.equal(isChecked(s, '2026-10-17'), false)
  assert.equal(s.marks['2026-10-17'], undefined)
  assert.ok(s.unmarks['2026-10-17'] > 100)
  // 重新打卡：删除时旧记录已不在，项目名回落到默认标签
  s = markDay(s, '2026-10-17', { t: Date.now() + 1000 })
  assert.equal(isChecked(s, '2026-10-17'), true)
  assert.equal(s.marks['2026-10-17'].items[0].name, '训练')
  assert.equal(s.marks['2026-10-17'].mins, 40)
})

test('mergeStates：两台设备互相覆盖时以时间戳为准', () => {
  const a = markDay(emptyState(), '2026-10-01', { t: 5000, mins: 30 })
  const b = markDay(emptyState(), '2026-10-01', { t: 9000, mins: 90 })
  assert.equal(mergeStates(a, b).marks['2026-10-01'].mins, 90)
  assert.equal(mergeStates(b, a).marks['2026-10-01'].mins, 90)

  // A 打了卡（t=1000），B 稍后取消了（t=8000）-> 最终应为未打卡
  const c = markDay(emptyState(), '2026-10-02', { t: 1000 })
  const d = { ...emptyState(), unmarks: { '2026-10-02': 8000 } }
  assert.equal(isChecked(mergeStates(c, d), '2026-10-02'), false)
  // 反过来：取消时间更早 -> 仍为已打卡
  const e = { ...emptyState(), unmarks: { '2026-10-02': 500 } }
  assert.equal(isChecked(mergeStates(c, e), '2026-10-02'), true)
})

test('mergeStates：设置按改动时间取最新，同步口令不丢', () => {
  const a = setSettings(emptyState(), { weekGoal: 5, syncId: 'ABCDEFGHJKLMNPQRSTUVWX' })
  const b0 = setSettings(emptyState(), { weekGoal: 2 })
  const b = { ...b0, meta: { ...b0.meta, settingsAt: a.meta.settingsAt + 1000 } }
  const m = mergeStates(a, b)
  assert.equal(m.settings.weekGoal, 2)
  assert.equal(m.settings.syncId, 'ABCDEFGHJKLMNPQRSTUVWX')

  const seen = mergeStates(
    { ...emptyState(), meta: { ...emptyState().meta, lastWeeklySeen: '2026-W41' } },
    { ...emptyState(), meta: { ...emptyState().meta, lastWeeklySeen: '2026-W42' } }
  )
  assert.equal(seen.meta.lastWeeklySeen, '2026-W42')
})

test('pruneTombstones：只清理过期取消记录', () => {
  const s = { ...emptyState(), unmarks: { '2026-01-01': 1, '2026-10-16': 2 } }
  const out = pruneTombstones(s, '2026-10-17', 180)
  assert.equal(out.unmarks['2026-01-01'], undefined)
  assert.equal(out.unmarks['2026-10-16'], 2)
})

test('本地存储：读写与容错', () => {
  const st = fakeStorage()
  const s = markDay(emptyState(), '2026-10-17', { t: 1, mins: 60 })
  assert.equal(saveLocal(s, st), true)
  assert.equal(isChecked(loadLocal(st), '2026-10-17'), true)
  st.setItem(STORAGE_KEY, '{坏掉的 JSON')
  assert.equal(isChecked(loadLocal(st), '2026-10-17'), false)
  assert.equal(loadLocal(null).settings.weekGoal, 3)
})

test('同步口令：格式合法且足够随机', () => {
  const ids = new Set()
  for (let i = 0; i < 200; i++) {
    const id = generateSyncId()
    assert.equal(id.length, 22)
    assert.ok(isValidSyncId(id), id)
    ids.add(id)
  }
  assert.equal(ids.size, 200)
  assert.equal(isValidSyncId('short'), false)
  assert.equal(isValidSyncId('包含中文的口令abcdefghij'), false)
})

test('同步客户端：pull / push / config 走对接口', async () => {
  const calls = []
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' })
    if (url === '/api/config') return { ok: true, json: async () => ({ store: true }) }
    if (init.method === 'PUT') return { ok: true, json: async () => ({ ok: true }) }
    const doc = markDay(emptyState(), '2026-10-17', { t: 1, mins: 45 })
    return { ok: true, json: async () => ({ ok: true, doc }) }
  }
  const sync = createSync(fakeFetch)
  const pulled = await sync.pull('ABCDEFGHJKLMNPQRSTUVWX')
  assert.equal(isChecked(pulled, '2026-10-17'), true)
  assert.equal(await sync.push('ABCDEFGHJKLMNPQRSTUVWX', pulled), true)
  assert.deepEqual(await sync.config(), { store: true })
  assert.equal(calls[0].url, '/api/state/ABCDEFGHJKLMNPQRSTUVWX')
  assert.equal(calls[1].method, 'PUT')
  assert.equal(calls[2].url, '/api/config')

  const broken = createSync(async () => ({ ok: false, status: 503, json: async () => ({}) }))
  assert.deepEqual(await broken.config(), { store: false })
  await assert.rejects(() => broken.pull('ABCDEFGHJKLMNPQRSTUVWX'), /pull failed: 503/)
})
