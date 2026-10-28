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
    async put(key, value) {
      map.set(key, value)
    },
  }
}

function fakeEnv() {
  return {
    CHECKINS: fakeKV(),
    ASSETS: { fetch: async () => new Response('<html></html>') },
  }
}

function postJson(env, path, body) {
  return worker.fetch(
    new Request('https://example.com' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env
  )
}

async function entryOf(env, day) {
  const res = await worker.fetch(new Request(`https://example.com/api/state/${ID}`), env)
  const data = await res.json()
  return data.doc.marks[day] || null
}

test('append：在已有日程上追加项目，不覆盖原有内容', async () => {
  const env = fakeEnv()
  await postJson(env, `/api/state/${ID}/mark`, {
    action: 'mark',
    day: '2026-10-28',
    name: '力量训练',
    mins: 45,
    effort: 'hard',
  })

  const res = await postJson(env, `/api/state/${ID}/mark`, {
    action: 'append',
    day: '2026-10-28',
    items: [{ name: '拉伸', mins: 15 }],
  })
  assert.equal(res.status, 200)
  const entry = await entryOf(env, '2026-10-28')

  assert.equal(entry.items.length, 2, '应保留原项目并追加新项目')
  assert.equal(entry.mins, 60, '总时长应累加')
  const names = entry.items.map((i) => i.name)
  assert.deepEqual(names, ['力量训练', '拉伸'])
})

test('append：同名项目合并时长，不产生重复条目', async () => {
  const env = fakeEnv()
  await postJson(env, `/api/state/${ID}/mark`, {
    action: 'mark',
    day: '2026-10-28',
    name: '跑步机',
    mins: 20,
  })
  await postJson(env, `/api/state/${ID}/mark`, {
    action: 'append',
    day: '2026-10-28',
    items: [{ name: '跑步机', mins: 15 }],
  })

  const entry = await entryOf(env, '2026-10-28')
  assert.equal(entry.items.length, 1, '同名项目应合并')
  assert.equal(entry.items[0].mins, 35)
  assert.equal(entry.mins, 35)
})

test('append：辛苦程度取较高档', async () => {
  const env = fakeEnv()
  await postJson(env, `/api/state/${ID}/mark`, {
    action: 'mark',
    day: '2026-10-28',
    name: '拉伸',
    mins: 10,
    effort: 'easy',
  })
  await postJson(env, `/api/state/${ID}/mark`, {
    action: 'append',
    day: '2026-10-28',
    items: [{ name: '拉伸', mins: 10, effort: 'maxed' }],
  })
  const entry = await entryOf(env, '2026-10-28')
  assert.equal(entry.effort, 'maxed')
})

test('append：当天原本没有记录时等同于新建', async () => {
  const env = fakeEnv()
  await postJson(env, `/api/state/${ID}/mark`, {
    action: 'append',
    day: '2026-10-28',
    items: [{ name: '游泳', mins: 30 }],
  })
  const entry = await entryOf(env, '2026-10-28')
  assert.equal(entry.items.length, 1)
  assert.equal(entry.mins, 30)
})

test('append：不影响其他日期', async () => {
  const env = fakeEnv()
  await postJson(env, `/api/state/${ID}/mark`, {
    action: 'mark',
    day: '2026-10-27',
    name: '跑步机',
    mins: 30,
  })
  await postJson(env, `/api/state/${ID}/mark`, {
    action: 'append',
    day: '2026-10-28',
    items: [{ name: '拉伸', mins: 15 }],
  })
  const other = await entryOf(env, '2026-10-27')
  assert.equal(other.items[0].name, '跑步机')
  assert.equal(other.mins, 30, '另一天的数据不能被改动')
})

test('append：空 items 时不改动数据', async () => {
  const env = fakeEnv()
  await postJson(env, `/api/state/${ID}/mark`, {
    action: 'mark',
    day: '2026-10-28',
    name: '力量训练',
    mins: 45,
  })
  await postJson(env, `/api/state/${ID}/mark`, {
    action: 'append',
    day: '2026-10-28',
    items: [],
  })
  const entry = await entryOf(env, '2026-10-28')
  assert.equal(entry.mins, 45)
  assert.equal(entry.items.length, 1)
})

test('mark 仍然覆盖（改档语义不变）', async () => {
  const env = fakeEnv()
  await postJson(env, `/api/state/${ID}/mark`, {
    action: 'mark',
    day: '2026-10-28',
    name: '力量训练',
    mins: 45,
  })
  await postJson(env, `/api/state/${ID}/mark`, {
    action: 'mark',
    day: '2026-10-28',
    items: [{ name: '游泳', mins: 30 }],
  })
  const entry = await entryOf(env, '2026-10-28')
  assert.equal(entry.items.length, 1)
  assert.equal(entry.items[0].name, '游泳', 'mark 应整体替换')
})

test('非法 action 被拒绝且提示三种合法值', async () => {
  const env = fakeEnv()
  const res = await postJson(env, `/api/state/${ID}/mark`, {
    action: 'oops',
    day: '2026-10-28',
  })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.match(body.error, /mark|append|unmark/)
})
