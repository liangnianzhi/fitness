/**
 * analysis.js — 纯逻辑：日期、周期、统计、教练文案。
 *
 * 设计约束：
 *  1. 全部基于「本地时区」的年月日，绝不用 UTC 毫秒做跨日判断（否则东八区会出现跨日错位）。
 *  2. 一周从周一开始（符合中国用户日历习惯与 ISO-8601）。
 *  3. 不依赖 DOM / window，可直接在 Node 里单测。
 */

/** 周一为一周之始 */
export const WEEKDAY_CN = ['一', '二', '三', '四', '五', '六', '日']
export const WEEKDAY_FULL_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
export const MONTH_CN = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']

export const KIND_LABELS = {
  strength: '力量',
  cardio: '有氧',
  mobility: '拉伸',
  other: '其他',
}
export const KIND_KEYS = Object.keys(KIND_LABELS)

const DAY_MS = 86400000
const DEFAULT_ITEM_NAME = '训练'

/* ------------------------------------------------------------------ *
 * 日期基础
 * ------------------------------------------------------------------ */

/** Date -> 'YYYY-MM-DD'（本地时区） */
export function ymd(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 'YYYY-MM-DD' -> Date（本地 0 点） */
export function parseYmd(key) {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** 只保留年月日，避免时分秒参与比较；入参可以是 Date 或 'YYYY-MM-DD' */
export function dateOnly(date) {
  const d = typeof date === 'string' ? parseYmd(date) : date
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

export function addDays(date, n) {
  const d = dateOnly(date)
  d.setDate(d.getDate() + n)
  return d
}

export function addMonths(date, n) {
  const d = dateOnly(date)
  const day = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + n)
  // 处理 1/31 + 1 个月这类溢出（自动落到月末）
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(day, lastDay))
  return d
}

/** 所在周的周一 */
export function startOfWeek(date) {
  const d = dateOnly(date)
  const offset = (d.getDay() + 6) % 7 // 周一 = 0 … 周日 = 6
  return addDays(d, -offset)
}

export function endOfWeek(date) {
  return addDays(startOfWeek(date), 6)
}

export function startOfMonth(date) {
  const d = dateOnly(date)
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

export function endOfMonth(date) {
  const d = dateOnly(date)
  return new Date(d.getFullYear(), d.getMonth() + 1, 0)
}

/** ISO-8601 周序号：{ year, week }，跨年周归属以该周的周四所在年份为准 */
export function isoWeek(date) {
  const thursday = addDays(startOfWeek(date), 3)
  const year = thursday.getFullYear()
  const firstThursday = addDays(startOfWeek(new Date(year, 0, 4)), 3)
  const week = Math.round((thursday - firstThursday) / (7 * DAY_MS)) + 1
  return { year, week }
}

/** '2026-W42' */
export function weekKey(date) {
  const { year, week } = isoWeek(date)
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** '2026-10' */
export function monthKey(date) {
  const d = dateOnly(date)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** '2026-10-17' -> '2026/10/17'（打卡提示用这个格式） */
export function cnDate(key) {
  const [y, m, d] = key.split('-')
  return `${y}/${m}/${d}`
}

/** '2026-10-17' -> '10月17日 周六' */
export function cnDateFull(key) {
  const d = parseYmd(key)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAY_FULL_CN[(d.getDay() + 6) % 7]}`
}

/** '2026-10' -> '2026年10月' */
export function cnMonth(key) {
  const [y, m] = key.split('-')
  return `${y}年${Number(m)}月`
}

/** 两个日期相差的整天数（b - a） */
export function daysBetween(a, b) {
  return Math.round((dateOnly(b) - dateOnly(a)) / DAY_MS)
}

/** 闭区间内的所有日期键 */
export function rangeKeys(from, to) {
  const start = typeof from === 'string' ? parseYmd(from) : from
  const end = typeof to === 'string' ? parseYmd(to) : to
  const out = []
  const total = daysBetween(start, end)
  for (let i = 0; i <= total; i++) out.push(ymd(addDays(start, i)))
  return out
}

/** 生成月视图网格（补齐前后空位，周一开头，6 行 = 42 格） */
export function monthGrid(date) {
  const first = startOfMonth(date)
  const lead = (first.getDay() + 6) % 7
  const gridStart = addDays(first, -lead)
  const cells = []
  for (let i = 0; i < 42; i++) {
    const d = addDays(gridStart, i)
    cells.push({
      key: ymd(d),
      day: d.getDate(),
      inMonth: d.getMonth() === date.getMonth() && d.getFullYear() === date.getFullYear(),
    })
  }
  // 最后一行整行都在下个月时裁掉，视觉更紧凑
  while (cells.length > 35 && cells.slice(-7).every((c) => !c.inMonth)) cells.length -= 7
  return cells
}

/* ------------------------------------------------------------------ *
 * 打卡状态读取
 * ------------------------------------------------------------------ */

/**
 * 某天是否处于「已打卡」状态。
 * marks[key].t 晚于 unmarks[key] 才算已打卡 —— 这样多设备合并时就是干净的 last-write-wins。
 */
export function isChecked(state, key) {
  const mark = state && state.marks && state.marks[key]
  if (!mark) return false
  const unm = (state.unmarks && state.unmarks[key]) || 0
  return Number(mark.t || 0) > Number(unm || 0)
}

export function markOf(state, key) {
  return isChecked(state, key) ? state.marks[key] : null
}

/** 已打卡日期的升序数组 */
export function checkedKeys(state) {
  const marks = (state && state.marks) || {}
  return Object.keys(marks)
    .filter((k) => isChecked(state, k))
    .sort()
}

/** 指定日期区间内的统计 */
export function statsFor(state, from, to) {
  const keys = rangeKeys(from, to)
  const days = []
  let count = 0
  let minutes = 0
  const byKind = {}
  for (const key of keys) {
    const mark = markOf(state, key)
    const checked = !!mark
    if (checked) {
      count++
      minutes += Number(mark.mins || 0)
      // 按训练项目名分组（一天可能包含多个项目）
      for (const it of mark.items || []) {
        const name = it.name || DEFAULT_ITEM_NAME
        byKind[name] = (byKind[name] || 0) + 1
      }
    }
    days.push({ key, checked, mark })
  }
  return { from: typeof from === 'string' ? from : ymd(from), to: typeof to === 'string' ? to : ymd(to), keys, days, count, minutes, byKind }
}

/** 全部历史的连续打卡天数（截止到 today，允许今天还没打） */
export function streak(state, today) {
  const end = typeof today === 'string' ? parseYmd(today) : dateOnly(today)
  // 最长连续
  let best = 0
  let run = 0
  let prev = null
  for (const key of checkedKeys(state)) {
    const d = parseYmd(key)
    run = prev && daysBetween(prev, d) === 1 ? run + 1 : 1
    if (run > best) best = run
    prev = d
  }
  // 当前连续（今天没打就从昨天开始算，不算断）
  let current = 0
  let cursor = isChecked(state, ymd(end)) ? end : addDays(end, -1)
  while (isChecked(state, ymd(cursor))) {
    current++
    cursor = addDays(cursor, -1)
  }
  return { current, best }
}

/** 一周的明细（用于周视图与周回顾） */
export function weekDetail(state, date) {
  const start = startOfWeek(date)
  const end = endOfWeek(date)
  const stats = statsFor(state, start, end)
  return { ...stats, start, end, startKey: ymd(start), endKey: ymd(end), weekKey: weekKey(date) }
}

/** 一个月的明细 */
export function monthDetail(state, date) {
  const start = startOfMonth(date)
  const end = endOfMonth(date)
  const stats = statsFor(state, start, end)
  return { ...stats, start, end, startKey: ymd(start), endKey: ymd(end), monthKey: monthKey(date) }
}

/** 一年的明细 */
export function yearDetail(state, year) {
  const stats = statsFor(state, new Date(year, 0, 1), new Date(year, 11, 31))
  const months = []
  for (let m = 0; m < 12; m++) {
    const md = monthDetail(state, new Date(year, m, 1))
    months.push({ month: m, key: md.monthKey, count: md.count, minutes: md.minutes, days: md.days })
  }
  return { ...stats, year, months }
}

/* ------------------------------------------------------------------ *
 * 周 / 月回顾（教练文案）
 * ------------------------------------------------------------------ */

function pct(count, goal) {
  if (!goal) return count > 0 ? 2 : 0
  return count / goal
}

function trimTo2Sentences(text) {
  const parts = String(text)
    .split(/(?<=[。！？])/)
    .filter((s) => s.trim())
  return parts.slice(0, 2).join('')
}

/**
 * 上周回顾。返回结构化数据 + 一两句话点评。
 * @param {object} state
 * @param {Date|string} today
 */
export function weekReview(state, today) {
  const now = typeof today === 'string' ? parseYmd(today) : dateOnly(today)
  const thisWeekStart = startOfWeek(now)
  const lastWeekStart = addDays(thisWeekStart, -7)
  const prevWeekStart = addDays(thisWeekStart, -14)

  const last = weekDetail(state, lastWeekStart)
  const prev = weekDetail(state, prevWeekStart)
  const goal = Number((state.settings && state.settings.weekGoal) || 3)
  const hasAnyHistory = checkedKeys(state).length > 0

  const data = {
    type: 'week',
    periodKey: weekKey(lastWeekStart),
    label: `${cnDate(last.startKey)} – ${cnDate(last.endKey)}`,
    title: '上周回顾',
    count: last.count,
    goal,
    prevCount: prev.count,
    minutes: last.minutes,
    activeDays: last.count,
    delta: last.count - prev.count,
    hasPrevData: prev.count > 0,
    hasAnyHistory,
    empty: last.count === 0,
  }
  return { ...data, text: coachLine(data) }
}

/** 上月回顾 */
export function monthReview(state, today) {
  const now = typeof today === 'string' ? parseYmd(today) : dateOnly(today)
  const thisMonthStart = startOfMonth(now)
  const lastMonthDate = addMonths(thisMonthStart, -1)
  const prevMonthDate = addMonths(thisMonthStart, -2)

  const last = monthDetail(state, lastMonthDate)
  const prev = monthDetail(state, prevMonthDate)
  const goal = Number((state.settings && state.settings.monthGoal) || 12)
  const hasAnyHistory = checkedKeys(state).length > 0

  const data = {
    type: 'month',
    periodKey: monthKey(lastMonthDate),
    label: cnMonth(monthKey(lastMonthDate)),
    title: '上月回顾',
    count: last.count,
    goal,
    prevCount: prev.count,
    minutes: last.minutes,
    weeklyAvg: Math.round((last.count / Math.max(1, Math.round(rangeKeys(last.startKey, last.endKey).length / 7))) * 10) / 10,
    activeDays: last.count,
    delta: last.count - prev.count,
    hasPrevData: prev.count > 0,
    hasAnyHistory,
    empty: last.count === 0,
  }
  return { ...data, text: coachLine(data) }
}

/** 把统计翻译成一两句人话：先给事实，再给下一步计划 */
export function coachLine(d) {
  const isMonth = d.type === 'month'
  const unit = isMonth ? '上月' : '上周'
  const goal = d.goal
  const count = d.count
  const ratio = pct(count, goal)
  const delta = d.delta
  const deltaTxt =
    d.hasPrevData && delta !== 0
      ? `，比${isMonth ? '上上月' : '前一周'}${delta > 0 ? '多' : '少'} ${Math.abs(delta)} 次`
      : ''

  if (count === 0) {
    return trimTo2Sentences(
      `${unit}一次都没打卡${d.hasPrevData ? `，比${isMonth ? '上上月' : '前一周'}少了 ${Math.abs(prevDelta(d))} 次` : ''}，节奏断了。` +
        (isMonth
          ? '本月别追次数：先定 3 次 × 20 分钟，做完就算赢，把「能开始」放在「练得狠」前面。'
          : '今天先做 10 分钟拉伸把状态接回来，本周补 3 次、每次 30 分钟。')
    )
  }

  if (ratio >= 1) {
    const over = count - goal
    return trimTo2Sentences(
      `${unit}打卡 ${count} 次，${over >= 2 ? `超额 ${over} 次` : '达成'}目标（${goal} 次）${deltaTxt}。` +
        (isMonth
          ? '节奏很稳，本月照这个安排继续，别临时加量。'
          : '节奏很稳，本周照原样保持，别临时加量。')
    )
  }

  if (ratio >= 0.6) {
    const gap = goal - count
    const plan = isMonth ? '每周 3 次、每次 30 分钟' : '3 次、每次 30 分钟'
    return trimTo2Sentences(
      `${unit}打卡 ${count} 次，差 ${gap} 次没到 ${goal} 次目标${deltaTxt}，属于略松懈。` +
        `本${isMonth ? '月' : '周'}把训练拆小并固定时段：${plan}，先锁周二、周四、周六，做完再谈加量。`
    )
  }

  const plan = isMonth ? '每周 3 次 × 20 分钟' : '3 次 × 20 分钟'
  return trimTo2Sentences(
    `${unit}只打卡 ${count} 次，离 ${goal} 次目标差得比较多${deltaTxt}。` +
      `本${isMonth ? '月' : '周'}别定高目标，先做到 ${plan}，完成就算达标。`
  )
}

function prevDelta(d) {
  return d.prevCount || 0
}

/**
 * 本周/本月进行中的进度（用于顶部统计条与「接下来该做到什么」的提示）
 */
export function currentProgress(state, today) {
  const now = typeof today === 'string' ? parseYmd(today) : dateOnly(today)
  const week = weekDetail(state, now)
  const month = monthDetail(state, now)
  const weekGoal = Number((state.settings && state.settings.weekGoal) || 3)
  const monthGoal = Number((state.settings && state.settings.monthGoal) || 12)
  const remainDays = daysBetween(now, week.end) + 1
  const weekRemain = Math.max(0, weekGoal - week.count)
  return {
    week,
    month,
    weekGoal,
    monthGoal,
    weekRemain,
    remainDays,
    hint: weekRemain === 0 ? '本周目标已完成' : `本周还差 ${weekRemain} 次，剩 ${remainDays} 天`,
  }
}
