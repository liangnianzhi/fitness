import test from 'node:test'
import assert from 'node:assert/strict'

import { createSync, emptyState, setSettings, markDay } from '../public/store.js'

/**
 * 同步口令自愈逻辑。
 *
 * 触发条件必须窄：只有「本机没口令 AND 本机没记录」时才去云端找回。
 * 放宽了会把两台本来用不同口令的设备串到一起，数据互相污染。
 */

function fakeFetch(routes) {
  return async (url, init) => {
    const path = url.replace(/^.*\/api/, '/api')
    const handler = routes[path]
    if (!handler) return new Response('{}', { status: 404 })
    return handler(init)
  }
}

const VALID_ID = 'QNsFxzER8vcMYWhhXTWrvs'

test('discover：拿到合法口令', async () => {
  const sync = createSync(
    fakeFetch({
      '/api/active': () => new Response(JSON.stringify({ ok: true, syncId: VALID_ID }), { status: 200 }),
    })
  )
  assert.equal(await sync.discover(), VALID_ID)
})

test('discover：请求带上 X-Fitcal-Client 头', async () => {
  let seenHeader = null
  const sync = createSync(async (url, init) => {
    seenHeader = init?.headers?.['x-fitcal-client']
    return new Response(JSON.stringify({ syncId: VALID_ID }), { status: 200 })
  })
  await sync.discover()
  assert.equal(seenHeader, '1', 'Worker 只放行带这个头的调用方')
})

test('discover：口令格式非法时返回 null', async () => {
  const sync = createSync(fakeFetch({
    '/api/active': () => new Response(JSON.stringify({ syncId: 'short' }), { status: 200 }),
  }))
  assert.equal(await sync.discover(), null)
})

test('discover：403 时返回 null，不抛异常', async () => {
  const sync = createSync(fakeFetch({
    '/api/active': () => new Response('{}', { status: 403 }),
  }))
  assert.equal(await sync.discover(), null)
})

test('discover：网络异常时返回 null', async () => {
  const sync = createSync(async () => {
    throw new Error('offline')
  })
  assert.equal(await sync.discover(), null)
})

test('discover：syncId 为 null 时返回 null', async () => {
  const sync = createSync(fakeFetch({
    '/api/active': () => new Response(JSON.stringify({ ok: true, syncId: null }), { status: 200 }),
  }))
  assert.equal(await sync.discover(), null)
})

/* ---------- 自愈的触发条件 ---------- */

/** 复刻 app.js initSync 里的判断 */
function shouldDiscover(state) {
  return !state.settings.syncId && Object.keys(state.marks).length === 0
}

test('自愈：本机无口令且无记录时才触发', () => {
  assert.equal(shouldDiscover(emptyState()), true)

  const withId = setSettings(emptyState(), { syncId: VALID_ID })
  assert.equal(shouldDiscover(withId), false, '已有口令不该覆盖')

  const withData = markDay(emptyState(), '2026-10-28', { name: '力量训练', mins: 45 })
  assert.equal(shouldDiscover(withData), false, '本机已有记录时不猜口令，避免串账号')
})
