"""render.py 测试：反馈文案必须准确，不能误导。"""

from __future__ import annotations

import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from astrbot_plugin_fitness import render, statics as st  # noqa: E402


def make_doc(count_this_week: int, week_goal: int = 3) -> dict:
    today = date.today()
    monday = st.start_of_week(today)
    marks = {}
    for i in range(count_this_week):
        day = st.add_days(monday, i)
        if day > today:
            break
        marks[st.ymd(day)] = {
            "t": 1000,
            "mins": 45,
            "effort": "normal",
            "items": [{"name": "力量训练", "mins": 45, "effort": "normal"}],
        }
    return {
        "marks": marks,
        "unmarks": {},
        "settings": {"weekGoal": week_goal, "monthGoal": 12},
    }


ENTRY = {
    "t": 1000,
    "mins": 45,
    "effort": "hard",
    "items": [{"name": "力量训练", "mins": 45, "effort": "hard"}],
}


class TestRenderMarked(unittest.TestCase):
    def test_includes_what_was_recorded(self):
        text = render.render_marked(ENTRY, "2026-10-29", False)
        self.assertIn("力量训练", text)
        self.assertIn("45", text)
        self.assertIn("吃力", text)

    def test_includes_week_progress(self):
        doc = make_doc(1)
        text = render.render_marked(ENTRY, st.today_key(), False, doc)
        self.assertIn("本周 1/3", text)
        self.assertIn("还差 2 次", text)

    def test_goal_reached_message(self):
        doc = make_doc(3)
        text = render.render_marked(ENTRY, st.today_key(), False, doc)
        self.assertIn("已达成", text)
        self.assertNotIn("还差", text)

    def test_no_doc_still_works(self):
        text = render.render_marked(ENTRY, "2026-10-29", False, None)
        self.assertIn("力量训练", text)
        self.assertNotIn("本周", text, "没有文档时不该编造进度")

    def test_empty_entry_does_not_lie(self):
        """返回空 entry 时不能说「已更新」，那会误导用户以为存上了。"""
        text = render.render_marked({}, "2026-10-29", True)
        self.assertNotIn("已更新", text)
        self.assertIn("确认", text)

    def test_changed_uses_different_verb(self):
        a = render.render_marked(ENTRY, "2026-10-29", False)
        b = render.render_marked(ENTRY, "2026-10-29", True)
        self.assertIn("记录", a)
        self.assertIn("更新", b)


class TestRenderToday(unittest.TestCase):
    def test_not_checked_today(self):
        doc = make_doc(0)
        text = render.render_today(doc, date.today())
        self.assertIn("还没打卡", text)

    def test_checked_today_shows_items(self):
        doc = make_doc(1)
        today_key = st.ymd(date.today())
        if today_key not in doc["marks"]:
            doc["marks"][today_key] = ENTRY
        text = render.render_today(doc, date.today())
        self.assertIn("已打卡", text)
        self.assertIn("力量训练", text)


if __name__ == "__main__":
    unittest.main()
