"""statics.py — 与前端 store.js 对齐的常量与纯函数。

为什么要在 Python 里再写一份：
  Worker 只做结构校验与合并，不做业务推导。机器人要在本地算出
  「今天是否已打卡」「连续几天」「本周完成几次」这些结论，就必须
  复用同一套规则，否则同一份数据在 App 和机器人里会显示不一致。

  这里只实现「读」，不在本地重算 mins/effort 之类的派生值 —— 那些
  一律相信云端返回值，避免两边口径漂移。
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

# 辛苦程度：与 store.js 的 EFFORT_LEVELS 完全一致（id 不可改）
EFFORT_LEVELS = [
    ("easy", "轻松", "像热身，能边练边聊天"),
    ("normal", "适中", "有出汗，呼吸略快"),
    ("hard", "吃力", "说话费劲，但还能坚持"),
    ("drained", "脱力", "练完直接瘫，需要恢复"),
    ("maxed", "力竭", "最后一组完全做不动"),
]
EFFORT_IDS = [e[0] for e in EFFORT_LEVELS]
EFFORT_LABELS = {e[0]: e[1] for e in EFFORT_LEVELS}
DEFAULT_EFFORT = "normal"

# 内置项目，与 store.js 的 BUILTIN_QUICK_ITEMS 一致
BUILTIN_QUICK_ITEMS = ["跑步机", "力量训练", "拉伸", "团操", "动感单车", "游泳"]

MAX_TAG_LEN = 12


def clean_tag(raw) -> str:
    """标签清洗：压缩空白、去首尾、截断到 12 字，与 store.js 的 cleanTag 一致。"""
    if not isinstance(raw, str):
        return ""
    return " ".join(raw.split()).strip()[:MAX_TAG_LEN]


def normalize_effort(raw) -> str:
    return raw if raw in EFFORT_IDS else DEFAULT_EFFORT


def effort_label(raw) -> str:
    return EFFORT_LABELS.get(normalize_effort(raw), "适中")


def today_key() -> str:
    """本地时区的今天，格式 YYYY-MM-DD（绝不用 UTC 判跨日）。"""
    return date.today().isoformat()


def ymd(d: date) -> str:
    return d.isoformat()


def parse_ymd(key: str) -> date:
    return datetime.strptime(key, "%Y-%m-%d").date()


def add_days(d: date, n: int) -> date:
    return d + timedelta(days=n)


def start_of_week(d: date) -> date:
    """周一为一周之始（与 analysis.js 一致）。"""
    return d - timedelta(days=d.weekday())


def end_of_week(d: date) -> date:
    return start_of_week(d) + timedelta(days=6)


def start_of_month(d: date) -> date:
    return d.replace(day=1)


def end_of_month(d: date) -> date:
    nxt = (d.replace(day=28) + timedelta(days=4)).replace(day=1)
    return nxt - timedelta(days=1)


def is_checked(doc: dict, key: str) -> bool:
    """已打卡 = 打卡时间戳晚于取消打卡时间戳（与 analysis.js 的 isChecked 一致）。"""
    marks = (doc or {}).get("marks") or {}
    mark = marks.get(key)
    if not mark:
        return False
    unm = ((doc or {}).get("unmarks") or {}).get(key) or 0
    return int(mark.get("t") or 0) > int(unm or 0)


def mark_of(doc: dict, key: str):
    if not is_checked(doc, key):
        return None
    return ((doc or {}).get("marks") or {}).get(key)


def checked_keys(doc: dict) -> list[str]:
    marks = (doc or {}).get("marks") or {}
    return sorted(k for k in marks.keys() if is_checked(doc, k))


def stats_between(doc: dict, start: date, end: date) -> dict:
    """统计 [start, end] 区间内的次数、分钟数与项目分布。"""
    count = 0
    minutes = 0
    by_item: dict[str, int] = {}
    cursor = start
    while cursor <= end:
        key = ymd(cursor)
        mark = mark_of(doc, key)
        if mark:
            count += 1
            minutes += int(mark.get("mins") or 0)
            for it in mark.get("items") or []:
                name = it.get("name") or "训练"
                by_item[name] = by_item.get(name, 0) + 1
        cursor = add_days(cursor, 1)
    return {
        "start": ymd(start),
        "end": ymd(end),
        "count": count,
        "minutes": minutes,
        "by_item": by_item,
    }


def week_stats(doc: dict, anchor: date) -> dict:
    return stats_between(doc, start_of_week(anchor), end_of_week(anchor))


def month_stats(doc: dict, anchor: date) -> dict:
    return stats_between(doc, start_of_month(anchor), end_of_month(anchor))


def streak(doc: dict, today: date) -> dict:
    """当前连续与历史最长连续。今天没打卡也不算断，从昨天起算。"""
    keys = checked_keys(doc)
    best = 0
    run = 0
    prev = None
    for key in keys:
        d = parse_ymd(key)
        run = run + 1 if prev and (d - prev).days == 1 else 1
        best = max(best, run)
        prev = d

    current = 0
    cursor = today if is_checked(doc, ymd(today)) else add_days(today, -1)
    while is_checked(doc, ymd(cursor)):
        current += 1
        cursor = add_days(cursor, -1)
    return {"current": current, "best": best}


def goal_of(doc: dict) -> tuple[int, int]:
    """返回 (周目标, 月目标)，缺省值与 store.js 一致：3 / 12。"""
    settings = (doc or {}).get("settings") or {}

    def as_int(v, fallback):
        try:
            return int(v)
        except (TypeError, ValueError):
            return fallback

    return as_int(settings.get("weekGoal"), 3), as_int(settings.get("monthGoal"), 12)


def items_summary(mark: dict) -> str:
    """把一天的 items 拼成「力量训练 40′、拉伸 15′」这种可读串。"""
    items = mark.get("items") or []
    if not items:
        return "训练"
    parts = []
    for it in items:
        name = it.get("name") or "训练"
        mins = it.get("mins")
        parts.append(f"{name} {mins}′" if mins else name)
    return "、".join(parts)


def weekday_cn(d: date) -> str:
    return ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][d.weekday()]
