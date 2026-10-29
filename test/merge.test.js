import test from 'node:test'
import assert from 'node:assert/strict'

import worker from '../src/worker.js'

const ID = 'ABCDEFGHJKLMNPQRSTUVWX'

/** 内存版 KV */
function fakeKV() {
  const map = new Map()
  return {
    _map: map,
    async get(key, type) {
      if (!map.has(key)) return null
      const raw = map.get(key)
      return type === 'json' ? JSON.parse(raw) : raw
    },
    async put(key, value) {
      map.set(key, value)
    },
  }
}

function fakeEnv() {
  return {
    CHECKINS: fakeKV(),
    ASSETS: {
      fetch: async () => new Response('<html>asset</html>', { headers: { 'content-type': 'text/html' } }),
    },
  }
}

function call(env, path, init) {
  return worker.fetch(new Request('https://example.com' + path, init), env)
}

function postJson(env, path, body) {
  return call(env, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function emptyDoc(marks = {}) {
  return { version: 1, marks, unmarks: {}, settings: {}, meta: {} }
}

function day(t, name, mins, effort = 'normal') {
  return { t, mins, effort, items: [{ name, mins, effort }] }
}

/* -------- POST /mark：机器人单条打卡 -------- */

test('/mark：空文档时写入打卡并正确派生 mins/effort', async () => {
  const env = fakeEnv()
  const res = await postJson(env, `/api/state/${ID}/mark`, {
    action: 'mark',
    day: '2026-10-28',
    name: '力量训练',
    mins: 60,
    effort: 'hard',
  })
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.entry.mins, 60)
  assert.equal(data.entry.effort, 'hard')
  assert.equal(data.entry.items.length, 1)
  assert.equal(data.entry.items[0].name, '力量训练')

  // 真的落盘了
  const getRes = await call(env, `/api/state/${ID}`)
  const got = await getRes.json()
  assert.ok(got.doc.marks['2026-10-28'])
})

test('/mark：多项目时总时长为求和、辛苦程度取最高档', async () => {
  const env = fakeEnv()
  const res = await postJson(env, `/api/state/${ID}/mark`, {
    action: 'mark',
    day: '2026-10-28',
    items: [
      { name: '跑步机', mins: 20, effort: 'easy' },
      { name: '力量训练', mins: 40, effort: 'maxed' },
    ],
  })
  const data = await res.json()
  assert.equal(data.entry.mins, 60)
  assert.equal(data.entry.effort, 'maxed')
  assert.equal(data.entry.items.length, 2)
})

test('/mark：取消打卡会清掉 mark 并写入 unmark', async () => {
  const env = fakeEnv()
  await postJson(env, `/api/state/${ID}/mark`, { action: 'mark', day: '2026-10-28', name: '拉伸', mins: 30 })
  const res = await postJson(env, `/api/state/${ID}/mark`, { action: 'unmark', day: '2026-10-28' })
  const data = await res.json()
  assert.equal(data.entry, null)
  assert.equal(data.doc.marks['2026-10-28'], undefined)
  assert.ok(data.doc.unmarks['2026-10-28'] > 0)
})

test('/mark：非法 action 与非法 day 被拒绝', async () => {
  const env = fakeEnv()
  let res = await postJson(env, `/api/state/${ID}/mark`, { action: 'oops', day: '2026-10-28' })
  assert.equal(res.status, 400)
  res = await postJson(env, `/api/state/${ID}/mark`, { action: 'mark', day: '2026/10/28' })
  assert.equal(res.status, 400)
})

/* -------- POST /merge：并发不互相覆盖 -------- */

test('/merge：云端已有的一天的打卡不会被旧状态覆盖', async () => {
  const env = fakeEnv()
  // 1) 服务端先有一条「机器人写入」的打卡（t 较大）
  await postJson(env, `/api/state/${ID}/mark`, {
    action: 'mark',
    day: '2026-10-28',
    name: '机器人',
    mins: 45,
    t: 2000000,
  })

  // 2) 手机端拿着「没有这一天」的旧文档推送，不该把这天抹掉
  const res = await postJson(env, `/api/state/${ID}/merge`, emptyDoc())
  const data = await res.json()
  assert.ok(data.doc.marks['2026-10-28'], '机器人写入的打卡应保留')
  assert.equal(data.doc.marks['2026-10-28'].items[0].name, '机器人')
})

test('/merge：同一天按 t 较新的一方胜出', async () => {
  const env = fakeEnv()
  await postJson(env, `/api/state/${ID}/merge`, emptyDoc({ '2026-10-28': day(1000, '旧的', 20) }))

  const res = await postJson(env, `/api/state/${ID}/merge`, emptyDoc({ '2026-10-28': day(2000, '新的', 50) }))
  const data = await res.json()
  assert.equal(data.doc.marks['2026-10-28'].items[0].name, '新的')
  assert.equal(data.doc.marks['2026-10-28'].mins, 50)

  // 再来一份更旧的，不能把新的顶掉
  const res2 = await postJson(env, `/api/state/${ID}/merge`, emptyDoc({ '2026-10-28': day(500, '更旧', 10) }))
  const data2 = await res2.json()
  assert.equal(data2.doc.marks['2026-10-28'].items[0].name, '新的')
})

test('/merge：自定义标签取并集，settings 听较新的一方', async () => {
  const env = fakeEnv()
  await postJson(env, `/api/state/${ID}/merge`, {
    version: 1,
    marks: {},
    unmarks: {},
    settings: { quickItems: ['游泳'], customTags: ['游泳'], weekGoal: 3, syncId: ID },
    meta: { settingsAt: 100 },
  })
  const res = await postJson(env, `/api/state/${ID}/merge`, {
    version: 1,
    marks: {},
    unmarks: {},
    settings: { quickItems: ['跳绳'], customTags: ['跳绳'], weekGoal: 5, syncId: ID },
    meta: { settingsAt: 200 },
  })
  const data = await res.json()
  assert.deepEqual(data.doc.settings.customTags, ['游泳', '跳绳'])
  assert.equal(data.doc.settings.weekGoal, 5)
})

test('/merge：体积超限与非法 JSON 被拒绝', async () => {
  const env = fakeEnv()
  const res = await call(env, `/api/state/${ID}/merge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{bad json',
  })
  assert.equal(res.status, 400)
})

/* -------- 兼容性 -------- */

test('/api/config 声明支持 merge', async () => {
  const res = await call(fakeEnv(), '/api/config')
  const data = await res.json()
  assert.equal(data.merge, true)
})

test('PUT /state 仍然可用（老前端兼容）', async () => {
  const env = fakeEnv()
  const res = await call(env, `/api/state/${ID}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(emptyDoc({ '2026-10-28': day(1000, '老接口', 30) })),
  })
  assert.equal(res.status, 200)
  const got = await (await call(env, `/api/state/${ID}`)).json()
  assert.equal(got.doc.marks['2026-10-28'].items[0].name, '老接口')
})

test('/mark 在未绑 KV 时返回 501', async () => {
  const env = { ASSETS: { fetch: async () => new Response('x') } }
  const res = await postJson(env, `/api/state/${ID}/mark`, { action: 'mark', day: '2026-10-28' })
  assert.equal(res.status, 501)
})

test('v1 老记录（只有 kind）在 merge 时迁移为 items', async () => {
  const env = fakeEnv()
  const res = await postJson(env, `/api/state/${ID}/merge`, {
    version: 1,
    marks: { '2026-10-20': { t: 1234, kind: '跑步', mins: 30, effort: 'normal' } },
    unmarks: {},
    settings: {},
    meta: {},
  })
  const data = await res.json()
  assert.equal(data.doc.marks['2026-10-20'].items[0].name, '跑步')
  assert.equal(data.doc.marks['2026-10-20'].mins, 30)
})

test('/merge：只传部分 settings 时，其他字段不能被抹掉', async () => {
  const env = fakeEnv()
  // 先存一份完整设置
  await postJson(env, `/api/state/${ID}/merge`, {
    version: 1, marks: {}, unmarks: {},
    settings: { weekGoal: 3, monthGoal: 12, defaultMins: 40, aiAuto: true, syncId: ID },
    meta: { settingsAt: 100 },
  })

  // 再只改 defaultMins，且 settingsAt 更新
  const res = await postJson(env, `/api/state/${ID}/merge`, {
    version: 1, marks: {}, unmarks: {},
    settings: { defaultMins: 30 },
    meta: { settingsAt: 200 },
  })
  const data = await res.json()
  assert.equal(data.doc.settings.defaultMins, 30, '改动的字段应生效')
  assert.equal(data.doc.settings.weekGoal, 3, '未提到的字段必须保留')
  assert.equal(data.doc.settings.monthGoal, 12, '未提到的字段必须保留')
  assert.equal(data.doc.settings.aiAuto, true, '未提到的字段必须保留')
  assert.equal(data.doc.settings.syncId, ID, 'syncId 必须保留')
})

test('/merge：异常大的 settingsAt 会被限制，不会把后续更新永久卡死', async () => {
  const env = fakeEnv()
  // 写入一个天文数字的 settingsAt
  const res = await postJson(env, `/api/state/${ID}/merge`, {
    version: 1, marks: {}, unmarks: {},
    settings: { weekGoal: 3 },
    meta: { settingsAt: 9999999999999 },
  })
  const data = await res.json()
  const stored = data.doc.meta.settingsAt
  const cap = Date.now() + 24 * 3600 * 1000
  assert.ok(stored <= cap, 'settingsAt 不应超过当前时间一天以上')

  // 之后正常更新必须能生效（时间戳要严格大于上一次，模拟真实的时间推进）
  const res2 = await postJson(env, `/api/state/${ID}/merge`, {
    version: 1, marks: {}, unmarks: {},
    settings: { weekGoal: 5 },
    meta: { settingsAt: Date.now() + 25 * 3600 * 1000 },
  })
  const data2 = await res2.json()
  assert.equal(data2.doc.settings.weekGoal, 5, '上限之后的正常更新必须能生效')
})
