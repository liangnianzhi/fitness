/**
 * Cloudflare Worker：静态资源 + 云端同步（含服务端合并）+ 配置下发。
 *
 * 路由：
 *   GET  /api/config               前端探测能力（是否配了 KV）
 *   GET  /api/active               最近一次写入的同步口令（机器人零配置用）
 *   GET  /api/state/:id            读取云端备份
 *   PUT  /api/state/:id            写入云端备份（整份覆盖，保留兼容）
 *   POST /api/state/:id/merge      按天合并后写回（机器人/多设备并发安全）
 *   POST /api/state/:id/mark       单条打卡 / 改档 / 取消打卡（机器人用）
 *   其它                            交给静态资源（assets binding）
 *
 * 设计取舍：
 *   - 没配 KV 时一切照常工作，前端自动降级为「仅本机保存」，不报错、不影响打卡。
 *   - 同步口令就是访问凭证，所以只接受足够长的随机串，并限制单条体积。
 *   - merge 的规则与 public/store.js 的 mergeStates 逐条对齐：
 *     按天 last-write-wins，marks 与 unmarks 各取较新时间戳，二者再比大小定最终状态。
 *     这样手机上正在开的页面 push 时，不再能覆盖掉机器人刚写入的打卡。
 *   - saveDoc 会顺手登记 meta:active，让机器人插件不必让用户手抄那串口令。
 */

const SYNC_ID_RE = /^[A-Za-z0-9_-]{16,64}$/
const MAX_BODY_BYTES = 256 * 1024
const MAX_DAYS = 4000 // 约 10 年的打卡记录，防止被灌爆
const EFFORT_IDS = ['easy', 'normal', 'hard', 'drained', 'maxed']
const EFFORT_RANK = { easy: 0, normal: 1, hard: 2, drained: 3, maxed: 4 }
const DEFAULT_EFFORT = 'normal'
const DEFAULT_ITEM_NAME = '训练'
const MAX_TAG_LEN = 12
const MAX_ITEMS_PER_DAY = 12
const ACTIVE_KEY = 'meta:active'
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  })
}

function isIsoDay(key) {
  return typeof key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(key)
}

function cleanTag(raw) {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LEN)
}

function clampInt(v, fallback, min, max) {
  const n = Math.round(Number(v))
  const base = Number.isFinite(n) ? n : fallback
  return Math.min(max, Math.max(min, base))
}

function normalizeEffort(raw) {
  return EFFORT_IDS.includes(raw) ? raw : DEFAULT_EFFORT
}

function normalizeItems(rawItems, fallbackMins, fallbackEffort) {
  const list = Array.isArray(rawItems) ? rawItems : []
  const out = []
  for (const it of list) {
    if (!it || typeof it !== 'object') continue
    const name = cleanTag(it.name)
    if (!name) continue
    out.push({
      name,
      mins: clampInt(it.mins, fallbackMins, 1, 600),
      effort: normalizeEffort(it.effort || fallbackEffort),
    })
    if (out.length >= MAX_ITEMS_PER_DAY) break
  }
  return out
}

/** 由 items 推导整天的总时长与辛苦程度（取最高档），与 store.js 的 deriveDay 一致 */
function deriveDay(items) {
  let mins = 0
  let effort = items.length ? 'easy' : DEFAULT_EFFORT
  for (const it of items) {
    mins += Number(it.mins || 0)
    if (EFFORT_RANK[it.effort] > EFFORT_RANK[effort]) effort = it.effort
  }
  return { mins, effort }
}

/** 校验并规整完整文档，只保留结构合法的部分 */
function sanitizeDoc(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const marks = raw.marks && typeof raw.marks === 'object' ? raw.marks : null
  if (!marks) return null
  const keys = Object.keys(marks)
  if (keys.length > MAX_DAYS) return null

  const cleanMarks = {}
  for (const key of keys) {
    if (!isIsoDay(key)) continue
    const m = marks[key]
    if (!m || typeof m !== 'object') continue
    const fallbackMins = clampInt(m.mins, 40, 1, 600)
    const fallbackEffort = normalizeEffort(m.effort)

    // 一次健身日程可以包含多个项目，每个项目有自己的时长与辛苦程度
    let items = normalizeItems(m.items, fallbackMins, fallbackEffort)
    if (!items.length) {
      // v1 数据：只有 kind + mins 的老记录，转成一条同名项目
      const legacyName = cleanTag(m.kind) || DEFAULT_ITEM_NAME
      items = [{ name: legacyName, mins: fallbackMins, effort: fallbackEffort }]
    }
    const derived = deriveDay(items)

    cleanMarks[key] = {
      t: Number.isFinite(Number(m.t)) ? Math.max(0, Math.round(Number(m.t))) : 0,
      mins: derived.mins,
      effort: derived.effort,
      items,
    }
  }

  const cleanUnmarks = {}
  const unmarks = raw.unmarks && typeof raw.unmarks === 'object' ? raw.unmarks : {}
  for (const key of Object.keys(unmarks)) {
    if (!isIsoDay(key)) continue
    const t = Number(unmarks[key])
    if (Number.isFinite(t) && t > 0) cleanUnmarks[key] = Math.round(t)
  }

  return {
    version: 1,
    marks: cleanMarks,
    unmarks: cleanUnmarks,
    settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : {},
    meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {},
  }
}

function uniqueTags(list, max = 40) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    const tag = cleanTag(item)
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
    if (out.length >= max) break
  }
  return out
}

/**
 * 合并两个文档。规则与 store.js 的 mergeStates 对齐：
 *  - 每天 marks 取 t 较大的一份；
 *  - unmarks 取较大时间戳；
 *  - settings 听 settingsAt 较晚的一方，自定义标签取并集。
 */
function mergeDocs(a, b) {
  const A = sanitizeDoc(a) || { version: 1, marks: {}, unmarks: {}, settings: {}, meta: {} }
  const B = sanitizeDoc(b) || { version: 1, marks: {}, unmarks: {}, settings: {}, meta: {} }

  const marks = {}
  for (const key of new Set([...Object.keys(A.marks), ...Object.keys(B.marks)])) {
    const ma = A.marks[key]
    const mb = B.marks[key]
    if (ma && mb) marks[key] = Number(ma.t) >= Number(mb.t) ? ma : mb
    else marks[key] = ma || mb
  }

  const unmarks = {}
  for (const key of new Set([...Object.keys(A.unmarks), ...Object.keys(B.unmarks)])) {
    const ua = Number(A.unmarks[key] || 0)
    const ub = Number(B.unmarks[key] || 0)
    const t = Math.max(ua, ub)
    if (t > 0) unmarks[key] = t
  }

  const sa = A.settings || {}
  const sb = B.settings || {}
  const settingsAtA = Number((A.meta && A.meta.settingsAt) || 0)
  const settingsAtB = Number((B.meta && B.meta.settingsAt) || 0)
  // 设置不能整份取一方：调用方哪怕只想改一个字段（例如只传 defaultMins），
  // 只要它的 settingsAt 更新，就会把其他字段（周目标、月目标、aiAuto…）全部抹掉。
  // 正确做法是按字段合并 —— 调用的那一方显式给出的字段才覆盖，没给就继承原来的。
  const newer = settingsAtA >= settingsAtB ? sa : sb
  const older = settingsAtA >= settingsAtB ? sb : sa
  const settings = { ...older, ...newer }
  settings.customTags = uniqueTags([...(older.customTags || []), ...(newer.customTags || [])])
  settings.quickItems = uniqueTags([...(older.quickItems || []), ...(newer.quickItems || [])])
  settings.itemMins = { ...(older.itemMins || {}), ...(newer.itemMins || {}) }
  settings.syncId = sa.syncId || sb.syncId || settings.syncId || ''

  const metaA = A.meta || {}
  const metaB = B.meta || {}
  const meta = {
    updatedAt: Math.max(Number(metaA.updatedAt || 0), Number(metaB.updatedAt || 0)),
    settingsAt: Math.max(settingsAtA, settingsAtB),
    lastWeeklySeen:
      String(metaA.lastWeeklySeen || '') > String(metaB.lastWeeklySeen || '')
        ? metaA.lastWeeklySeen
        : metaB.lastWeeklySeen,
    lastMonthlySeen:
      String(metaA.lastMonthlySeen || '') > String(metaB.lastMonthlySeen || '')
        ? metaA.lastMonthlySeen
        : metaB.lastMonthlySeen,
    seeded: !!metaA.seeded || !!metaB.seeded,
  }

  return { version: 1, marks, unmarks, settings, meta }
}

/** 对单天执行打卡 / 改档 / 取消，规则与 store.js 的 markDay / unmarkDay 对齐 */
function applyDayOp(doc, op) {
  const next = sanitizeDoc(doc) || { version: 1, marks: {}, unmarks: {}, settings: {}, meta: {} }
  const key = op.day
  const now = Date.now()
  const t = Number.isFinite(Number(op.t)) && Number(op.t) > 0 ? Math.round(Number(op.t)) : now

  if (op.action === 'unmark') {
    delete next.marks[key]
    next.unmarks[key] = t
    next.meta = { ...(next.meta || {}), updatedAt: t }
    return next
  }

  // append：在当天已有日程上追加项目，而不是整体替换。
  // 解决「先说练了力量训练，再说又拉伸了 15 分钟」时后一次把前一次冲掉的问题。
  if (op.action === 'append') {
    const beforeAppend = next.marks[key]
    const existing = beforeAppend && Array.isArray(beforeAppend.items) ? beforeAppend.items : []
    const settings2 = next.settings || {}
    const addMins = clampInt(settings2.defaultMins, 40, 5, 300)
    const addEffort = normalizeEffort(settings2.defaultEffort)
    const fresh = normalizeItems(op.items, addMins, addEffort)
    if (!fresh.length) return next

    // 同名项目直接合并时长，避免出现两条「拉伸」
    const merged = existing.map((it) => ({ ...it }))
    for (const item of fresh) {
      const hit = merged.find((e) => e.name === item.name)
      if (hit) {
        hit.mins = Math.min(600, Number(hit.mins || 0) + Number(item.mins || 0))
        if (EFFORT_RANK[item.effort] > EFFORT_RANK[hit.effort]) hit.effort = item.effort
      } else {
        merged.push(item)
      }
    }
    const capped = merged.slice(0, MAX_ITEMS_PER_DAY)
    const derivedAppend = deriveDay(capped)
    next.marks[key] = { t, mins: derivedAppend.mins, effort: derivedAppend.effort, items: capped }
    delete next.unmarks[key]
    next.meta = { ...(next.meta || {}), updatedAt: t }
    return next
  }

  // mark / update：已有记录时作为兜底默认值，与 markDay 的 patch 语义一致
  const before = next.marks[key]
  const settings = next.settings || {}
  // 与前端 store.js 的 normalizeState 保持一致：默认时长 5–300 分钟。
  // 之前这里写成 1–600，会让云端接受 App 根本不会产生的值，属于口径漂移。
  const defaultMins = clampInt(settings.defaultMins, 40, 5, 300)
  const defaultEffort = normalizeEffort(settings.defaultEffort)

  let items
  if (Array.isArray(op.items) && op.items.length) {
    items = normalizeItems(op.items, defaultMins, defaultEffort)
  } else {
    const name =
      cleanTag(op.name) ||
      (before && before.items && before.items[0] && before.items[0].name) ||
      DEFAULT_ITEM_NAME
    const mins = clampInt(
      op.mins !== undefined ? op.mins : before ? before.mins : defaultMins,
      defaultMins,
      1,
      600
    )
    const effort = normalizeEffort(op.effort || (before && before.effort) || defaultEffort)
    items = [{ name, mins, effort }]
  }
  if (!items.length) {
    items = [{ name: DEFAULT_ITEM_NAME, mins: defaultMins, effort: defaultEffort }]
  }

  const derived = deriveDay(items)
  next.marks[key] = { t, mins: derived.mins, effort: derived.effort, items }
  delete next.unmarks[key]
  next.meta = { ...(next.meta || {}), updatedAt: t }
  return next
}

async function readJson(request) {
  const length = Number(request.headers.get('content-length') || 0)
  if (length > MAX_BODY_BYTES) return { error: json({ error: '记录体积过大' }, 413, CORS_HEADERS) }
  let text
  try {
    text = await request.text()
  } catch {
    return { error: json({ error: '读取请求体失败' }, 400, CORS_HEADERS) }
  }
  if (text.length > MAX_BODY_BYTES) {
    return { error: json({ error: '记录体积过大' }, 413, CORS_HEADERS) }
  }
  try {
    return { body: JSON.parse(text) }
  } catch {
    return { error: json({ error: '请求体不是合法 JSON' }, 400, CORS_HEADERS) }
  }
}

async function loadStored(env, key) {
  const stored = await env.CHECKINS.get(key, 'json')
  if (!stored) return { doc: null, updatedAt: null }
  return { doc: stored.doc || null, updatedAt: stored.updatedAt || null }
}

async function saveDoc(env, key, doc) {
  const updatedAt = new Date().toISOString()
  await env.CHECKINS.put(key, JSON.stringify({ doc, updatedAt }))
  // 登记「当前活跃口令」，让机器人插件不必让用户手抄 syncId。
  // 只记最后一次写入的口令，单人使用场景足够；多人共用时请各自显式配置。
  if (key.startsWith('state:')) {
    await env.CHECKINS.put(ACTIVE_KEY, key.slice('state:'.length))
  }
  return updatedAt
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    if (url.pathname === '/api/config') {
      return json(
        {
          store: !!env.CHECKINS,
          version: 1,
          app: 'fitness-checkin-calendar',
          merge: true, // 支持 POST /merge 与 /mark，前端与机器人可据此走安全路径
        },
        200,
        CORS_HEADERS
      )
    }

    // GET /api/active —— 返回最近一次写入的同步口令，供机器人零配置接入
    if (url.pathname === '/api/active') {
      if (!env.CHECKINS) {
        return json({ error: '该 Worker 未绑定 KV（CHECKINS）' }, 501, CORS_HEADERS)
      }
      const active = await env.CHECKINS.get(ACTIVE_KEY, 'text')
      if (!active) return json({ ok: true, syncId: null }, 200, CORS_HEADERS)
      return json({ ok: true, syncId: active }, 200, CORS_HEADERS)
    }

    if (url.pathname.startsWith('/api/state/')) {
      const rest = url.pathname.slice('/api/state/'.length)
      // 兼容 /api/state/:id/merge 与 /api/state/:id/mark
      const segments = rest.split('/')
      const id = decodeURIComponent(segments[0] || '')
      const action = segments[1] || ''

      if (!SYNC_ID_RE.test(id)) {
        return json({ error: '同步口令格式不合法（需 16–64 位字母、数字、- 或 _）' }, 400, CORS_HEADERS)
      }
      if (!env.CHECKINS) {
        return json({ error: '该 Worker 未绑定 KV（CHECKINS），云端同步不可用' }, 501, CORS_HEADERS)
      }

      const key = `state:${id}`

      if (action === '') {
        if (request.method === 'GET') {
          const stored = await loadStored(env, key)
          if (!stored.doc) return json({ ok: true, doc: null }, 200, CORS_HEADERS)
          return json({ ok: true, doc: stored.doc, updatedAt: stored.updatedAt }, 200, CORS_HEADERS)
        }

        if (request.method === 'PUT') {
          const parsed = await readJson(request)
          if (parsed.error) return parsed.error
          const doc = sanitizeDoc(parsed.body)
          if (!doc) return json({ error: '记录结构不合法' }, 400, CORS_HEADERS)
          const updatedAt = await saveDoc(env, key, doc)
          return json({ ok: true, updatedAt }, 200, CORS_HEADERS)
        }

        return json({ error: '方法不支持' }, 405, CORS_HEADERS)
      }

      // POST /api/state/:id/merge —— 服务端按天合并，避免并发互相覆盖
      if (action === 'merge' && request.method === 'POST') {
        const parsed = await readJson(request)
        if (parsed.error) return parsed.error
        const incoming = sanitizeDoc(parsed.body)
        if (!incoming) return json({ error: '记录结构不合法' }, 400, CORS_HEADERS)

        const stored = await loadStored(env, key)
        const merged = stored.doc ? mergeDocs(stored.doc, incoming) : incoming
        const updatedAt = await saveDoc(env, key, merged)
        return json({ ok: true, updatedAt, doc: merged }, 200, CORS_HEADERS)
      }

      // POST /api/state/:id/mark —— 对单天打卡/改档/取消，读-改-写全程在服务端完成
      if (action === 'mark' && request.method === 'POST') {
        const parsed = await readJson(request)
        if (parsed.error) return parsed.error
        const op = parsed.body || {}
        if (!isIsoDay(op.day)) {
          return json({ error: 'day 必须是 YYYY-MM-DD' }, 400, CORS_HEADERS)
        }
        if (!['mark', 'append', 'unmark'].includes(op.action)) {
          return json({ error: 'action 必须是 mark、append 或 unmark' }, 400, CORS_HEADERS)
        }

        const stored = await loadStored(env, key)
        const base = stored.doc || { version: 1, marks: {}, unmarks: {}, settings: {}, meta: {} }
        const next = applyDayOp(base, op)
        const updatedAt = await saveDoc(env, key, next)
        return json(
          { ok: true, updatedAt, doc: next, day: op.day, entry: next.marks[op.day] || null },
          200,
          CORS_HEADERS
        )
      }

      return json({ error: 'not found' }, 404, CORS_HEADERS)
    }

    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'not found' }, 404, CORS_HEADERS)
    }

    // 其余全部交给静态资源（index.html / app.js / styles.css / icons …）
    return env.ASSETS.fetch(request)
  },
}
