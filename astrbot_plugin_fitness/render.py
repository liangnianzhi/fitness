"""render.py — 把云端文档渲染成聊天里读得懂的文本。

原则：
  - 数字全部来自云端实测值，不猜。
  - 用中文、短句、少格式，适配微信/QQ 等聊天渠道。
"""

from __future__ import annotations

from datetime import date

from . import statics as st


def render_today(doc: dict, today: date) -> str:
    key = st.ymd(today)
    mark = st.mark_of(doc, key)
    week = st.week_stats(doc, today)
    week_goal, _ = st.goal_of(doc)
    run = st.streak(doc, today)

    head = f"{key} {st.weekday_cn(today)}"
    if mark:
        body = f"今天已打卡：{st.items_summary(mark)}，共 {mark.get('mins')} 分钟，感觉{st.effort_label(mark.get('effort'))}。"
    else:
        body = "今天还没打卡。"

    tail = [
        f"本周 {week['count']}/{week_goal} 次（{week['minutes']} 分钟）",
        f"连续 {run['current']} 天" if run["current"] else "连续记录已断",
    ]
    return f"{head}\n{body}\n" + " · ".join(tail)


def render_week(doc: dict, anchor: date) -> str:
    week = st.week_stats(doc, anchor)
    goal, _ = st.goal_of(doc)
    lines = [f"{week['start']} ~ {week['end']}"]
    lines.append(f"打卡 {week['count']} 次，目标 {goal} 次，共 {week['minutes']} 分钟。")

    if week["count"] >= goal:
        lines.append("这周达标了，保持就好。")
    elif week["count"] == 0:
        lines.append("这周还一次都没练，先安排一次 20 分钟的。")
    else:
        lines.append(f"还差 {goal - week['count']} 次。")

    if week["by_item"]:
        top = sorted(week["by_item"].items(), key=lambda kv: -kv[1])
        parts = [f"{name}×{n}" for name, n in top]
        lines.append("项目：" + "、".join(parts))

    # 逐天明细，方便一眼看出哪天断的
    detail = []
    cursor = st.parse_ymd(week["start"])
    end = st.parse_ymd(week["end"])
    while cursor <= end:
        key = st.ymd(cursor)
        mark = st.mark_of(doc, key)
        detail.append(f"{cursor.day}日 {'✓' if mark else '·'}")
        cursor = st.add_days(cursor, 1)
    lines.append(" ".join(detail))
    return "\n".join(lines)


def render_month(doc: dict, anchor: date) -> str:
    month = st.month_stats(doc, anchor)
    _, goal = st.goal_of(doc)
    lines = [f"{anchor.year} 年 {anchor.month} 月"]
    lines.append(f"打卡 {month['count']} 次，目标 {goal} 次，共 {month['minutes']} 分钟。")
    if month["count"] >= goal:
        lines.append("本月达标。")
    else:
        lines.append(f"还差 {goal - month['count']} 次。")
    if month["by_item"]:
        top = sorted(month["by_item"].items(), key=lambda kv: -kv[1])[:5]
        lines.append("项目：" + "、".join(f"{n}×{c}" for n, c in top))
    return "\n".join(lines)


def render_recent(doc: dict, limit: int = 7) -> str:
    keys = st.checked_keys(doc)
    if not keys:
        return "还没有打卡记录，今天开始第一次吧。"
    rows = []
    for key in list(reversed(keys))[:limit]:
        mark = st.mark_of(doc, key)
        if not mark:
            continue
        d = st.parse_ymd(key)
        rows.append(
            f"{key[5:]} {st.weekday_cn(d)}  {st.items_summary(mark)} · {mark.get('mins')}′"
        )
    run = st.streak(doc, date.today())
    head = f"最近 {len(rows)} 次（累计 {len(keys)} 次，最长连续 {run['best']} 天）"
    return head + "\n" + "\n".join(rows)


def render_stats(doc: dict, today: date) -> str:
    week = st.week_stats(doc, today)
    month = st.month_stats(doc, today)
    week_goal, month_goal = st.goal_of(doc)
    run = st.streak(doc, today)
    total = len(st.checked_keys(doc))
    return "\n".join(
        [
            f"累计 {total} 次打卡",
            f"本周 {week['count']}/{week_goal} 次 · {week['minutes']} 分钟",
            f"本月 {month['count']}/{month_goal} 次 · {month['minutes']} 分钟",
            f"当前连续 {run['current']} 天 · 最长 {run['best']} 天",
        ]
    )


def render_marked(entry: dict, day: str, changed: bool) -> str:
    if not entry:
        return f"{day} 已更新。"
    verb = "更新" if changed else "记录"
    return (
        f"{day} 已{verb}：{st.items_summary(entry)}，共 {entry.get('mins')} 分钟，"
        f"感觉{st.effort_label(entry.get('effort'))}。"
    )
