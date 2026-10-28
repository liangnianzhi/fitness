"""插件纯逻辑测试。不依赖 astrbot 框架，可直接 `python -m pytest` 或 unittest。

覆盖：
  - 别名归一（项目名、辛苦程度）
  - 日期解析与护栏
  - 多项目串解析
  - statics 的统计口径与 store.js 对齐
"""

from __future__ import annotations

import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from astrbot_plugin_fitness import aliases, statics as st  # noqa: E402


class TestAliases(unittest.TestCase):
    def test_mapping_targets_are_builtin(self):
        self.assertEqual(aliases.missing_aliases(), [])

    def test_effort_targets_are_valid(self):
        self.assertEqual(aliases.missing_efforts(), [])

    def test_item_canonical(self):
        cases = {
            "腿": "力量训练",
            "练腿": "力量训练",
            "撸铁": "力量训练",
            "深蹲": "力量训练",
            "跑步": "跑步机",
            "慢跑": "跑步机",
            "瑜伽": "拉伸",
            "骑车": "动感单车",
            "跳绳": "团操",
            "游泳": "游泳",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(aliases.canonical_item(raw, st.clean_tag), expected)

    def test_unknown_item_kept(self):
        # 认不出的词要原样保留，让用户当成自定义项目
        self.assertEqual(aliases.canonical_item("打球", st.clean_tag), "打球")

    def test_item_truncated_to_12(self):
        long = "很长的项目名称超过十二个字了"
        self.assertLessEqual(len(aliases.canonical_item(long, st.clean_tag)), 12)

    def test_effort_canonical(self):
        self.assertEqual(aliases.canonical_effort("挺累"), "hard")
        self.assertEqual(aliases.canonical_effort("力竭"), "maxed")
        self.assertEqual(aliases.canonical_effort("HARD"), "hard")
        self.assertIsNone(aliases.canonical_effort("说不清"))


class TestDayParsing(unittest.TestCase):
    """复刻 main.py 的解析逻辑（不导入框架）。"""

    @staticmethod
    def parse(raw: str) -> str:
        import re

        text = (raw or "").strip()
        today = date.today()
        if not text:
            return st.today_key()
        rel = {
            "今天": 0, "今日": 0, "today": 0,
            "昨天": -1, "昨日": -1, "yesterday": -1,
            "前天": -2, "大前天": -3,
        }
        if text in rel:
            return (today + timedelta(days=rel[text])).isoformat()
        if re.fullmatch(r"[+-]?\d{1,2}", text):
            return (today + timedelta(days=int(text))).isoformat()
        m = re.fullmatch(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", text)
        if m:
            try:
                return date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
            except ValueError:
                return ""
        m = re.fullmatch(r"(\d{1,2})[-/.](\d{1,2})", text)
        if m:
            try:
                return date(today.year, int(m.group(1)), int(m.group(2))).isoformat()
            except ValueError:
                return ""
        return ""

    def test_relative(self):
        today = date.today()
        self.assertEqual(self.parse(""), today.isoformat())
        self.assertEqual(self.parse("今天"), today.isoformat())
        self.assertEqual(self.parse("昨天"), (today + timedelta(days=-1)).isoformat())
        self.assertEqual(self.parse("前天"), (today + timedelta(days=-2)).isoformat())

    def test_absolute(self):
        self.assertEqual(self.parse("2026-10-28"), "2026-10-28")
        self.assertEqual(self.parse("2026/10/28"), "2026-10-28")

    def test_invalid(self):
        self.assertEqual(self.parse("乱写"), "")
        self.assertEqual(self.parse("2026-13-01"), "")


class TestStatics(unittest.TestCase):
    def doc(self):
        return {
            "marks": {
                "2026-10-26": {"t": 200, "mins": 30, "effort": "normal",
                               "items": [{"name": "跑步机", "mins": 30, "effort": "normal"}]},
                "2026-10-27": {"t": 300, "mins": 45, "effort": "hard",
                               "items": [{"name": "力量训练", "mins": 45, "effort": "hard"}]},
            },
            "unmarks": {"2026-10-25": 400},
            "settings": {"weekGoal": 4, "monthGoal": 16},
        }

    def test_is_checked_respects_unmark(self):
        doc = self.doc()
        # 取消打卡时间戳晚于打卡时间 -> 视为未打卡（与 store.js / analysis.js 一致）
        doc["marks"]["2026-10-24"] = {"t": 100, "mins": 20, "effort": "normal", "items": []}
        doc["unmarks"]["2026-10-24"] = 900
        self.assertFalse(st.is_checked(doc, "2026-10-24"))
        self.assertTrue(st.is_checked(doc, "2026-10-26"))

    def test_week_stats(self):
        anchor = date(2026, 10, 28)
        s = st.week_stats(self.doc(), anchor)
        self.assertEqual(s["count"], 2)
        self.assertEqual(s["minutes"], 75)
        self.assertEqual(s["by_item"], {"跑步机": 1, "力量训练": 1})

    def test_goals(self):
        self.assertEqual(st.goal_of(self.doc()), (4, 16))
        self.assertEqual(st.goal_of({}), (3, 12))

    def test_items_summary(self):
        mark = {"items": [{"name": "跑步", "mins": 20}, {"name": "拉伸", "mins": 15}]}
        self.assertEqual(st.items_summary(mark), "跑步 20′、拉伸 15′")

    def test_streak_today_not_required(self):
        doc = self.doc()
        # 今天没打卡但昨天有，连续数应至少为 1（不从今天算断）
        run = st.streak(doc, date(2026, 10, 28))
        self.assertGreaterEqual(run["current"], 1)


if __name__ == "__main__":
    unittest.main()
