import {
  KIND_LABELS,
  MONTH_CN,
  WEEKDAY_CN,
  WEEKDAY_FULL_CN,
  addDays,
  addMonths,
  cnDate,
  cnDateFull,
  currentProgress,
  endOfWeek,
  isChecked,
  markOf,
  monthGrid,
  monthDetail,
  monthKey,
  monthReview,
  parseYmd,
  startOfMonth,
  startOfWeek,
  streak,
  weekDetail,
  weekKey,
  weekReview,
  yearDetail,
  ymd,
} from './analysis.js'
import {
  BUILTIN_QUICK_ITEMS,
  EFFORT_LEVELS,
  MINS_CHOICES,
  addCustomTag,
  createSync,
  emptyState,
  generateSyncId,
  isValidSyncId,
  loadLocal,
  markDay,
  mergeStates,
  normalizeState,
  pruneTombstones,
  rememberItemMins,
  removeCustomTag,
  saveLocal,
  serialize,
  setMeta,
  setSettings,
  unmarkDay,
} from './store.js'

const PAGEAGENT_SRC = 'https://cdn.jsdelivr.net/npm/page-agent@1.12.4/dist/iife/page-agent.demo.js'
/** 国内镜像：jsDelivr 打不开时自动回退（官方中文 README 给的就是这个地址） */
const PAGEAGENT_MIRROR = 'https://registry.npmmirror.com/page-agent/1.12.4/files/dist/iife/page-agent.demo.js'
/** page-agent 官方内置的免费测试模型（仅用于技术评估） */
const DEMO_BASE_URL = 'https://page-ag-testing-ohftxirgbn.cn-shanghai.fcapp.run'
const DEMO_MODEL = 'qwen3.5-plus'

/* ================================================================== *
 * 1. 小工具
 * ================================================================== */

const $ = (id) => document.getElementById(id)

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = text
  return node
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 触感反馈（iOS 需要用户手势触发，失败静默） */
function haptic(type) {
  try {
    if (!navigator.vibrate) return
    navigator.vibrate(type === 'strong' ? 18 : 8)
  } catch {
    /* ignore */
  }
}

const ICON_CHECK = '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7"/></svg>'

/**
 * 添加自定义训练项目（「其他」）。
 * 输入框里的名字会存成固定标签，之后在项目列表里一直可选，并记住它的时长。
 */
function addCustomTagFromInput() {
  const input = $('customTagInput')
  const raw = (input.value || '').trim()
  if (!raw) {
    showToast({ text: '先输入项目名称', icon: 'warn' })
    return
  }
  const name = raw.replace(/\s+/g, ' ').slice(0, 12)
  const exists = quickItemList().includes(name)
  if (exists) {
    // 已经存在就直接选中它，别重复添加
    if (!editDraft.items.some((it) => it.name === name)) toggleDraftItem(name)
    input.value = ''
    showToast({ text: `「${name}」已在列表里`, icon: 'none' })
    return
  }
  state = addCustomTag(state, name, state.settings.defaultMins)
  if (!editDraft.items.some((it) => it.name === name)) {
    editDraft.items.push({
      name,
      mins: state.settings.defaultMins,
      effort: editDraft.effort,
    })
  }
  persist()
  input.value = ''
  input.blur()
  renderEditBody()
  haptic()
  showToast({ text: `已添加「${name}」`, icon: 'none' })
}

/**
 * Toast：底部胶囊提示，可带「撤销」。
 * 打卡成功提示要满足「2026/10/17 健身打卡成功」这种明确日期反馈。
 */
const toastLayer = $('toastLayer')
let toastTimer = 0

function showToast({ text, icon = 'success', undoLabel, onUndo, duration = 2600 }) {
  toastLayer.innerHTML = ''
  const box = el('div', `toast${icon === 'warn' ? ' warn' : icon === 'none' ? ' plain' : ''}`)
  if (icon !== 'none') {
    const ic = el('span', 't-icon')
    ic.innerHTML = ICON_CHECK
    box.appendChild(ic)
  }
  box.appendChild(el('span', 't-text', text))
  if (undoLabel && onUndo) {
    const btn = el('button', 't-undo', undoLabel)
    btn.type = 'button'
    btn.addEventListener('click', () => {
      hideToast()
      onUndo()
    })
    box.appendChild(btn)
  }
  toastLayer.appendChild(box)
  requestAnimationFrame(() => box.classList.add('show'))

  clearTimeout(toastTimer)
  toastTimer = setTimeout(hideToast, duration)
}

function hideToast() {
  const box = toastLayer.firstElementChild
  if (!box) return
  box.classList.remove('show')
  setTimeout(() => {
    if (box.parentNode) box.parentNode.removeChild(box)
  }, 260)
}

/* 底部抽屉 */
let openSheetId = null

const SHEET_BACKDROPS = {
  editSheet: 'sheetBackdrop',
  settingsSheet: 'settingsBackdrop',
  aiSheet: 'aiBackdrop',
}

function closeSheet(id) {
  const sheet = $(id)
  const bgId = SHEET_BACKDROPS[id]
  const bg = bgId ? $(bgId) : null
  if (sheet) sheet.classList.remove('show')
  if (bg) bg.classList.remove('show')
  if (openSheetId === id) openSheetId = null
  setTimeout(() => {
    if (sheet) sheet.hidden = true
    if (bg) bg.hidden = true
    if (!openSheetId) document.body.classList.remove('sheet-open')
  }, 300)
}

function openSheetFn(id, backdropId) {
  if (openSheetId && openSheetId !== id) closeSheet(openSheetId)
  const sheet = $(id)
  const bg = $(backdropId)
  bg.hidden = false
  sheet.hidden = false
  document.body.classList.add('sheet-open')
  requestAnimationFrame(() => {
    bg.classList.add('show')
    sheet.classList.add('show')
  })
  openSheetId = id
}

/* ================================================================== *
 * 2. 状态
 * ================================================================== */

const storage = (() => {
  try {
    return window.localStorage
  } catch {
    return null
  }
})()

let state = loadLocal(storage)
let view = 'month'
let cursor = new Date() // 当前查看的周期锚点
let selection = ymd(new Date()) // 选中的日期（打卡按钮跟随它）
const cloud = { enabled: false }

const sync = createSync()

function persist() {
  saveLocal(state, storage)
  schedulePush()
}

/**
 * 用户授权闸门。
 *
 * 为什么需要它：
 *  - 打开网页就自动请求外部 LLM 接口属于「未激活的外部服务」，iOS Safari 会拦；
 *  - 部分模型服务（包括 page-agent 的免费测试接口）会要求用户显式确认后才发起请求。
 * 所以在第一次真正调用模型前，弹一个原生确认框，由用户点「允许」。
 * 一旦授权过（记住 7 天），后续每周/每月的自动分析就无需再打扰。
 */
const CONSENT_KEY = 'fitcal.aiConsent.v1'

function hasConsent(kind) {
  try {
    const map = JSON.parse((storage && storage.getItem(CONSENT_KEY)) || '{}')
    const at = Number(map[kind] || 0)
    return at > 0 && Date.now() - at < 7 * 24 * 3600 * 1000
  } catch {
    return false
  }
}

function grantConsent(kind) {
  try {
    const map = JSON.parse((storage && storage.getItem(CONSENT_KEY)) || '{}')
    map[kind] = Date.now()
    storage.setItem(CONSENT_KEY, JSON.stringify(map))
  } catch {
    /* ignore */
  }
}

/** 浏览器原生确认（iOS 上会渲染成系统弹窗） */
function userActivated(kind) {
  if (hasConsent(kind)) return Promise.resolve(true)
  const ok = window.confirm(
    '使用 AI 教练分析这段时间的打卡？\n\n' +
      '—— 会把「打卡次数、目标、时长」这些统计数字发送给模型服务，不会发送任何个人信息。\n' +
      '—— 7 天内不再询问；不想用可以点「取消」，页面会显示本地离线分析。'
  )
  if (ok) grantConsent(kind)
  return Promise.resolve(ok)
}

/** 跨过午夜、或从后台切回前台时，需要把「今天」和当前周期刷新掉 */
let todayKey = ymd(new Date())
function refreshTodayIfNeeded() {
  const now = ymd(new Date())
  if (now !== todayKey) {
    todayKey = now
    cursor = new Date()
    if (view === 'month' || view === 'week') selection = now
    renderAll()
    maybeShowReview('auto')
  }
}

/* -------- 云端同步（可选，配了 KV 才生效） -------- */

let pushTimer = 0
let syncing = false

function schedulePush() {
  if (!cloud.enabled || !state.settings.syncId) return
  clearTimeout(pushTimer)
  pushTimer = setTimeout(pushNow, 1200)
}

async function pushNow() {
  if (!cloud.enabled || !state.settings.syncId || syncing) return
  syncing = true
  try {
    // 优先走服务端合并：手机开着页面时，机器人在其他渠道写入的打卡不会被覆盖
    if (typeof sync.merge === 'function') {
      const merged = await sync.merge(state.settings.syncId, state)
      if (merged && merged !== true) {
        const before = JSON.stringify(state.marks) + JSON.stringify(state.unmarks)
        const after = JSON.stringify(merged.marks) + JSON.stringify(merged.unmarks)
        state = merged
        saveLocal(state, storage)
        // 只有云端确实多了东西才重绘，避免每次自动保存都闪一下
        if (before !== after) renderAll()
      }
    } else {
      await sync.push(state.settings.syncId, state)
    }
    setSyncLabel('已同步')
  } catch {
    setSyncLabel('同步失败，稍后重试')
  } finally {
    syncing = false
  }
}

async function pullAndMerge() {
  if (!cloud.enabled || !state.settings.syncId) return false
  try {
    const remote = await sync.pull(state.settings.syncId)
    if (remote) {
      state = mergeStates(state, remote)
      saveLocal(state, storage)
      renderAll()
    }
    await pushNow()
    return true
  } catch {
    setSyncLabel('云端拉取失败')
    return false
  }
}

function setSyncLabel(text) {
  const node = $('syncState')
  if (node) node.textContent = text
}

async function initSync() {
  const cfg = await sync.config().catch(() => ({ store: false }))
  cloud.enabled = !!cfg.store
  if (!cloud.enabled) {
    setSyncLabel('记录只保存在本机（可在设置里开启跨设备同步）')
    return
  }
  setSyncLabel(state.settings.syncId ? '正在同步…' : '本机保存中 · 可在设置里开启跨设备同步')
  if (state.settings.syncId) await pullAndMerge()
  else renderAll()
}

/* ================================================================== *
 * 3. 渲染
 * ================================================================== */

const viewport = $('viewport')
const periodTitle = $('periodTitle')
const periodSubtitle = $('periodSubtitle')
const weekdaysRow = $('weekdays')
const metricsBox = $('metrics')
const reviewsBox = $('reviews')
const recentBox = $('recent')
const checkinBtn = $('checkinBtn')
const checkinLabel = $('checkinLabel')
const checkinSub = $('checkinSub')
const segButtons = [...document.querySelectorAll('.segmented button')]
const segThumb = $('segThumb')

function renderAll() {
  const now = new Date()
  periodTitle.textContent = headerTitle()
  periodSubtitle.textContent = headerSubtitle()
  // 每次重渲染都先清空，否则翻页会把旧网格叠在下面
  viewport.innerHTML = ''
  viewport.appendChild(
    view === 'week' ? renderWeek(now) : view === 'month' ? renderMonth(now) : renderYear(now)
  )
  renderMetrics()
  renderCheckinButton()
  renderRecent()
  updateSegment()
  todayKey = ymd(now)
}

function headerTitle() {
  if (view === 'week') {
    const s = startOfWeek(cursor)
    const e = endOfWeek(cursor)
    return `${s.getMonth() + 1}月${s.getDate()}日 – ${e.getMonth() + 1}月${e.getDate()}日`
  }
  if (view === 'month') return `${cursor.getFullYear()}年${cursor.getMonth() + 1}月`
  return `${cursor.getFullYear()}年`
}

function headerSubtitle() {
  if (view === 'week') {
    const wk = weekKey(cursor)
    const d = weekDetail(state, cursor)
    return `第 ${Number(wk.split('-W')[1])} 周 · 已打卡 ${d.count} / ${state.settings.weekGoal} 次`
  }
  if (view === 'month') {
    const d = monthDetail(state, cursor)
    return `已打卡 ${d.count} / ${state.settings.monthGoal} 次 · 累计 ${d.minutes} 分钟`
  }
  const d = yearDetail(state, cursor.getFullYear())
  return `全年 ${d.count} 次 · ${d.minutes} 分钟`
}

function updateSegment() {
  segButtons.forEach((btn) => {
    btn.setAttribute('aria-selected', String(btn.dataset.view === view))
  })
  const index = ['week', 'month', 'year'].indexOf(view)
  segThumb.style.transform = `translateX(${index * 100}%)`
  weekdaysRow.hidden = view === 'year'
  if (view !== 'year') {
    weekdaysRow.innerHTML = ''
    WEEKDAY_CN.forEach((w, i) => {
      weekdaysRow.appendChild(el('span', i >= 5 ? 'weekend' : '', w))
    })
  }
}

function dayClasses(key, today, extra) {
  const d = parseYmd(key)
  const cls = ['day']
  if (d.getDay() === 0 || d.getDay() === 6) cls.push('weekend')
  if (key === today) cls.push('is-today')
  if (key > today) cls.push('future')
  if (isChecked(state, key)) cls.push('checked')
  if (key === selection) cls.push('selected')
  if (extra) cls.push(extra)
  return cls.join(' ')
}

function renderMonth(now) {
  const today = ymd(now)
  const grid = monthGrid(cursor)
  const wrap = el('div', 'month-grid')
  for (const cell of grid) {
    const btn = el('button', dayClasses(cell.key, today, cell.inMonth ? '' : 'other'))
    btn.type = 'button'
    btn.dataset.day = cell.key
    btn.appendChild(el('span', 'day-num', String(cell.day)))
    btn.appendChild(el('span', 'day-dot'))
    const mark = markOf(state, cell.key)
    btn.setAttribute(
      'aria-label',
      `${cnDateFull(cell.key)}，${mark ? `已打卡 ${itemsTextFallback(mark)} ${mark.mins} 分钟` : '未打卡'}`
    )
    wrap.appendChild(btn)
  }
  return wrap
}

function renderWeek(now) {
  const today = ymd(now)
  const detail = weekDetail(state, cursor)
  const list = el('div', 'week-list')
  detail.days.forEach((day, index) => {
    const row = el(
      'button',
      `week-row${isChecked(state, day.key) ? ' checked' : ''}${day.key === today ? ' is-today' : ''}${day.key > today ? ' future' : ''}`
    )
    row.type = 'button'
    row.dataset.day = day.key
    row.appendChild(el('span', 'wd', WEEKDAY_FULL_CN[index]))
    row.appendChild(el('span', 'dn', String(parseYmd(day.key).getDate())))
    const mark = day.mark
    row.appendChild(
      el(
        'span',
        `detail${mark ? '' : ' empty'}`,
        mark ? `${itemsTextFallback(mark)} · ${mark.mins} 分钟` : '未打卡'
      )
    )
    const tick = el('span', 'tick')
    tick.innerHTML = ICON_CHECK
    row.appendChild(tick)
    list.appendChild(row)
  })
  return list
}

function renderYear(now) {
  const year = cursor.getFullYear()
  const detail = yearDetail(state, year)
  const currentMonth = now.getFullYear() === year ? now.getMonth() : -1
  const grid = el('div', 'year-grid')
  detail.months.forEach((m) => {
    const btn = el('button', `mini-month${m.month === currentMonth ? ' current' : ''}`)
    btn.type = 'button'
    btn.dataset.month = `${year}-${pad2(m.month + 1)}`
    btn.appendChild(el('div', 'mm-title', MONTH_CN[m.month]))
    const dots = el('div', 'mini-dots')
    const daysInMonth = new Date(year, m.month + 1, 0).getDate()
    for (let i = 0; i < daysInMonth; i++) {
      dots.appendChild(el('i', m.days[i] && m.days[i].checked ? 'on' : ''))
    }
    btn.appendChild(dots)
    btn.appendChild(el('div', 'mm-count', m.count ? `${m.count} 次` : '—'))
    grid.appendChild(btn)
  })
  return grid
}

function renderMetrics() {
  const now = new Date()
  const progress = currentProgress(state, now)
  const st = streak(state, now)
  let items

  if (view === 'week') {
    const d = weekDetail(state, cursor)
    items = [
      { v: d.count, k: '本周次数', accent: true },
      { v: `${d.count}/${state.settings.weekGoal}`, k: '目标' },
      { v: d.minutes, k: '分钟' },
      { v: st.current, k: '连续天数' },
    ]
  } else if (view === 'year') {
    const d = yearDetail(state, cursor.getFullYear())
    const activeMonths = d.months.filter((m) => m.count > 0).length
    items = [
      { v: d.count, k: '全年次数', accent: true },
      { v: Math.round(d.minutes / 60), k: '小时' },
      { v: `${activeMonths}/12`, k: '活跃月份' },
      { v: st.best, k: '最长连续' },
    ]
  } else {
    const d = monthDetail(state, cursor)
    items = [
      { v: d.count, k: '本月次数', accent: true },
      { v: `${d.count}/${state.settings.monthGoal}`, k: '目标' },
      { v: d.minutes, k: '分钟' },
      { v: progress.weekRemain === 0 ? '达标' : progress.weekRemain, k: '本周还差' },
    ]
  }

  metricsBox.innerHTML = ''
  for (const it of items) {
    const box = el('div', `metric${it.accent ? ' accent' : ''}`)
    box.appendChild(el('div', 'v', String(it.v)))
    box.appendChild(el('div', 'k', it.k))
    metricsBox.appendChild(box)
  }
}

function renderCheckinButton() {
  const now = ymd(new Date())
  const isToday = selection === now
  const checked = isChecked(state, selection)
  const mark = markOf(state, selection)
  checkinBtn.classList.toggle('done', checked)
  if (checked) {
    checkinLabel.textContent = '已完成打卡'
    checkinSub.textContent = `${cnDate(selection)} · ${itemsTextFallback(mark)} ${mark.mins} 分钟 · 点击撤销`
  } else {
    checkinLabel.textContent = isToday ? '立即打卡' : '为这天打卡'
    checkinSub.textContent = cnDateFull(selection)
  }
}

function renderRecent() {
  recentBox.innerHTML = ''
  const now = ymd(new Date())
  const allChecked = Object.keys(state.marks).filter((k) => isChecked(state, k))
  const keys = allChecked
    .filter((k) => k <= now)
    .sort()
    .reverse()
    .slice(0, 5)

  const title = el('div', 'recent-title')
  title.appendChild(el('span', '', '最近打卡'))
  title.appendChild(el('span', '', allChecked.length ? `共 ${allChecked.length} 次 · 长按可编辑` : ''))
  recentBox.appendChild(title)

  if (!keys.length) {
    recentBox.appendChild(
      el('div', 'empty-block', '还没有打卡记录。\n点日历上的任意一天，或下方「立即打卡」开始。')
    )
    return
  }

  const list = el('div', 'recent-list')
  for (const key of keys) {
    const mark = markOf(state, key)
    const item = el('button', 'recent-item')
    item.type = 'button'
    item.dataset.day = key // 复用同一套长按编辑 / 轻点手势
    item.dataset.jump = key

    const items = Array.isArray(mark.items) ? mark.items : []
    const names = items.map((it) => it.name).filter(Boolean)
    const namesText = names.length ? names.join('、') : itemsTextFallback(mark)
    item.appendChild(el('span', 'ri-kind', namesText))
    if (items.length === 1) {
      item.appendChild(el('span', 'ri-items', '单项目'))
    } else {
      item.appendChild(el('span', 'ri-items', `${items.length} 项`))
    }
    item.appendChild(el('span', `ri-effort ${mark.effort || 'normal'}`, effortLabel(mark.effort)))
    item.appendChild(el('span', 'ri-date', cnDateFull(key)))
    item.appendChild(el('span', 'ri-mins', `${mark.mins}′`))
    list.appendChild(item)
  }
  recentBox.appendChild(list)
}

/**
 * 一天的训练内容摘要。
 *
 * v2 数据只有 items（一天可含多个项目），v1 老数据只有 kind —— 两者都要能显示。
 * 之前这里只读 mark.kind，导致 v2 数据在日历无障碍描述、周视图、
 * 底部打卡按钮副标题里全都退化成「训练」，看不出练了什么。
 */
function itemsTextFallback(mark) {
  if (!mark) return '训练'
  const items = Array.isArray(mark.items) ? mark.items : []
  const names = items.map((it) => it && it.name).filter(Boolean)
  if (names.length) return names.join('、')
  return (mark.kind && KIND_LABELS[mark.kind]) || '训练'
}

/** 辛苦程度 id -> 中文标签 */
function effortLabel(id) {
  const found = EFFORT_LEVELS.find((e) => e.id === id)
  return found ? found.label : '适中'
}
/* ================================================================== *
 * 4. 打卡交互
 * ================================================================== */

/** 给某天打卡 / 取消打卡，并给出明确提示 */
function toggleDay(key) {
  const now = ymd(new Date())
  if (key > now) {
    showToast({ text: '未来的日子还不能打卡', icon: 'warn' })
    return false
  }
  if (isChecked(state, key)) {
    // 删除前先留一份快照，撤销时能原样还原项目、时长与辛苦程度
    const snapshot = markOf(state, key)
    state = unmarkDay(state, key)
    persist()
    renderAll()
    showToast({
      text: `已取消 ${cnDate(key)} 的打卡`,
      icon: 'none',
      undoLabel: '撤销',
      onUndo: () => {
        if (!snapshot) return
        state = markDay(state, key, { t: Date.now(), items: snapshot.items })
        persist()
        renderAll()
      },
    })
    return false
  }

  // 新建一条日程：默认带上次用过的项目，时长与辛苦程度沿用设置
  state = markDay(state, key, {
    t: Date.now(),
    items: [{ name: lastUsedItem(), mins: state.settings.defaultMins, effort: state.settings.defaultEffort }],
  })
  persist()
  selection = key
  renderAll()
  flashDay(key)
  haptic()
  showToast({ text: `${cnDate(key)} 健身打卡成功` })
  return true
}

/** 打卡后让那个圆点弹一下 */
function flashDay(key) {
  const node = viewport.querySelector(`[data-day="${key}"]`)
  if (!node) return
  node.classList.add('just-checked')
  setTimeout(() => node.classList.remove('just-checked'), 400)
}

function handleDayTap(key) {
  const now = ymd(new Date())
  if (key > now) {
    showToast({ text: '未来的日子还不能打卡', icon: 'warn' })
    return
  }
  selection = key
  toggleDay(key)
}

/** 上次用过的项目名，作为新日程的默认值 */
function lastUsedItem() {
  const keys = Object.keys(state.marks)
    .filter((k) => isChecked(state, k))
    .sort()
  for (let i = keys.length - 1; i >= 0; i--) {
    const items = state.marks[keys[i]].items
    if (items && items.length) return items[0].name
  }
  return quickItemList()[0] || '跑步机'
}
/* ---------- 手势：左右滑动 + 上下翻页 + 长按编辑 ---------- */

function unitShift(direction) {
  if (view === 'week') {
    cursor = addDays(startOfWeek(cursor), direction * 7)
  } else if (view === 'month') {
    cursor = addMonths(startOfMonth(cursor), direction)
  } else {
    cursor = new Date(cursor.getFullYear() + direction, cursor.getMonth(), 1)
  }
  renderAll()
  maybeShowReview('navigate')
}

function gotoToday() {
  cursor = new Date()
  selection = ymd(new Date())
  renderAll()
  haptic()
}

/** 年视图点某个月 -> 切到月视图并定位到那个月 */
function openMonthFromYear(monthKeyStr) {
  const [y, m] = String(monthKeyStr).split('-').map(Number)
  if (!y || !m) return
  cursor = new Date(y, m - 1, 1)
  view = 'month'
  selection = ymd(cursor)
  renderAll()
  haptic()
}

const LONG_PRESS_MS = 480
let gesture = null

/**
 * 统一的按下 / 移动 / 抬起手势：
 *  - 长按某天（或最近记录）-> 打开编辑抽屉
 *  - 轻点某天 -> 打卡 / 打开编辑
 *  - 轻点年视图里的某个月 -> 跳到该月
 *  - 左右滑动 -> 换周期；上下滑动 -> 翻页
 */
function attachGestures() {
  const box = viewport

  box.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const dayEl = e.target.closest('[data-day]')
    const monthEl = e.target.closest('[data-month]')
    gesture = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      moved: false,
      longPressFired: false,
      dayKey: dayEl ? dayEl.dataset.day : null,
      monthKey: monthEl ? monthEl.dataset.month : null,
      timer: 0,
    }
    if (gesture.dayKey) {
      gesture.timer = setTimeout(() => {
        if (!gesture || gesture.moved) return
        gesture.longPressFired = true
        haptic('strong')
        openEditSheet(gesture.dayKey)
      }, LONG_PRESS_MS)
    }
  })

  box.addEventListener('pointermove', (e) => {
    if (!gesture || e.pointerId !== gesture.id) return
    const dx = e.clientX - gesture.x
    const dy = e.clientY - gesture.y
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
      gesture.moved = true
      clearTimeout(gesture.timer)
    }
    if (!gesture.moved) return
    // 只做轻微跟手，避免和纵向滚动打架
    if (Math.abs(dx) > Math.abs(dy)) {
      box.classList.add('dragging')
      box.style.transform = `translateX(${dx * 0.28}px)`
    }
  })

  const finish = (e) => {
    if (!gesture || e.pointerId !== gesture.id) return
    const g = gesture
    gesture = null
    clearTimeout(g.timer)
    box.classList.remove('dragging')
    box.style.transform = ''

    if (g.longPressFired) return
    if (!g.moved) {
      if (g.dayKey) handleDayTap(g.dayKey)
      else if (g.monthKey) openMonthFromYear(g.monthKey)
      return
    }

    const dx = e.clientX - g.x
    const dy = e.clientY - g.y
    if (Math.abs(dx) > Math.abs(dy)) {
      if (Math.abs(dx) > 42) unitShift(dx < 0 ? 1 : -1)
    } else if (Math.abs(dy) > 52) {
      unitShift(dy < 0 ? 1 : -1) // 上滑看下一段，下滑看上一段
    }
  }

  box.addEventListener('pointerup', finish)
  box.addEventListener('pointercancel', () => {
    if (gesture) clearTimeout(gesture.timer)
    gesture = null
    box.classList.remove('dragging')
    box.style.transform = ''
  })

  // 键盘可达性
  box.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') unitShift(-1)
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') unitShift(1)
    else return
    e.preventDefault()
  })
}

/**
 * 最近打卡列表：和日历共用一套手势。
 *  - 长按 -> 编辑该天
 *  - 轻点 -> 跳回那一天的月视图
 */
let recentGesture = null

function attachRecentGestures() {
  const box = recentBox

  box.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const item = e.target.closest('[data-day]')
    if (!item) return
    recentGesture = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      moved: false,
      longPressFired: false,
      dayKey: item.dataset.day,
      timer: 0,
    }
    recentGesture.timer = setTimeout(() => {
      if (!recentGesture || recentGesture.moved) return
      recentGesture.longPressFired = true
      haptic('strong')
      openEditSheet(recentGesture.dayKey)
    }, LONG_PRESS_MS)
  })

  box.addEventListener('pointermove', (e) => {
    if (!recentGesture || e.pointerId !== recentGesture.id) return
    if (Math.abs(e.clientX - recentGesture.x) > 8 || Math.abs(e.clientY - recentGesture.y) > 8) {
      recentGesture.moved = true
      clearTimeout(recentGesture.timer)
    }
  })

  const finish = (e) => {
    if (!recentGesture || e.pointerId !== recentGesture.id) return
    const g = recentGesture
    recentGesture = null
    clearTimeout(g.timer)
    if (g.longPressFired || g.moved) return
    // 轻点：跳到那天
    cursor = parseYmd(g.dayKey)
    selection = g.dayKey
    view = 'month'
    renderAll()
    haptic()
  }

  box.addEventListener('pointerup', finish)
  box.addEventListener('pointercancel', () => {
    if (recentGesture) clearTimeout(recentGesture.timer)
    recentGesture = null
  })
}
/* ---------- 编辑抽屉（长按某天 / 长按最近记录） ---------- */

let editTarget = null
/** 编辑草稿：items 是当前选中的项目，每个都带自己的时长 */
let editDraft = { items: [], effort: 'normal' }

/** 内置 + 自定义，按出现顺序去重 */
function quickItemList() {
  const seen = new Set()
  const out = []
  for (const name of [...BUILTIN_QUICK_ITEMS, ...state.settings.quickItems]) {
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

function openEditSheet(key) {
  const now = ymd(new Date())
  if (key > now) {
    showToast({ text: '未来的日子还不能打卡', icon: 'warn' })
    return
  }
  editTarget = key
  const mark = markOf(state, key)
  if (mark) {
    editDraft = {
      items: (mark.items || []).map((it) => ({ ...it })),
      effort: mark.effort || state.settings.defaultEffort,
    }
  } else {
    editDraft = {
      items: [
        {
          name: lastUsedItem(),
          mins: state.settings.defaultMins,
          effort: state.settings.defaultEffort,
        },
      ],
      effort: state.settings.defaultEffort,
    }
  }
  $('editTitle').textContent = cnDateFull(key)
  $('editDelete').hidden = !mark
  $('customTagInput').value = ''
  renderEditBody()
  openSheetFn('editSheet', 'sheetBackdrop')
}

/** 重绘整个编辑面板（标签、时长行、辛苦程度、小结） */
function renderEditBody() {
  renderItemChips()
  renderItemRows()
  renderEffortChips()
  renderCustomTagList()
  renderEditSummary()
}

function renderItemChips() {
  const box = $('editItems')
  box.innerHTML = ''
  const selected = new Set(editDraft.items.map((it) => it.name))
  for (const name of quickItemList()) {
    const on = selected.has(name)
    const chip = el('button', 'chip', name)
    chip.type = 'button'
    chip.setAttribute('aria-pressed', String(on))
    chip.addEventListener('click', () => toggleDraftItem(name))
    box.appendChild(chip)
  }
  $('itemCount').textContent = `已选 ${editDraft.items.length} 项`
}

/** 多选：点一下加入（带该标签上次的时长），再点一下移除 */
function toggleDraftItem(name) {
  const idx = editDraft.items.findIndex((it) => it.name === name)
  if (idx >= 0) {
    editDraft.items.splice(idx, 1)
  } else {
    if (editDraft.items.length >= 12) {
      showToast({ text: '一天最多 12 个项目', icon: 'warn' })
      return
    }
    const mins = state.settings.itemMins[name] || state.settings.defaultMins
    editDraft.items.push({ name, mins, effort: state.settings.defaultEffort })
  }
  haptic()
  renderEditBody()
  if (idx < 0) {
    // 新加的标签记得住时长
    state = rememberItemMins(state, name, state.settings.itemMins[name] || state.settings.defaultMins)
    persist()
  }
}

function renderItemRows() {
  const box = $('itemRows')
  box.innerHTML = ''
  if (!editDraft.items.length) {
    box.appendChild(el('div', 'empty-items', '请先在上面选至少一个训练项目'))
    return
  }
  for (const item of editDraft.items) {
    const row = el('div', 'item-row')
    row.appendChild(el('span', 'name', item.name))

    const stepper = el('div', 'stepper')
    const minus = el('button', '', '−')
    minus.type = 'button'
    minus.setAttribute('aria-label', `${item.name} 减 5 分钟`)
    minus.addEventListener('click', () => {
      item.mins = Math.max(5, item.mins - 5)
      renderItemRows()
      renderEditSummary()
      haptic()
    })
    const input = el('input')
    input.type = 'number'
    input.inputMode = 'numeric'
    input.min = '5'
    input.max = '300'
    input.step = '5'
    input.value = String(item.mins)
    input.setAttribute('aria-label', `${item.name} 时长`)
    input.addEventListener('change', () => {
      const v = Math.round(Number(input.value) || 0)
      item.mins = Math.min(300, Math.max(5, v))
      input.value = String(item.mins)
      renderEditSummary()
    })
    const plus = el('button', '', '+')
    plus.type = 'button'
    plus.setAttribute('aria-label', `${item.name} 加 5 分钟`)
    plus.addEventListener('click', () => {
      item.mins = Math.min(300, item.mins + 5)
      renderItemRows()
      renderEditSummary()
      haptic()
    })
    stepper.appendChild(minus)
    stepper.appendChild(input)
    stepper.appendChild(plus)
    row.appendChild(stepper)
    row.appendChild(el('span', 'unit', '分钟'))

    const drop = el('button', 'drop', '×')
    drop.type = 'button'
    drop.setAttribute('aria-label', `移除 ${item.name}`)
    drop.addEventListener('click', () => toggleDraftItem(item.name))
    row.appendChild(drop)

    // 输入框失焦时把这次时长记到这个标签上
    input.addEventListener('blur', () => {
      state = rememberItemMins(state, item.name, item.mins)
      persist()
    })

    box.appendChild(row)
  }
}

function renderEffortChips() {
  const box = $('editEfforts')
  box.className = 'chips efforts'
  box.innerHTML = ''
  for (const level of EFFORT_LEVELS) {
    const chip = el('button', 'chip', level.label)
    chip.type = 'button'
    chip.dataset.effort = level.id
    chip.setAttribute('aria-pressed', String(editDraft.effort === level.id))
    chip.addEventListener('click', () => {
      editDraft.effort = level.id
      renderEffortChips()
      haptic()
    })
    box.appendChild(chip)
  }
  const level = EFFORT_LEVELS.find((e) => e.id === editDraft.effort)
  $('effortHint').textContent = level ? level.hint : ''
}

/** 已添加的自定义标签，可长按/点击 × 删除 */
function renderCustomTagList() {
  const box = $('customTagList')
  box.innerHTML = ''
  const customs = state.settings.customTags
  if (!customs.length) return
  for (const name of customs) {
    const chip = el('button', 'chip manage')
    chip.type = 'button'
    chip.appendChild(el('span', '', name))
    chip.appendChild(el('span', 'x', '×'))
    chip.setAttribute('aria-label', `删除自定义项目 ${name}`)
    chip.addEventListener('click', () => {
      const used = editDraft.items.some((it) => it.name === name)
      state = removeCustomTag(state, name)
      editDraft.items = editDraft.items.filter((it) => it.name !== name)
      persist()
      renderEditBody()
      showToast({ text: `已删除「${name}」${used ? '，并已从本次日程移除' : ''}`, icon: 'none' })
      haptic()
    })
    box.appendChild(chip)
  }
}

/** 底部小结：总时长 + 辛苦程度，让用户保存前心里有数 */
function renderEditSummary() {
  const total = editDraft.items.reduce((sum, it) => sum + Number(it.mins || 0), 0)
  const box = $('editSummary')
  box.innerHTML = ''
  if (!editDraft.items.length) {
    box.textContent = '还没有选择训练项目'
    return
  }
  const strong = el('strong', '', `${editDraft.items.length} 个项目 · ${total} 分钟`)
  box.appendChild(strong)
  box.appendChild(document.createTextNode(` · 感觉${effortLabel(editDraft.effort)}`))
}

/** 读取草稿并保存 */
function saveEditDraft() {
  if (!editTarget) return
  if (!editDraft.items.length) {
    showToast({ text: '至少选一个训练项目', icon: 'warn' })
    return
  }
  state = markDay(state, editTarget, {
    t: Date.now(),
    items: editDraft.items.map((it) => ({ name: it.name, mins: it.mins, effort: editDraft.effort })),
  })
  // 记住每个标签这次用的时长
  for (const it of editDraft.items) {
    state = rememberItemMins(state, it.name, it.mins)
  }
  state = setSettings(state, { defaultEffort: editDraft.effort })
  persist()
  selection = editTarget
  renderAll()
  closeSheet('editSheet')
  showToast({ text: `${cnDate(editTarget)} 健身打卡成功` })
}
/* ================================================================== *
 * 5. 周 / 月回顾
 * ================================================================== */

/**
 * 是否应该展示回顾：每周 / 每月各只在「第一次打开」弹一次。
 *
 * 用 sessionStorage 记录「本周期已经弹过」，而不是把 state.meta.lastWeeklySeen 当开关：
 * 只要有一个分支忘记写标记，用户就再也看不到回顾了 —— 这正是「新的一周不提示」最常见的成因。
 */
const SESSION_SEEN_KEY = 'fitcal.reviewShown.v1'

function readShownMap() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_SEEN_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

function markShown(type, periodKey) {
  try {
    const map = readShownMap()
    map[type] = { period: periodKey, at: Date.now() }
    sessionStorage.setItem(SESSION_SEEN_KEY, JSON.stringify(map))
  } catch {
    /* 隐私模式下 sessionStorage 不可用，退化为每次打开都弹一次 */
  }
}

function shownRecently(type, periodKey) {
  const entry = readShownMap()[type]
  if (!entry || entry.period !== periodKey) return false
  return Date.now() - Number(entry.at || 0) < 24 * 3600 * 1000
}

/** 计算「哪些回顾需要展示」：周/月各自独立判断 */
function pendingReviews() {
  const now = new Date()
  const out = []
  const weekPeriod = weekKey(now)
  const monthPeriod = monthKey(now)
  if (!shownRecently('week', weekPeriod)) out.push({ type: 'week', period: weekPeriod })
  if (!shownRecently('month', monthPeriod)) out.push({ type: 'month', period: monthPeriod })
  return out
}

function buildReview(type) {
  return type === 'week' ? weekReview(state, new Date()) : monthReview(state, new Date())
}

/** 打卡累计太少时不弹回顾，避免新用户一进来就被说教 */
function reviewWorthShowing(review) {
  const total = Object.keys(state.marks).filter((k) => isChecked(state, k)).length
  return review.count > 0 || total >= 3
}

function reviewBadge(review) {
  const ratio = review.goal ? review.count / review.goal : 0
  if (review.count === 0) return { text: '断了', cls: 'bad' }
  if (ratio >= 1) return { text: '达标', cls: '' }
  if (ratio >= 0.6) return { text: '略松懈', cls: 'warn' }
  return { text: '没跟上', cls: 'bad' }
}

function reviewCard(review, { auto = true } = {}) {
  const card = el('article', 'review')
  card.dataset.review = review.type
  const head = el('div', 'review-head')
  const title = el('div', 'review-title')
  title.appendChild(el('span', '', review.title))
  const badge = reviewBadge(review)
  title.appendChild(el('span', `badge ${badge.cls}`.trim(), badge.text))
  head.appendChild(title)
  if (auto) {
    const close = el('button', 'review-close')
    close.type = 'button'
    close.setAttribute('aria-label', '关闭')
    close.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>'
    close.addEventListener('click', () => {
      card.remove()
      haptic()
    })
    head.appendChild(close)
  }
  card.appendChild(head)

  const text = el('p', 'review-text', review.text)
  card.appendChild(text)

  const facts = el('div', 'review-facts')
  const isMonth = review.type === 'month'
  const factList = [
    review.label,
    `打卡 ${review.count} 次`,
    `目标 ${review.goal} 次`,
    review.hasPrevData ? `较上一${isMonth ? '月' : '周'} ${review.delta >= 0 ? '+' : ''}${review.delta}` : '首次统计',
    `${review.minutes} 分钟`,
  ]
  for (const f of factList) facts.appendChild(el('span', 'fact', f))
  card.appendChild(facts)

  const foot = el('div', 'review-foot')
  foot.appendChild(el('span', 'text-btn ghost', nextPlanText(review)))
  card.appendChild(foot)
  return card
}

function nextPlanText(review) {
  const isMonth = review.type === 'month'
  const need = Math.max(0, review.goal - review.count)
  if (review.count === 0) return `本${isMonth ? '月' : '周'}计划：先做 3 次，每次 20 分钟`
  if (need === 0) return `本${isMonth ? '月' : '周'}计划：保持 ${review.goal} 次，别加量`
  return `本${isMonth ? '月' : '周'}计划：${review.goal} 次 × 30 分钟，还差 ${need} 次`
}

/**
 * 每「周 / 月」的第一次打开：显示上周 / 上月的频次分析。
 * trigger:
 *   auto     — 页面加载 / 回到前台时检查
 *   navigate — 翻页切换周期时检查
 *   manual   — 点顶栏 AI 按钮，随时重新生成
 */
async function maybeShowReview(trigger = 'auto') {
  const pending = pendingReviews()
  if (!pending.length) return

  const cards = []
  for (const item of pending) {
    const review = buildReview(item.type)
    if (!reviewWorthShowing(review)) continue
    cards.push({ review, period: item.period })
  }
  if (!cards.length) return

  // 月度回顾放前面（周期更长，优先级更高）
  cards.sort((a, b) => (a.review.type === 'month' ? -1 : 1))

  const existing = new Set([...reviewsBox.querySelectorAll('.review')].map((n) => n.dataset.review))
  let added = 0
  for (const { review, period } of cards) {
    if (existing.has(review.type)) continue // 同类型只留一张，避免翻页时叠卡片
    reviewsBox.appendChild(reviewCard(review))
    markShown(review.type, period)
    markSeenPersist(review.type)
    if (state.settings.aiAuto) {
      aiRefresh(review, reviewsBox.querySelector(`[data-review="${review.type}"]`), added === 0)
    }
    added++
  }
  if (!added) return

  if (trigger === 'auto') {
    reviewsBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
}

/** 同时写进持久化状态（用于跨设备同步「已读」标记） */
function markSeenPersist(type) {
  const now = new Date()
  state = setMeta(
    state,
    type === 'week' ? { lastWeeklySeen: weekKey(now) } : { lastMonthlySeen: monthKey(now) }
  )
  persist()
}

/* ================================================================== *
 * 6. page-agent 接入
 * ================================================================== */

const ai = {
  ready: false,
  loading: false,
  agent: null,
  failed: false,
  promise: null,
}

/** 加载官方 IIFE（jsDelivr 失败时回退 npmmirror 镜像） */
function loadPageAgent() {
  if (window.PageAgent) {
    ai.ready = true
    return Promise.resolve(true)
  }
  if (ai.loading) return ai.promise
  ai.loading = true
  ai.promise = new Promise((resolve) => {
    const script = document.createElement('script')
    let triedMirror = false
    script.src = `${PAGEAGENT_SRC}?autoInit=false&showPanel=false&lang=zh-CN`
    script.crossOrigin = 'anonymous'
    script.defer = true
    script.onload = () => {
      ai.ready = !!window.PageAgent
      resolve(ai.ready)
    }
    script.onerror = () => {
      if (!triedMirror) {
        triedMirror = true
        script.src = `${PAGEAGENT_MIRROR}?autoInit=false&showPanel=false&lang=zh-CN`
        document.head.appendChild(script)
        return
      }
      ai.failed = true
      resolve(false)
    }
    document.head.appendChild(script)
  })
  return ai.promise
}

function readAiPrefs() {
  try {
    return JSON.parse((storage && storage.getItem('fitcal.ai.v1')) || '{}') || {}
  } catch {
    return {}
  }
}

function agentConfig() {
  const custom = readAiPrefs()
  if (custom.apiKey) {
    return {
      model: custom.model || DEMO_MODEL,
      baseURL: custom.baseURL || DEMO_BASE_URL,
      apiKey: custom.apiKey,
      language: 'zh-CN',
    }
  }
  // 没有自带 Key 时用官方内置的免费测试模型
  return { model: DEMO_MODEL, baseURL: DEMO_BASE_URL, apiKey: 'NA', language: 'zh-CN' }
}

function buildAgent(cfg) {
  const Agent = window.PageAgent
  if (!Agent) return null
  if (ai.agent) {
    try {
      ai.agent.dispose()
    } catch {
      /* ignore */
    }
  }
  ai.agent = new Agent({
    ...cfg,
    maxSteps: 4,
    instructions: {
      system:
        '你是一个健身打卡日历页面里的教练。你的任务只有一件：根据页面上已经算好的统计数据，' +
        '用中文写 1–2 句话点评并给出接下来该做到的训练计划。' +
        '要求：数字必须与页面数据一致，不要编造；语气直接、友善、不打鸡血；' +
        '不要输出 Markdown、列表或标题；不要执行任何点击、修改日期的操作。',
    },
  })
  ai.ready = true
  return ai.agent
}

/**
 * 把本地规则生成的结论，交给 page-agent 基于真实页面数据重写一句话。
 * 失败时保留本地结论（页面永远有可用的分析）。
 * @param {object} review  回顾数据（提供 type 与 label 供提示词使用）
 * @param {Element} card   对应卡片节点
 * @param {boolean} showPanel 是否把 page-agent 面板亮出来（第一次分析时亮，让用户看到 AI 在工作）
 */
async function aiRefresh(review, card, showPanel = false) {
  if (!card) return
  const ok = await loadPageAgent()
  if (!ok) {
    const foot = card.querySelector('.review-foot')
    if (foot && !foot.querySelector('.ai-note')) {
      foot.appendChild(el('span', 'text-btn ghost ai-note', 'AI 不可用，已使用本地分析'))
    }
    return
  }
  const cfg = agentConfig()
  const agent = buildAgent(cfg)
  if (!agent) return

  // 第一次真正调用外部模型前，先拿到用户的显式许可
  const granted = await userActivated('coach')
  if (!granted) return

  const textNode = card.querySelector('.review-text')
  const original = textNode.textContent
  textNode.classList.add('loading')
  textNode.textContent = '教练正在看你这段时间的记录…'

  const prompt =
    `页面日历下方有一张分析卡片（[data-review="${review.type}"]）。` +
    `请读取它「facts」里的数字，针对「${review.label}」这段时间，用 1–2 句话告诉我：` +
    `达标了吗、是偷懒还是量够了、接下来该怎么练。只回答这段话本身，不要做任何点击操作。`

  try {
    if (showPanel) {
      try {
        if (agent.panel) agent.panel.show()
      } catch {
        /* ignore */
      }
    }
    const history = await agent.execute(prompt)
    const finalText = extractFinalText(history)
    textNode.textContent = finalText ? cleanAgentText(finalText) : original
  } catch {
    textNode.textContent = original
  } finally {
    textNode.classList.remove('loading')
    try {
      if (agent.panel) agent.panel.hide()
    } catch {
      /* ignore */
    }
  }
}

/** 从 page-agent 的 history 里取最后一次 tool 结果 / 文本 */
function extractFinalText(history) {
  if (!history) return ''
  if (typeof history === 'string') return history
  const result = history.data || history.result || (history.history ? history.history : history)
  if (Array.isArray(result)) {
    for (let i = result.length - 1; i >= 0; i--) {
      const ev = result[i]
      if (ev && ev.action && typeof ev.action.output === 'string' && ev.action.output.trim()) {
        return ev.action.output
      }
      if (ev && typeof ev.content === 'string' && ev.content.trim()) return ev.content
    }
    return ''
  }
  if (typeof result === 'string') return result
  return ''
}

/** 去掉模型偶尔带出来的 Markdown 修饰 */
function cleanAgentText(text) {
  return String(text)
    .replace(/\*\*/g, '')
    .replace(/^[#>\-\s]+/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .slice(0, 160)
}

/** 手动触发 AI 分析（顶栏 AI 按钮）：随时重新生成周/月点评，并打开 page-agent 面板 */
async function runAiAnalysis() {
  const reviews = [buildReview('week'), buildReview('month')]
  const cards = reviews.map((r) => reviewCard(r, { auto: false }))
  reviewsBox.innerHTML = ''
  for (const card of cards) reviewsBox.appendChild(card)
  reviewsBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' })

  const ok = await loadPageAgent()
  if (!ok) {
    for (const foot of reviewsBox.querySelectorAll('.review-foot')) {
      foot.appendChild(el('span', 'text-btn ghost', 'AI 模型加载失败，已使用本地分析（可换网络重试）'))
    }
    return
  }
  for (let i = 0; i < cards.length; i++) {
    await aiRefresh(reviews[i], cards[i], i === 0)
  }
}

/* ================================================================== *
 * 7. 事件绑定与启动
 * ================================================================== */

function bindEvents() {
  segButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (view === btn.dataset.view) return
      view = btn.dataset.view
      if (view === 'year') cursor = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
      renderAll()
      haptic()
    })
  })

  $('todayBtn').addEventListener('click', gotoToday)

  checkinBtn.addEventListener('click', () => {
    const key = selection || ymd(new Date())
    selection = key
    toggleDay(key)
  })

  // 最近记录的长按编辑 / 轻点跳转由 attachRecentGestures() 统一处理，
  // 这里不再绑 click，避免和手势重复触发。
  $('aiBtn').addEventListener('click', openAiSheet)
  $('settingsBtn').addEventListener('click', openSettings)

  // 编辑抽屉
  $('sheetBackdrop').addEventListener('click', () => closeSheet('editSheet'))
  $('editSave').addEventListener('click', saveEditDraft)

  // 添加自定义项目
  $('customTagAdd').addEventListener('click', addCustomTagFromInput)
  $('customTagInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      addCustomTagFromInput()
    }
  })

  $('editDelete').addEventListener('click', () => {
    if (!editTarget) return
    const key = editTarget
    state = unmarkDay(state, key)
    persist()
    renderAll()
    closeSheet('editSheet')
    showToast({ text: `已取消 ${cnDate(key)} 的打卡`, icon: 'none' })
  })

  // 设置
  $('settingsBackdrop').addEventListener('click', () => closeSheet('settingsSheet'))
  $('settingsClose').addEventListener('click', () => closeSheet('settingsSheet'))
  $('setWeekGoal').addEventListener('change', (e) => {
    state = setSettings(state, { weekGoal: Number(e.target.value) })
    persist()
    renderAll()
    fillSettings()
  })
  $('setMonthGoal').addEventListener('change', (e) => {
    state = setSettings(state, { monthGoal: Number(e.target.value) })
    persist()
    renderAll()
    fillSettings()
  })
  $('setMins').addEventListener('change', (e) => {
    state = setSettings(state, { defaultMins: Number(e.target.value) })
    persist()
    fillSettings()
  })
  $('setAiAuto').addEventListener('change', (e) => {
    state = setSettings(state, { aiAuto: e.target.checked })
    persist()
  })
  $('syncGen').addEventListener('click', async () => {
    state = setSettings(state, { syncId: generateSyncId() })
    persist()
    fillSettings()
    if (cloud.enabled) {
      await pushNow()
      setSyncLabel('已生成同步口令，在其他设备填入即可同步')
    }
    showToast({ text: '已生成同步口令', icon: 'none' })
  })
  $('syncCopy').addEventListener('click', async () => {
    const id = state.settings.syncId
    if (!id) {
      showToast({ text: '先点「生成口令」', icon: 'warn' })
      return
    }
    try {
      await navigator.clipboard.writeText(id)
      showToast({ text: '口令已复制', icon: 'none' })
    } catch {
      showToast({ text: '复制失败，请长按输入框手动复制', icon: 'warn' })
    }
  })
  $('syncNow').addEventListener('click', async () => {
    if (!cloud.enabled) {
      showToast({ text: '本 Worker 未配置 KV，云端同步不可用', icon: 'warn' })
      return
    }
    await pullAndMerge()
    showToast({ text: '已完成同步', icon: 'none' })
  })
  $('setSyncId').addEventListener('change', async (e) => {
    const value = e.target.value.trim()
    if (!value) {
      state = setSettings(state, { syncId: '' })
      persist()
      fillSettings()
      return
    }
    if (!isValidSyncId(value)) {
      showToast({ text: '口令格式不对（至少 16 位字母数字）', icon: 'warn' })
      fillSettings()
      return
    }
    state = setSettings(state, { syncId: value })
    persist()
    fillSettings()
    if (cloud.enabled) {
      await pullAndMerge()
      showToast({ text: '已合并云端记录', icon: 'none' })
    }
  })

  $('exportBtn').addEventListener('click', exportJson)
  $('importBtn').addEventListener('click', () => $('importFile').click())
  $('importFile').addEventListener('change', importJson)

  // AI 设置抽屉
  $('aiBackdrop').addEventListener('click', () => closeSheet('aiSheet'))
  $('aiClose').addEventListener('click', () => closeSheet('aiSheet'))
  $('aiCancel').addEventListener('click', () => closeSheet('aiSheet'))
  $('aiRun').addEventListener('click', async () => {
    const baseURL = $('aiBaseUrl').value.trim()
    const model = $('aiModel').value.trim()
    const apiKey = $('aiApiKey').value.trim()
    if (storage) {
      storage.setItem('fitcal.ai.v1', JSON.stringify({ baseURL, model, apiKey }))
    }
    closeSheet('aiSheet')
    await runAiAnalysis()
  })
}

function fillSettings() {
  $('setWeekGoal').value = state.settings.weekGoal
  $('setMonthGoal').value = state.settings.monthGoal
  $('setMins').value = state.settings.defaultMins
  $('setAiAuto').checked = !!state.settings.aiAuto
  $('setSyncId').value = state.settings.syncId
  $('syncNote').textContent = cloud.enabled
    ? '已启用云端同步。口令相当于密码，换设备时填同一口令即可合并记录。'
    : '当前 Worker 未配置 KV 存储，记录只保存在本机。'
}

function openSettings() {
  fillSettings()
  openSheetFn('settingsSheet', 'settingsBackdrop')
}

async function openAiSheet() {
  const saved = readAiPrefs()
  $('aiBaseUrl').value = saved.baseURL || ''
  $('aiModel').value = saved.model || ''
  $('aiApiKey').value = saved.apiKey || ''
  $('aiStatus').className = 'ai-status'
  $('aiStatus').textContent = '正在加载 page-agent…'
  openSheetFn('aiSheet', 'aiBackdrop')

  const ok = await loadPageAgent()
  const status = $('aiStatus')
  if (ok) {
    status.className = 'ai-status ok'
    status.textContent = saved.apiKey
      ? 'page-agent 已就绪，将使用你填写的模型服务生成分析。'
      : 'page-agent 已就绪。未填写 Key 时会使用官方免费测试模型（仅用于技术评估）。'
  } else {
    status.className = 'ai-status bad'
    status.textContent = 'page-agent 脚本加载失败（网络受限）。页面仍会显示离线生成的本地分析。'
  }
}

async function exportJson() {
  const data = {
    app: 'fitness-checkin-calendar',
    version: state.version,
    exportedAt: new Date().toISOString(),
    marks: state.marks,
    unmarks: state.unmarks,
    settings: state.settings,
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const name = `健身打卡-${ymd(new Date())}.json`
  const file = new File([blob], name, { type: 'application/json' })
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: '健身打卡记录' })
      return
    } catch {
      /* 用户取消则走下载 */
    }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
  showToast({ text: '已导出', icon: 'none' })
}

async function importJson(e) {
  const file = e.target.files && e.target.files[0]
  if (!file) return
  try {
    const text = await file.text()
    const parsed = normalizeState(JSON.parse(text))
    state = mergeStates(state, parsed)
    persist()
    renderAll()
    showToast({ text: '已导入并合并记录' })
  } catch {
    showToast({ text: '文件格式不对', icon: 'warn' })
  } finally {
    e.target.value = ''
  }
}

/* ---------- 启动 ---------- */

function boot() {
  state = pruneTombstones(state, ymd(new Date()))
  if (!state.meta.seeded && Object.keys(state.marks).length === 0) {
    state = setMeta(state, { seeded: true })
  }
  cursor = new Date()
  selection = ymd(new Date())
  renderAll()
  attachGestures()
  attachRecentGestures()
  bindEvents()
  void initSync()

  // 每次打开 / 回到前台都检查：新的周或月第一次打开就要出分析
  maybeShowReview('auto')
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    refreshTodayIfNeeded()
    maybeShowReview('auto')
  })
  window.addEventListener('pageshow', refreshTodayIfNeeded)

  // 预热 page-agent（不自动弹面板）
  if (navigator.onLine) {
    setTimeout(loadPageAgent, 1200)
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot)
} else {
  boot()
}

// 方便排错：控制台里 __fitcal.state 查看当前数据
window.__fitcal = {
  get state() {
    return state
  },
  get view() {
    return view
  },
  gotoToday,
  refresh: renderAll,
  reviews: maybeShowReview,
  ai: runAiAnalysis,
  emptyState,
  serialize,
}
