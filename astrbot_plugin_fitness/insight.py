"""insight.py — 从打卡数据里算「下一步该练什么」，而不是只报次数。

为什么单独一个文件：
  render.py 负责「把数字说清楚」，这里负责「从数字里看出趋势」。
  两类事混在一起会让两边都难改，而且这里的逻辑最需要单元测试。

所有结论都基于真实记录，不猜、不编。数据不足时明确说「样本太少」，
而不是硬凑一个结论 —— 教练建议最怕的就是假装很懂。
"""

from __future__ import annotations

from datetime import date

from . import statics as st

# 常见部位关键词，用来从项目名里认出「这次练的是哪儿」
PART_KEYWORDS = {
    "腿": ["腿", "深蹲", "硬拉", "弓步", "臀", "小腿"],
    "上肢": ["胸", "背", "肩", "手臂", "二头", "三头", "上肢", "卧推", "引体", "划船"],
    "核心": ["核心", "腹", "平板", "卷腹"],
    "有氧": ["跑步", "跑", "骑车", "动感单车", "游泳", "有氧", "跳绳", "椭圆", "爬楼"],
    "柔韧": ["拉伸", "瑜伽", "放松", "泡沫轴", "柔韧"],
}

# 一周没练到这个部位就算「冷落」
NEGLECT_WINDOW_DAYS = 10


def classify(name: str) -> str:
    """把一个项目名归到部位；认不出就归「其他」。"""
    for part, words in PART_KEYWORDS.items():
        for w in words:
            if w in name:
                return part
    return "其他"


def part_stats(doc: dict, days: int = 28, today: date | None = None) -> dict:
    """统计最近 N 天里每个部位练了几次、最后一次是哪天。"""
    today = today or date.today()
    start = st.add_days(today, -(days - 1))
    counts: dict[str, int] = {}
    last: dict[str, str] = {}

    cursor = start
    while cursor <= today:
        key = st.ymd(cursor)
        mark = st.mark_of(doc, key)
        if mark:
            seen = set()
            for it in mark.get("items") or []:
                part = classify(it.get("name") or "")
                seen.add(part)
            for part in seen:
                counts[part] = counts.get(part, 0) + 1
                last[part] = key  # 日期递增，最后写进去的就是最近一次
        cursor = st.add_days(cursor, 1)

    return {"counts": counts, "last": last, "days": days}


def neglected_parts(doc: dict, today: date | None = None) -> list[str]:
    """找出「以前练过、但最近 10 天没碰」的部位。"""
    today = today or date.today()
    recent = part_stats(doc, days=NEGLECT_WINDOW_DAYS, today=today)
    ever = part_stats(doc, days=3650, today=today)["counts"]

    out = []
    for part, times in ever.items():
        if part == "其他":
            continue
        if times < 2:  # 只练过一次的不算「冷落」，避免误报
            continue
        if recent["counts"].get(part, 0) == 0:
            out.append(part)
    return out


def suggestion(doc: dict, today: date | None = None) -> str:
    """给出「下次该练什么」，一句话，可直接说出口。"""
    today = today or date.today()
    week = st.week_stats(doc, today)
    week_goal, _ = st.goal_of(doc)
    remain_days = (st.end_of_week(today) - today).days + 1

    parts = part_stats(doc, days=28, today=today)
    neglected = neglected_parts(doc, today)

    lines = []

    # 1) 本周进度
    if week["count"] == 0:
        lines.append(f"本周还一次没练，剩 {remain_days} 天。")
    elif week["count"] < week_goal:
        lines.append(f"本周 {week['count']}/{week_goal}，还差 {week_goal - week['count']} 次，剩 {remain_days} 天。")

    # 2) 最该补的部位
    if neglected:
        lines.append(f"{'、'.join(neglected)} 已经 10 天以上没练了，下次优先安排。")
    elif parts["counts"]:
        top = max(parts["counts"].items(), key=lambda kv: kv[1])
        lines.append(f"最近 {parts['days']} 天练得最多的是 {top[0]}（{top[1]} 次），分布还算均衡。")
    else:
        lines.append("记录还太少，先攒两三次再谈分布。")

    return " ".join(lines)


def rhythm(doc: dict, today: date | None = None) -> str:
    """分析「你习惯周几练」，帮助用户把训练固定下来。"""
    today = today or date.today()
    keys = [k for k in st.checked_keys(doc) if st.parse_ymd(k) <= today][-60:]
    if len(keys) < 4:
        return "记录还不够多，练到 4 次以上再来看你的规律。"

    buckets = [0] * 7
    for key in keys:
        buckets[st.parse_ymd(key).weekday()] += 1

    names = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
    ranked = sorted(range(7), key=lambda i: -buckets[i])
    top = [names[i] for i in ranked[:3] if buckets[i] > 0]
    if not top:
        return "还没有形成固定节奏。"

    empty = [names[i] for i in range(7) if buckets[i] == 0]
    msg = f"你最常在 {'、'.join(top)} 训练。"
    if empty:
        msg += f"{'、'.join(empty)} 目前是空的，可以挑一天做恢复性训练。"
    return msg


def compare_weeks(doc: dict, today: date | None = None) -> str:
    """本周 vs 上周的进度对比，适合用户问「我最近怎么样」。"""
    today = today or date.today()
    this_week = st.week_stats(doc, today)
    last_week = st.week_stats(doc, st.add_days(today, -7))
    week_goal, _ = st.goal_of(doc)

    # 上周是完整的一周，本周还在进行中，直接比次数会不公平，
    # 所以按「已过天数」折算成同口径再比。
    elapsed = today.weekday() + 1
    delta = this_week["count"] - last_week["count"]
    pace_last = last_week["count"] * (elapsed / 7.0)

    if last_week["count"] == 0 and this_week["count"] == 0:
        return "本周和上周都还没开始，先安排一次 20 分钟的。"
    if last_week["count"] == 0:
        return f"上周没练，本周已经 {this_week['count']} 次，重新接上了。"

    verdict = "比上周同期快" if this_week["count"] > pace_last else "比上周同期慢"
    return (
        f"上周整周 {last_week['count']} 次（{last_week['minutes']} 分钟），"
        f"本周前 {elapsed} 天 {this_week['count']} 次。按同期折算{verdict}。"
    )
