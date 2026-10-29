/**
 * store.js — 状态结构、多设备合并、本地持久化、可选云端同步。
 *
 * 存储策略（为什么不是纯 localStorage）：
 *   iOS Safari 的 ITP 会在「连续 7 天未交互」后清理脚本可写存储（localStorage / IndexedDB）。
 *   对一个每天只打开一次的健身打卡应用来说这是真实风险，所以：
 *    - localStorage 是主存储（离线可用、零延迟）；
 *    - Cloudflare KV 是可选备份（配了 KV 就会自动双向同步），换手机扫码也不会丢记录。
 *
 * 数据模型（v2）：
 *   一天 = 一次「健身日程」，可包含多个训练项目，每个项目带自己的时长与辛苦程度。
 *     marks['2026-10-17'] = {
 *       t,                 // 打卡时间戳，用于多设备 last-write-wins
 *       mins,              // 总时长（派生值，冗余存一份便于快速统计）
 *       effort,            // 整体辛苦程度 id（派生：各项目取最高档）
 *       items: [ { name, mins, effort } ]
 *     }
 *   自定义标签与快捷项目放在 settings.customTags / settings.quickItems，
 *   它们会随状态一起同步，所以换设备也不用重新添加。
 */

export const STORAGE_KEY = 'fitcal.state.v1'
export const SCHEMA_VERSION = 2

/** 默认时长与时长候选 */
export const DEFAULT_MINS = 40
export const MINS_CHOICES = [20, 30, 45, 60, 90]

/** 辛苦程度：五档，从轻到重（id 一经确定不再改动，避免历史数据失配） */
export const EFFORT_LEVELS = [
  { id: 'easy', label: '轻松', hint: '像热身，能边练边聊天' },
  { id: 'normal', label: '适中', hint: '有出汗，呼吸略快' },
  { id: 'hard', label: '吃力', hint: '说话费劲，但还能坚持' },
  { id: 'drained', label: '脱力', hint: '练完直接瘫，需要恢复' },
  { id: 'maxed', label: '力竭', hint: '最后一组完全做不动' },
]
export const EFFORT_IDS = EFFORT_LEVELS.map((e) => e.id)
export const DEFAULT_EFFORT = 'normal'

/** 找不到任何项目名时的兜底标签 */
const DEFAULT_ITEM_NAME = '训练'

/** 内置常用项目（用户自定义的会追加到后面） */
export const BUILTIN_QUICK_ITEMS = ['跑步机', '力量训练', '拉伸', '团操', '动感单车', '游泳']

/** 单个标签名的长度与数量上限，防止云端被灌爆 */
const MAX_TAG_LEN = 12
const MAX_CUSTOM_TAGS = 40
const MAX_ITEMS_PER_DAY = 12

/* ------------------------------------------------------------------ *
 * 状态骨架
 * ------------------------------------------------------------------ */

export function emptyState() {
  return {
    version: SCHEMA_VERSION,
    marks: {}, // 'YYYY-MM-DD' -> { t, mins, effort, items: [{ name, mins, effort }] }
    unmarks: {}, // 'YYYY-MM-DD' -> t   （取消打卡的时间戳，用于多设备 last-write-wins）
    settings: {
      weekGoal: 3,
      monthGoal: 12,
      defaultMins: DEFAULT_MINS,
      defaultEffort: DEFAULT_EFFORT,
      quickItems: [], // 用户自定义的训练项目（与内置项合并使用）
      customTags: [], // 「其他」里手动添加过的标签
      itemMins: {}, // 每个标签上一次用的时长，下次自动带出
      aiAuto: true, // 首次进入新周/新月时自动生成分析
      syncId: '',
    },
    meta: {
      updatedAt: 0,
      settingsAt: 0,
      lastWeeklySeen: '',
      lastMonthlySeen: '',
      seeded: false,
    },
  }
}

function num(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function clampedInt(v, fallback, min, max) {
  const n = Math.round(num(v, fallback))
  return Math.min(max, Math.max(min, n))
}

/** 标签名清洗：去首尾空白、压缩内部空格、限制长度 */
export function cleanTag(raw) {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LEN)
}

/** 去重但保留首次出现的顺序 */
function uniqueTags(list) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    const tag = cleanTag(item)
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
    if (out.length >= MAX_CUSTOM_TAGS) break
  }
  return out
}

/** 辛苦程度：非法值回落到默认档 */
export function normalizeEffort(raw) {
  return EFFORT_IDS.includes(raw) ? raw : DEFAULT_EFFORT
}

/** 档位数字，用于比较「最高档」与统计分布 */
export function effortRank(id) {
  const i = EFFORT_IDS.indexOf(id)
  return i < 0 ? EFFORT_IDS.indexOf(DEFAULT_EFFORT) : i
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
      mins: clampedInt(it.mins, fallbackMins, 1, 600),
      effort: normalizeEffort(it.effort || fallbackEffort),
    })
    if (out.length >= MAX_ITEMS_PER_DAY) break
  }
  return out
}

/** 由 items 推导整天的总时长与辛苦程度（各项目取最高档） */
export function deriveDay(items) {
  const list = Array.isArray(items) ? items : []
  const mins = list.reduce((sum, it) => sum + Number(it.mins || 0), 0)
  let effort = list.length ? 'easy' : DEFAULT_EFFORT
  for (const it of list) {
    if (effortRank(it.effort) > effortRank(effort)) effort = it.effort
  }
  return { mins, effort }
}

/** 容错地把任意输入规整成合法状态（脏数据、旧版本、手工改过的 hash 都不会炸） */
export function normalizeState(raw) {
  const base = emptyState()
  if (!raw || typeof raw !== 'object') return base
  const out = base

  const s = raw.settings && typeof raw.settings === 'object' ? raw.settings : {}
  out.settings.weekGoal = clampedInt(s.weekGoal, base.settings.weekGoal, 1, 14)
  out.settings.monthGoal = clampedInt(s.monthGoal, base.settings.monthGoal, 1, 60)
  out.settings.defaultMins = clampedInt(s.defaultMins, DEFAULT_MINS, 5, 300)
  out.settings.defaultEffort = normalizeEffort(s.defaultEffort)
  out.settings.quickItems = uniqueTags(Array.isArray(s.quickItems) ? s.quickItems : [])
  out.settings.customTags = uniqueTags(Array.isArray(s.customTags) ? s.customTags : [])
  out.settings.aiAuto = s.aiAuto === undefined ? true : !!s.aiAuto
  out.settings.syncId = typeof s.syncId === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(s.syncId) ? s.syncId : ''

  // 每个标签的常用时长
  const itemMins = s.itemMins && typeof s.itemMins === 'object' ? s.itemMins : {}
  for (const [name, mins] of Object.entries(itemMins)) {
    const tag = cleanTag(name)
    if (tag) out.settings.itemMins[tag] = clampedInt(mins, DEFAULT_MINS, 1, 600)
  }

  const marks = raw.marks && typeof raw.marks === 'object' ? raw.marks : {}
  for (const [key, value] of Object.entries(marks)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !value || typeof value !== 'object') continue
    const t = num(value.t, 0)
    const fallbackMins = clampedInt(value.mins, DEFAULT_MINS, 1, 600)
    const fallbackEffort = normalizeEffort(value.effort)

    let items = normalizeItems(value.items, fallbackMins, fallbackEffort)
    if (!items.length) {
      // v1 数据迁移：只有 kind + mins 的老记录，转成一条同名项目
      const legacyName = cleanTag(value.kind) || '训练'
      items = [{ name: legacyName, mins: fallbackMins, effort: fallbackEffort }]
    }
    const derived = deriveDay(items)
    out.marks[key] = {
      t,
      mins: derived.mins,
      effort: derived.effort,
      items,
    }
  }

  const unmarks = raw.unmarks && typeof raw.unmarks === 'object' ? raw.unmarks : {}
  for (const [key, value] of Object.entries(unmarks)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue
    const t = num(value, 0)
    if (t > 0) out.unmarks[key] = t
  }

  const m = raw.meta && typeof raw.meta === 'object' ? raw.meta : {}
  out.meta.updatedAt = Math.max(0, num(m.updatedAt, 0))
  out.meta.settingsAt = Math.max(0, num(m.settingsAt, 0))
  out.meta.lastWeeklySeen = typeof m.lastWeeklySeen === 'string' ? m.lastWeeklySeen : ''
  out.meta.lastMonthlySeen = typeof m.lastMonthlySeen === 'string' ? m.lastMonthlySeen : ''
  out.meta.seeded = !!m.seeded

  return out
}

/**
 * 合并两个状态（多设备同步的核心）。
 * 规则：按天 last-write-wins；已打卡/取消打卡各自取最新时间戳，二者再比大小决定最终状态。
 */
export function mergeStates(a, b) {
  const A = normalizeState(a)
  const B = normalizeState(b)
  const out = emptyState()

  for (const key of new Set([...Object.keys(A.marks), ...Object.keys(B.marks)])) {
    const ma = A.marks[key]
    const mb = B.marks[key]
    if (ma && mb) out.marks[key] = ma.t >= mb.t ? ma : mb
    else out.marks[key] = ma || mb
  }
  for (const key of new Set([...Object.keys(A.unmarks), ...Object.keys(B.unmarks)])) {
    const ua = A.unmarks[key] || 0
    const ub = B.unmarks[key] || 0
    const t = Math.max(ua, ub)
    if (t > 0) out.unmarks[key] = t
  }

  // 设置：谁最后改过听谁的；syncId 只要有一边有就保留
  out.settings = A.meta.settingsAt >= B.meta.settingsAt ? { ...A.settings } : { ...B.settings }
  out.settings.syncId = A.settings.syncId || B.settings.syncId
  // 自定义标签两边取并集，避免在一台设备上添加的标签被另一半状态覆盖掉
  out.settings.customTags = uniqueTags([...A.settings.customTags, ...B.settings.customTags])
  out.settings.quickItems = uniqueTags([...A.settings.quickItems, ...B.settings.quickItems])
  out.settings.itemMins = { ...A.settings.itemMins, ...B.settings.itemMins }

  out.meta.updatedAt = Math.max(A.meta.updatedAt, B.meta.updatedAt)
  out.meta.settingsAt = Math.max(A.meta.settingsAt, B.meta.settingsAt)
  // 「已看过某周/某月回顾」取更靠后的一个，避免在另一台设备上重复弹分析
  out.meta.lastWeeklySeen = A.meta.lastWeeklySeen > B.meta.lastWeeklySeen ? A.meta.lastWeeklySeen : B.meta.lastWeeklySeen
  out.meta.lastMonthlySeen = A.meta.lastMonthlySeen > B.meta.lastMonthlySeen ? A.meta.lastMonthlySeen : B.meta.lastMonthlySeen
  out.meta.seeded = A.meta.seeded || B.meta.seeded

  return out
}

/** 清理过期的取消打卡记录，避免无限膨胀 */
export function pruneTombstones(state, todayKey, keepDays = 180) {
  const out = normalizeState(state)
  const cutoff = new Date(todayKey + 'T00:00:00')
  cutoff.setDate(cutoff.getDate() - keepDays)
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`
  for (const key of Object.keys(out.unmarks)) {
    if (key < cutoffKey) delete out.unmarks[key]
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 变更操作（都返回新对象，方便对比与撤销）
 * ------------------------------------------------------------------ */

/**
 * 打卡 / 更新某天的健身日程。
 * patch.items 存在时以它为准；否则用 patch.name/mins/effort 拼一条单项目日程，
 * 都缺省时沿用该天原有内容，再没有就用默认值。
 */
export function markDay(state, key, patch = {}) {
  const next = normalizeState(state)
  const before = next.marks[key]
  const t = patch.t || Date.now()

  let items
  if (Array.isArray(patch.items)) {
    items = normalizeItems(patch.items, next.settings.defaultMins, next.settings.defaultEffort)
  } else {
    const name =
      cleanTag(patch.name) || (before && before.items[0] && before.items[0].name) || DEFAULT_ITEM_NAME
    const mins = clampMins(patch.mins, before && before.mins, next.settings.defaultMins)
    const effort = normalizeEffort(
      patch.effort || (before && before.effort) || next.settings.defaultEffort
    )
    items = [{ name, mins, effort }]
  }
  if (!items.length) {
    items = [{ name: DEFAULT_ITEM_NAME, mins: next.settings.defaultMins, effort: next.settings.defaultEffort }]
  }

  const derived = deriveDay(items)
  next.marks[key] = { t, mins: derived.mins, effort: derived.effort, items }
  delete next.unmarks[key]
  next.meta.updatedAt = Date.now()
  return next
}

function clampMins(raw, before, fallback) {
  const v = raw !== undefined ? raw : before !== undefined ? before : fallback
  return clampedInt(v, fallback, 1, 600)
}

export function unmarkDay(state, key) {
  const next = normalizeState(state)
  delete next.marks[key]
  next.unmarks[key] = Date.now()
  next.meta.updatedAt = Date.now()
  return next
}

export function setSettings(state, patch) {
  const next = normalizeState(state)
  const s = { ...next.settings, ...patch }
  next.settings = normalizeState({ settings: s }).settings
  next.meta.settingsAt = Date.now()
  next.meta.updatedAt = next.meta.settingsAt
  return next
}

/* -------- 自定义标签（「其他」里添加后固定下来，可跨设备同步） -------- */

/** 记住一个自定义项目：同时进 customTags 与快捷列表，并记住它的时长 */
export function addCustomTag(state, rawName, mins) {
  const name = cleanTag(rawName)
  const next = normalizeState(state)
  if (!name) return next
  const inBuiltin = BUILTIN_QUICK_ITEMS.includes(name)
  return setSettings(next, {
    customTags: uniqueTags([...next.settings.customTags, name]),
    quickItems: inBuiltin ? next.settings.quickItems : uniqueTags([...next.settings.quickItems, name]),
    itemMins: { ...next.settings.itemMins, [name]: clampMins(mins, undefined, next.settings.defaultMins) },
  })
}

/** 删除一个自定义项目（内置项不可删） */
export function removeCustomTag(state, rawName) {
  const name = cleanTag(rawName)
  const next = normalizeState(state)
  if (!name || BUILTIN_QUICK_ITEMS.includes(name)) return next
  const itemMins = { ...next.settings.itemMins }
  delete itemMins[name]
  return setSettings(next, {
    customTags: next.settings.customTags.filter((t) => t !== name),
    quickItems: next.settings.quickItems.filter((t) => t !== name),
    itemMins,
  })
}

/** 记住某个标签上次用的时长，下次点它自动带出 */
export function rememberItemMins(state, rawName, mins) {
  const name = cleanTag(rawName)
  if (!name) return normalizeState(state)
  const next = normalizeState(state)
  return setSettings(next, {
    itemMins: { ...next.settings.itemMins, [name]: clampMins(mins, undefined, next.settings.defaultMins) },
  })
}

export function setMeta(state, patch) {
  const next = normalizeState(state)
  next.meta = { ...next.meta, ...patch }
  return next
}

/* ------------------------------------------------------------------ *
 * 本地持久化
 * ------------------------------------------------------------------ */

export function loadLocal(storage = globalThis.localStorage) {
  if (!storage) return emptyState()
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return emptyState()
    return normalizeState(JSON.parse(raw))
  } catch {
    return emptyState()
  }
}

export function saveLocal(state, storage = globalThis.localStorage) {
  if (!storage) return false
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

export function serialize(state) {
  return JSON.stringify(normalizeState(state))
}

/* ------------------------------------------------------------------ *
 * 同步 ID 与云端同步
 * ------------------------------------------------------------------ */

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

/** 生成同步口令（同时充当访问密钥，所以取 22 位、去易混字符） */
export function generateSyncId(length = 22) {
  const bytes = new Uint8Array(length)
  const c = globalThis.crypto
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes)
  else for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256)
  let out = ''
  for (let i = 0; i < length; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length]
  return out
}

export function isValidSyncId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(id)
}

/** Worker 同步客户端；注入 fetch 便于测试 */
export function createSync(fetchImpl, basePath = '/api') {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis)
  const client = {
    async pull(syncId) {
      const res = await doFetch(`${basePath}/state/${encodeURIComponent(syncId)}`, {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) throw new Error(`pull failed: ${res.status}`)
      const data = await res.json()
      return data && data.doc ? normalizeState(data.doc) : null
    },
    async push(syncId, state) {
      const res = await doFetch(`${basePath}/state/${encodeURIComponent(syncId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: serialize(state),
      })
      if (!res.ok) throw new Error(`push failed: ${res.status}`)
      return true
    },
    /**
     * 安全推送：先让服务端按天合并再返回最终文档。
     * 机器人或其他设备在我们开着页面时写入的打卡，不会被这次推送覆盖。
     * 老版本 Worker 没有 /merge 时退回普通 push，保证不炸。
     */
    async merge(syncId, state) {
      const res = await doFetch(`${basePath}/state/${encodeURIComponent(syncId)}/merge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: serialize(state),
      })
      if (res.status === 404 || res.status === 405) return client.push(syncId, state)
      if (!res.ok) throw new Error(`merge failed: ${res.status}`)
      const data = await res.json()
      return data && data.doc ? normalizeState(data.doc) : true
    },
    async config() {
      try {
        const res = await doFetch(`${basePath}/config`, { headers: { accept: 'application/json' } })
        if (!res.ok) return { store: false }
        return await res.json()
      } catch {
        return { store: false }
      }
    },
    /**
     * 找回同步口令。
     *
     * 场景：手机上 localStorage 被 iOS 清掉、或换了个浏览器打开，
     * 本机没有 syncId 就永远不拉云端，用户会以为记录丢了。
     * 这里向 Worker 询问当前活跃口令，把它写回本地即可自愈。
     *
     * 只读、不写入数据；拿不到就返回 null，页面照常本机可用。
     */
    async discover(syncId) {
      try {
        const res = await doFetch(`${basePath}/active`, {
          headers: { accept: 'application/json', 'x-fitcal-client': '1' },
        })
        if (!res.ok) return null
        const data = await res.json()
        const id = data && data.syncId
        if (typeof id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(id)) return id
        return null
      } catch {
        return null
      }
    },
  }
  return client
}
