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

function fakeEnv(withKV = true) {
  const env = {
    ASSETS: {
      fetch: async () => new Response('<html>asset</html>', { headers: { 'content-type': 'text/html' } }),
    },
  }
  if (withKV) env.CHECKINS = fakeKV()
  return env
}

function call(env, path, init) {
  return worker.fetch(new Request('https://example.com' + path, init), env)
}

test('/api/config：未绑 KV 时 store=false', async () => {
  const res = await call(fakeEnv(false), '/api/config')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.store, false)
  assert.equal(body.app, 'fitness-checkin-calendar')
})

test('/api/config：绑定 KV 时 store=true，并带 CORS 头', async () => {
  const res = await call(fakeEnv(true), '/api/config')
  assert.equal((await res.json()).store, true)
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
})

test('其它路径交给静态资源', async () => {
  const res = await call(fakeEnv(true), '/')
  assert.match(await res.text(), /<html>asset<\/html>/)
})

test('同步口令格式校验', async () => {
  const res = await call(fakeEnv(true), '/api/state/short')
  assert.equal(res.status, 400)
})

test('未绑 KV 时返回 501 而不是 500', async () => {
  const res = await call(fakeEnv(false), '/api/state/' + ID)
  assert.equal(res.status, 501)
})

test('PUT/GET 往返：数据被清洗后保存', async () => {
  const env = fakeEnv(true)
  const doc = {
    marks: {
      '2026-10-17': { t: 1000, kind: 'cardio', mins: 45 },
      'not-a-day': { t: 1 },
      '2026-10-18': { t: 'x' },
    },
    unmarks: { '2026-10-16': 900 },
    settings: { weekGoal: 4 },
    meta: { updatedAt: 123 },
  }
  const put = await call(env, '/api/state/' + ID, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(doc),
  })
  assert.equal(put.status, 200)
  const putBody = await put.json()
  assert.equal(putBody.ok, true)
  assert.ok(putBody.updatedAt)

  const got = await call(env, '/api/state/' + ID)
  assert.equal(got.status, 200)
  const { doc: saved } = await got.json()
  assert.deepEqual(Object.keys(saved.marks).sort(), ['2026-10-17', '2026-10-18'])
  assert.equal(saved.marks['2026-10-17'].mins, 45)
  assert.equal(saved.marks['2026-10-18'].t, 0) // 非法时间戳被归零
  assert.equal(saved.unmarks['2026-10-16'], 900)
  assert.equal(saved.settings.weekGoal, 4)
})

test('多项目 + 辛苦程度：云端保存时保留 items 与 effort', async () => {
  const env = fakeEnv(true)
  const doc = {
    marks: {
      '2026-10-17': {
        t: 1000,
        mins: 85,
        effort: 'hard',
        items: [
          { name: '跑步机', mins: 30, effort: 'normal' },
          { name: '团操', mins: 45, effort: 'hard' },
          { name: '', mins: 10 }, // 空名字会被丢弃
          { name: '拉伸', mins: 9999, effort: '反了' }, // 时长夹紧、非法档位回落
        ],
      },
    },
    unmarks: {},
    settings: { customTags: ['战绳'] },
    meta: { updatedAt: 1 },
  }
  const put = await call(env, '/api/state/' + ID, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(doc),
  })
  assert.equal(put.status, 200)

  const got = await call(env, '/api/state/' + ID)
  const saved = (await got.json()).doc.marks['2026-10-17']
  assert.equal(saved.items.length, 3)
  assert.deepEqual(saved.items[0], { name: '跑步机', mins: 30, effort: 'normal' })
  assert.equal(saved.items[2].mins, 600)
  assert.equal(saved.items[2].effort, 'normal')
  assert.equal(saved.effort, 'hard')
})

test('空口令查询返回 doc=null', async () => {
  const res = await call(fakeEnv(true), '/api/state/' + 'ZZZZZZZZZZZZZZZZZZZZZZ'.slice(0, 22))
  assert.equal(res.status, 200)
  assert.equal((await res.json()).doc, null)
})

test('非法 JSON 与超大体积被拒绝', async () => {
  const bad = await call(fakeEnv(true), '/api/state/' + ID, { method: 'PUT', body: '{oops' })
  assert.equal(bad.status, 400)

  const big = await call(fakeEnv(true), '/api/state/' + ID, {
    method: 'PUT',
    headers: { 'content-length': String(300 * 1024) },
    body: '{}',
  })
  assert.equal(big.status, 413)
})

test('方法白名单与 404 兜底', async () => {
  const env = fakeEnv(true)
  assert.equal((await call(env, '/api/state/' + ID, { method: 'DELETE' })).status, 405)
  assert.equal((await call(env, '/api/unknown')).status, 404)
  assert.equal((await call(env, '/api/config', { method: 'OPTIONS' })).status, 204)
})
