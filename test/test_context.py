"""context.py 测试：给对话的「事实」必须准确，不能编。"""

from __future__ import annotations

import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from astrbot_plugin_fitness import context  # noqa: E402


def make_doc(marked: dict[str, list[tuple[str, int]]], settings=None) -> dict:
    marks = {}
    for day, items in marked.items():
        total = sum(m for _, m in items)
        marks[day] = {
            "t": 1000,
            "mins": total,
            "effort": "normal",
            "items": [{"name": n, "mins": m, "effort": "normal"} for n, m in items],
        }
    return {
        "marks": marks,
        "unmarks": {},
        "settings": settings or {"weekGoal": 3, "monthGoal": 12},
    }


TODAY = date(2026, 10, 29)  # 周四


class TestSnapshot(unittest.TestCase):
    def test_empty_doc(self):
        text = context.snapshot({"marks": {}, "unmarks": {}, "settings": {}}, TODAY)
        self.assertIn("未打卡", text)
        self.assertIn("还没有任何打卡记录", text)
        self.assertIn("累计 0 次", text)

    def test_gap_yesterday(self):
        doc = make_doc({(TODAY - timedelta(days=1)).isoformat(): [("力量训练", 45)]})
        self.assertIn("上次训练是昨天", context.snapshot(doc, TODAY))

    def test_gap_today(self):
        doc = make_doc({TODAY.isoformat(): [("力量训练", 45)]})
        self.assertIn("上次训练就是今天", context.snapshot(doc, TODAY))

    def test_gap_multiple_days(self):
        doc = make_doc({(TODAY - timedelta(days=5)).isoformat(): [("跑步机", 30)]})
        self.assertIn("5 天前", context.snapshot(doc, TODAY))

    def test_week_progress_and_goal(self):
        doc = make_doc({"2026-10-26": [("力量训练", 45)]})  # 本周一
        text = context.snapshot(doc, TODAY)
        self.assertIn("本周 1/3 次", text)
        self.assertIn("还差 2 次", text)

    def test_goal_reached(self):
        doc = make_doc(
            {
                "2026-10-26": [("力量训练", 45)],
                "2026-10-27": [("跑步机", 30)],
                "2026-10-28": [("拉伸", 20)],
            }
        )
        text = context.snapshot(doc, TODAY)
        self.assertIn("已达成", text)
        self.assertNotIn("还差", text)

    def test_streak_phrase(self):
        doc = make_doc(
            {
                TODAY.isoformat(): [("力量训练", 45)],
                (TODAY - timedelta(days=1)).isoformat(): [("力量训练", 45)],
            }
        )
        self.assertIn("连续 2 天", context.snapshot(doc, TODAY))

    def test_neglected_part_listed(self):
        doc = make_doc(
            {
                "2026-10-01": [("深蹲", 40)],
                "2026-10-02": [("深蹲", 40)],
                TODAY.isoformat(): [("卧推", 40)],
            }
        )
        text = context.snapshot(doc, TODAY)
        self.assertIn("近期没练", text)
        self.assertIn("腿", text)


class TestMoodHint(unittest.TestCase):
    def test_never_started(self):
        hint = context.mood_hint({"marks": {}, "unmarks": {}, "settings": {}}, TODAY)
        self.assertIn("还没开始", hint)

    def test_long_gap_suggests_short_session(self):
        doc = make_doc({(TODAY - timedelta(days=10)).isoformat(): [("跑步机", 30)]})
        hint = context.mood_hint(doc, TODAY)
        self.assertIn("10 天", hint)
        self.assertIn("短", hint)

    def test_long_streak_mentions_rest(self):
        marked = {
            (TODAY - timedelta(days=i)).isoformat(): [("力量训练", 40)] for i in range(8)
        }
        hint = context.mood_hint(make_doc(marked), TODAY)
        self.assertIn("连续", hint)
        self.assertIn("休息", hint)

    def test_goal_reached_says_no_more_volume(self):
        doc = make_doc(
            {
                "2026-10-26": [("力量训练", 45)],
                "2026-10-27": [("跑步机", 30)],
                "2026-10-28": [("拉伸", 20)],
                TODAY.isoformat(): [("游泳", 30)],
            }
        )
        hint = context.mood_hint(doc, TODAY)
        self.assertIn("已达成", hint)
        self.assertIn("不需要再加量", hint)


class TestAnswer(unittest.TestCase):
    def test_contains_all_sections(self):
        doc = make_doc({TODAY.isoformat(): [("力量训练", 45)]})
        text = context.answer(doc, "今天练得够吗", TODAY)
        self.assertIn("[真实状态]", text)
        self.assertIn("[语气建议]", text)
        self.assertIn("[用户关注] 今天练得够吗", text)

    def test_no_question_omits_section(self):
        doc = make_doc({TODAY.isoformat(): [("力量训练", 45)]})
        text = context.answer(doc, "", TODAY)
        self.assertNotIn("[用户关注]", text)

    def test_output_stays_compact(self):
        """这段会塞进对话上下文，太长会挤掉别的内容。"""
        doc = make_doc(
            {
                (TODAY - timedelta(days=i)).isoformat(): [("力量训练", 40)] for i in range(10)
            }
        )
        text = context.answer(doc, "我最近怎么样", TODAY)
        self.assertLess(len(text), 400, f"上下文过长：{len(text)} 字符")


if __name__ == "__main__":
    unittest.main()


class TestUserMood(unittest.TestCase):
    """用户表达疲惫/疼痛时，优先级必须高于数据进度。"""

    def doc(self):
        return make_doc({TODAY.isoformat(): [("力量训练", 45)]})

    def test_tired_word_detected(self):
        text = context.answer(self.doc(), "最近好累不想练了", TODAY)
        self.assertIn("共情", text)
        self.assertNotIn("节奏正常", text)

    def test_pain_takes_priority(self):
        text = context.answer(self.doc(), "膝盖有点疼", TODAY)
        self.assertIn("就医", text)

    def test_pain_beats_tired(self):
        text = context.answer(self.doc(), "很累而且腰疼", TODAY)
        self.assertIn("就医", text, "同时出现疼痛和疲惫时，疼痛优先")

    def test_normal_question_keeps_normal_hint(self):
        text = context.answer(self.doc(), "我今天练得怎么样", TODAY)
        self.assertIn("节奏正常", text)

    def test_tired_with_long_gap_suggests_light(self):
        doc = make_doc({(TODAY - timedelta(days=5)).isoformat(): [("跑步机", 30)]})
        text = context.answer(doc, "最近好累", TODAY)
        self.assertIn("5 天", text)
        self.assertIn("轻", text)
