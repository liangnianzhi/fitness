import test from 'node:test'
import assert from 'node:assert/strict'

import worker from '../src/worker.js'

const ID = 'ABCDEFGHJKLMNPQRSTUVWX'

function fakeKV() {
  const map = new Map()
  return {
    async get(key, type) {
      if (!map.has(key)) return null
      const raw = map.get(key)
      return type === 'json' ? JSON.parse(raw) : raw
    },
    async put(key, value) { map.set(key, value) },
  }
}

function env() {
  return { CHECKINS: fakeKV(), ASSETS: { fetch: async () => new Response('x') } }
}

function post(e, path, body) {
  return worker.fetch(new Request('https://example.com' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), e)
}

async function settingsOf(e) {
  const res = await worker.fetch(new Request(`https://example.com/api/state/${ID}`), e)
  return (await res.json()).doc.settings
}

test('打卡不在内置列表的项目，会登记进 settings', async () => {
  const e = env()
  await post(e, `/api/state/${ID}/mark`, {
    action: 'mark', day: '2026-10-29', name: '打篮球', mins: 60,
  })
  const s = await settingsOf(e)
  assert.ok(s.customTags.includes('打篮球'), '应进 customTags')
  assert.ok(s.quickItems.includes('打篮球'), '应进 quickItems，App 里才能直接选')
})

test('内置项目不重复登记到 quickItems', async () => {
  const e = env()
  await post(e, `/api/state/${ID}/mark`, {
    action: 'mark', day: '2026-10-29', name: '跑步机', mins: 30,
  })
  const s = await settingsOf(e)
  assert.ok(!s.quickItems.includes('跑步机'), '内置项目本来就有，不该重复加')
})

test('同一项目多次打卡不会重复登记', async () => {
  const e = env()
  for (const d of ['2026-10-27', '2026-10-28', '2026-10-29']) {
    await post(e, `/api/state/${ID}/mark`, { action: 'mark', day: d, name: '普拉提', mins: 45 })
  }
  const s = await settingsOf(e)
  assert.equal(s.customTags.filter((x) => x === '普拉提').length, 1)
})

test('append 追加的新项目同样会登记', async () => {
  const e = env()
  await post(e, `/api/state/${ID}/mark`, { action: 'mark', day: '2026-10-29', name: '力量训练', mins: 45 })
  await post(e, `/api/state/${ID}/mark`, {
    action: 'append', day: '2026-10-29', items: [{ name: '拳击', mins: 30 }],
  })
  const s = await settingsOf(e)
  assert.ok(s.customTags.includes('拳击'))
})

test('多个项目一次登记', async () => {
  const e = env()
  await post(e, `/api/state/${ID}/mark`, {
    action: 'mark', day: '2026-10-29',
    items: [{ name: '羽毛球', mins: 40 }, { name: '爬山', mins: 90 }],
  })
  const s = await settingsOf(e)
  assert.ok(s.customTags.includes('羽毛球'))
  assert.ok(s.customTags.includes('爬山'))
})

test('登记后原有 settings 不被破坏', async () => {
  const e = env()
  await post(e, `/api/state/${ID}/merge`, {
    version: 1, marks: {}, unmarks: {},
    settings: { weekGoal: 5, monthGoal: 20, defaultMins: 50 },
    meta: { settingsAt: 100 },
  })
  await post(e, `/api/state/${ID}/mark`, { action: 'mark', day: '2026-10-29', name: '拳击', mins: 30 })
  const s = await settingsOf(e)
  assert.equal(s.weekGoal, 5, '周目标不能被覆盖')
  assert.equal(s.defaultMins, 50, '默认时长不能被覆盖')
})
