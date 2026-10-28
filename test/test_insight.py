"""insight.py 的单元测试：建议必须基于真实记录，数据不足要明说。"""

from __future__ import annotations

import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from astrbot_plugin_fitness import insight, statics as st  # noqa: E402


def make_doc(marked: dict[str, list[tuple[str, int]]]) -> dict:
    """按 {日期: [(项目, 分钟)]} 造一份文档。"""
    marks = {}
    for day, items in marked.items():
        total = sum(m for _, m in items)
        marks[day] = {
            "t": 1000,
            "mins": total,
            "effort": "normal",
            "items": [{"name": n, "mins": m, "effort": "normal"} for n, m in items],
        }
    return {"marks": marks, "unmarks": {}, "settings": {"weekGoal": 3, "monthGoal": 12}}


class TestClassify(unittest.TestCase):
    def test_parts(self):
        self.assertEqual(insight.classify("深蹲"), "腿")
        self.assertEqual(insight.classify("卧推"), "上肢")
        self.assertEqual(insight.classify("跑步机"), "有氧")
        self.assertEqual(insight.classify("瑜伽"), "柔韧")
        self.assertEqual(insight.classify("平板支撑"), "核心")

    def test_unknown_is_other(self):
        self.assertEqual(insight.classify("打球"), "其他")


class TestSuggestion(unittest.TestCase):
    def test_empty_doc_does_not_crash(self):
        today = date(2026, 10, 28)
        text = insight.suggestion({"marks": {}, "unmarks": {}}, today)
        self.assertIsInstance(text, str)
        self.assertTrue(text)

    def test_neglected_part_detected(self):
        today = date(2026, 10, 28)
        # 腿在 20 天前练过两次，最近 10 天只练上肢
        doc = make_doc(
            {
                (today - timedelta(days=20)).isoformat(): [("深蹲", 40)],
                (today - timedelta(days=19)).isoformat(): [("深蹲", 40)],
                (today - timedelta(days=1)).isoformat(): [("卧推", 40)],
            }
        )
        neglected = insight.neglected_parts(doc, today)
        self.assertIn("腿", neglected)

    def test_recent_week_count_mentioned(self):
        today = date(2026, 10, 28)
        doc = make_doc({today.isoformat(): [("跑步机", 30)]})
        text = insight.suggestion(doc, today)
        self.assertIn("本周", text)


class TestRhythm(unittest.TestCase):
    def test_too_little_data(self):
        today = date(2026, 10, 28)
        doc = make_doc({today.isoformat(): [("跑步机", 30)]})
        self.assertIn("不够", insight.rhythm(doc, today))

    def test_detects_habitual_weekday(self):
        today = date(2026, 10, 28)
        # 连续 4 周的周三都练
        marked = {}
        for w in range(4):
            d = today - timedelta(days=7 * w)
            marked[d.isoformat()] = [("跑步机", 30)]
        doc = make_doc(marked)
        text = insight.rhythm(doc, today)
        self.assertIn("周三", text)


class TestCompare(unittest.TestCase):
    def test_both_empty(self):
        today = date(2026, 10, 28)
        text = insight.compare_weeks({"marks": {}, "unmarks": {}}, today)
        self.assertIn("都还没开始", text)

    def test_reports_both_weeks(self):
        today = date(2026, 10, 28)
        doc = make_doc(
            {
                (today - timedelta(days=7)).isoformat(): [("跑步机", 30)],
                today.isoformat(): [("跑步机", 30)],
            }
        )
        text = insight.compare_weeks(doc, today)
        self.assertIn("上周", text)
        self.assertIn("本周", text)


if __name__ == "__main__":
    unittest.main()
