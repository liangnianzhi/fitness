"""context.py — 给对话提供「客观事实」。

为什么单独一个文件：
  用户随口说「最近有点累」「今天不想动」时，模型最容易被带偏 ——
  要么空洞地鼓励，要么编造「你这周练了 3 次」这种没根据的话。

  这个模块只做一件事：把当前真实状态压成一小段事实文本，
  让模型基于事实说话，而不是凭空安慰。数字全部来自云端记录，不猜。

  输出要短。它会被塞进对话上下文，太长会挤掉其他内容。
"""

from __future__ import annotations

from datetime import date

from . import insight
from . import statics as st


def _streak_phrase(run: dict) -> str:
    if run["current"] > 0:
        return f"已连续 {run['current']} 天"
    if run["best"] > 0:
        return f"连续记录已断（历史最长 {run['best']} 天）"
    return "还没有连续记录"


def _gap_days(doc: dict, today: date) -> int | None:
    """距离上一次打卡过了几天；从未打卡返回 None。"""
    keys = [k for k in st.checked_keys(doc) if st.parse_ymd(k) <= today]
    if not keys:
        return None
    return (today - st.parse_ymd(keys[-1])).days


def snapshot(doc: dict, today: date | None = None) -> str:
    """当前状态的紧凑事实摘要，供模型在对话里引用。"""
    today = today or date.today()
    week = st.week_stats(doc, today)
    week_goal, month_goal = st.goal_of(doc)
    run = st.streak(doc, today)
    gap = _gap_days(doc, today)
    total = len(st.checked_keys(doc))

    lines = []
    lines.append(f"今天：{'已打卡' if st.is_checked(doc, st.ymd(today)) else '未打卡'}")

    if gap is None:
        lines.append("还没有任何打卡记录")
    else:
        if gap == 0:
            lines.append("上次训练就是今天")
        elif gap == 1:
            lines.append("上次训练是昨天")
        else:
            lines.append(f"上次训练是 {gap} 天前")

    lines.append(f"本周 {week['count']}/{week_goal} 次、{week['minutes']} 分钟")
    lines.append(_streak_phrase(run))
    lines.append(f"累计 {total} 次")

    if week["by_item"]:
        top = sorted(week["by_item"].items(), key=lambda kv: -kv[1])[:3]
        lines.append("本周项目：" + "、".join(f"{n}×{c}" for n, c in top))

    neglected = insight.neglected_parts(doc, today)
    if neglected:
        lines.append(f"近期没练：{'、'.join(neglected)}")

    # 距离目标还差几次，是对话里最常被问到的
    need = max(0, week_goal - week["count"])
    left = (st.end_of_week(today) - today).days + 1
    if need == 0:
        lines.append(f"本周目标已达成（本周还剩 {left} 天）")
    else:
        lines.append(f"距本周目标还差 {need} 次，本周还剩 {left} 天")

    return "；".join(lines)


# 用户话里出现这些词，说明当下不想被催，先共情再谈训练
_TIRED_WORDS = ("累", "疲", "不想", "坚持不下", "没动力", "摆烂", "放弃", "懒", "烦", "痛", "难受")
_PAIN_WORDS = ("疼", "痛", "伤", "拉伤", "不舒服")


def _user_mood(question: str) -> str:
    """从用户原话里识别当下的状态，返回 none/tired/pain。"""
    text = (question or "").strip()
    if not text:
        return "none"
    if any(w in text for w in _PAIN_WORDS):
        return "pain"
    if any(w in text for w in _TIRED_WORDS):
        return "tired"
    return "none"


def mood_hint(doc: dict, today: date | None = None, question: str = "") -> str:
    """根据数据 + 用户当下情绪给一句「状态判断」，避免模型一味打鸡血。

    只陈述可观测的事实倾向，不做心理诊断。
    """
    today = today or date.today()
    week = st.week_stats(doc, today)
    week_goal, _ = st.goal_of(doc)
    run = st.streak(doc, today)
    gap = _gap_days(doc, today)

    # 用户明确表达疲惫或疼痛时，优先级高于数据上的进度。
    # 这时候继续催进度是最让人反感的回应方式。
    mood = _user_mood(question)
    if mood == "pain":
        return "用户在说疼痛或不适，优先提醒休息与就医，不要建议继续训练，也不要用数据催进度"
    if mood == "tired":
        if gap is not None and gap >= 3:
            return (
                f"用户说累且已 {gap} 天没练，先认同这种状态，"
                "再提议一次很短很轻的恢复活动，不给量化指标"
            )
        return "用户说累，先共情，不要用本周目标施压；可以建议降量或直接休息一天"

    if gap is None:
        return "还没开始记录，适合先鼓励迈出第一步，别给压力"
    if gap >= 7:
        return f"已经 {gap} 天没练，状态可能在下滑，适合建议先来一次很短的"
    if gap >= 3:
        return f"{gap} 天没练，适合提议轻松一点的恢复训练"
    if run["current"] >= 7:
        return f"连续 {run['current']} 天，强度可能偏高，适合提醒注意休息"
    if week["count"] >= week_goal:
        return "本周目标已达成，不需要再加量，适合肯定并提醒恢复"
    if week["count"] == 0:
        return "本周还没开始，适合给一个具体的、低门槛的行动建议"
    return "节奏正常，适合平实地肯定并给出下一步"


def answer(doc: dict, question: str = "", today: date | None = None) -> str:
    """把事实和状态判断拼成给模型的完整上下文。"""
    today = today or date.today()
    q = (question or "").strip()
    parts = [f"[真实状态] {snapshot(doc, today)}"]
    parts.append(f"[语气建议] {mood_hint(doc, today, q)}")

    if q:
        parts.append(f"[用户关注] {q}")
    return "\n".join(parts)
