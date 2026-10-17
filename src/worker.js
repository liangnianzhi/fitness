/**
 * Cloudflare Worker：静态资源 + 可选云端同步 + 配置下发。
 *
 * 路由：
 *   GET  /api/config               前端探测能力（是否配了 KV）
 *   GET  /api/state/:id            读取云端备份
 *   PUT  /api/state/:id            写入云端备份
 *   其它                            交给静态资源（assets binding）
 *
 * 设计取舍：
 *   - 没配 KV 时一切照常工作，前端自动降级为「仅本机保存」，不报错、不影响打卡。
 *   - 同步口令就是访问凭证，所以只接受足够长的随机串，并限制单条体积。
 */

const SYNC_ID_RE = /^[A-Za-z0-9_-]{16,64}$/
const MAX_BODY_BYTES = 256 * 1024
const MAX_DAYS = 4000 // 约 10 年的打卡记录，防止被灌爆
const EFFORT_IDS = ['easy', 'normal', 'hard', 'drained', 'maxed']
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, OPTIONS',
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

/** 校验前端提交的文档，只保留结构合法的部分 */
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
    // 一次健身日程可以包含多个项目，每个项目有自己的时长与辛苦程度
    const items = Array.isArray(m.items)
      ? m.items
          .filter((it) => it && typeof it === 'object' && typeof it.name === 'string' && it.name.trim())
          .slice(0, 12)
          .map((it) => ({
            name: String(it.name).trim().slice(0, 12),
            mins: Number.isFinite(Number(it.mins)) ? Math.max(1, Math.min(600, Math.round(Number(it.mins)))) : 40,
            effort: EFFORT_IDS.includes(it.effort) ? it.effort : 'normal',
          }))
      : []

    cleanMarks[key] = {
      t: Number.isFinite(Number(m.t)) ? Math.max(0, Math.round(Number(m.t))) : 0,
      mins: Number.isFinite(Number(m.mins)) ? Math.max(1, Math.min(600, Math.round(Number(m.mins)))) : 40,
      effort: EFFORT_IDS.includes(m.effort) ? m.effort : 'normal',
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
        },
        200,
        CORS_HEADERS
      )
    }

    if (url.pathname.startsWith('/api/state/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/state/'.length))
      if (!SYNC_ID_RE.test(id)) {
        return json({ error: '同步口令格式不合法（需 16–64 位字母、数字、- 或 _）' }, 400, CORS_HEADERS)
      }
      if (!env.CHECKINS) {
        return json({ error: '该 Worker 未绑定 KV（CHECKINS），云端同步不可用' }, 501, CORS_HEADERS)
      }

      const key = `state:${id}`

      if (request.method === 'GET') {
        const stored = await env.CHECKINS.get(key, 'json')
        if (!stored) return json({ ok: true, doc: null }, 200, CORS_HEADERS)
        return json({ ok: true, doc: stored.doc || null, updatedAt: stored.updatedAt || null }, 200, CORS_HEADERS)
      }

      if (request.method === 'PUT') {
        const length = Number(request.headers.get('content-length') || 0)
        if (length > MAX_BODY_BYTES) {
          return json({ error: '记录体积过大' }, 413, CORS_HEADERS)
        }
        let body
        try {
          const text = await request.text()
          if (text.length > MAX_BODY_BYTES) return json({ error: '记录体积过大' }, 413, CORS_HEADERS)
          body = JSON.parse(text)
        } catch {
          return json({ error: '请求体不是合法 JSON' }, 400, CORS_HEADERS)
        }
        const doc = sanitizeDoc(body)
        if (!doc) return json({ error: '记录结构不合法' }, 400, CORS_HEADERS)

        const updatedAt = new Date().toISOString()
        await env.CHECKINS.put(key, JSON.stringify({ doc, updatedAt }))
        return json({ ok: true, updatedAt }, 200, CORS_HEADERS)
      }

      return json({ error: '方法不支持' }, 405, CORS_HEADERS)
    }

    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'not found' }, 404, CORS_HEADERS)
    }

    // 其余全部交给静态资源（index.html / app.js / styles.css / icons …）
    return env.ASSETS.fetch(request)
  },
}
