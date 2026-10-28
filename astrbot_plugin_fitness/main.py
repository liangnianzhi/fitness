"""main.py — 健身打卡日历的机器人渠道插件（纯自然对话版）。

设计取舍：
  1. 不提供 /命令。所有能力都做成 LLM 工具，用户直接说人话即可。
  2. 不重写业务规则。打卡、合并、时长派生全部留在 store.js / worker.js，
     插件只负责「读文档 + 调 Worker 写接口」，保证 App 与机器人同一套口径。
  3. syncId 零配置：插件先问 Worker 的 /api/active 拿到当前口令，
     用户只要在 App 里打过卡（会自动登记），就不用再手抄那串口令。
  4. 写历史日期有护栏：不允许未来日期，最多回溯 30 天，防止模型乱填。
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta

from astrbot.api import logger
from astrbot.api.event import filter, AstrMessageEvent
from astrbot.api.star import Context, Star, register

from . import statics as st
from .client import FitnessClient, FitnessError
from . import insight, render
from .aliases import canonical_effort, canonical_item

MAX_BACKFILL_DAYS = 30


@register(
    "astrbot_plugin_fitness",
    "liangnianzhi",
    "健身打卡日历：直接说人话就能记录和查询，数据与云端 App 实时同步",
    "1.1.0",
)
class FitnessPlugin(Star):
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)
        self.config = config or {}

    # ---------- 基础设施 ----------

    def _client(self) -> FitnessClient:
        return FitnessClient(
            base_url=self.config.get("worker_url", ""),
            sync_id=self.config.get("sync_id", ""),
            timeout=int(self.config.get("request_timeout", 15) or 15),
        )

    async def _ready_client(self) -> FitnessClient:
        """返回已确定 syncId 的客户端（零配置时自动发现）。"""
        client = self._client()
        if not client.sync_id:
            await client.discover_sync_id()
        return client

    def _allow_tools(self) -> bool:
        value = self.config.get("allow_llm_tools", True)
        if isinstance(value, str):
            return value.strip().lower() not in ("false", "0", "no", "")
        return bool(value)

    # ---------- 参数解析 ----------

    @staticmethod
    def _parse_day(raw: str) -> str:
        """把模型给的日期规整成 YYYY-MM-DD。

        支持：空（今天）、2026-10-28、10-28、前天/昨天/今天、`-2`。
        返回空串表示解析失败，由调用方提示。
        """
        text = (raw or "").strip()
        today = date.today()

        if not text:
            return st.today_key()

        relative = {
            "今天": 0, "今日": 0, "today": 0,
            "昨天": -1, "昨日": -1, "yesterday": -1,
            "前天": -2, "大前天": -3,
        }
        if text in relative:
            return (today + timedelta(days=relative[text])).isoformat()

        # 形如 "-2" / "+0"
        if re.fullmatch(r"[+-]?\d{1,2}", text):
            return (today + timedelta(days=int(text))).isoformat()

        # 2026-10-28 或 2026/10/28
        m = re.fullmatch(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", text)
        if m:
            try:
                return date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
            except ValueError:
                return ""

        # 10-28（补当前年份）
        m = re.fullmatch(r"(\d{1,2})[-/.](\d{1,2})", text)
        if m:
            try:
                return date(today.year, int(m.group(1)), int(m.group(2))).isoformat()
            except ValueError:
                return ""

        return ""

    @staticmethod
    def _guard_day(day: str) -> str | None:
        """校验日期护栏；返回错误文案，None 表示通过。"""
        try:
            target = datetime.strptime(day, "%Y-%m-%d").date()
        except ValueError:
            return "日期我没看懂，可以说「今天」「昨天」或者 2026-10-28 这种格式。"
        today = date.today()
        if target > today:
            return "未来的日子还不能打卡。"
        if (today - target).days > MAX_BACKFILL_DAYS:
            return f"只能补录最近 {MAX_BACKFILL_DAYS} 天内的记录。"
        return None

    @staticmethod
    def _parse_mins(raw) -> int | None:
        if raw is None or raw == "":
            return None
        digits = re.sub(r"\D", "", str(raw))
        if not digits:
            return None
        return max(1, min(600, int(digits)))

    @staticmethod
    def _parse_effort(raw) -> str | None:
        return canonical_effort(raw)

    @staticmethod
    def _canonical_item(raw) -> str:
        """把口语项目名归一到 App 内置项目；认不出的保留原词。"""
        return canonical_item(raw, st.clean_tag)

    @classmethod
    def _build_items(cls, items_raw: str, item: str, mins, effort) -> list[dict] | None:
        """把「跑步 20；拉伸 15」这类串解析成 items 数组。

        支持分隔符：分号、逗号、顿号、加号、换行。
        每段内部允许「名称 20」「名称20」「名称 20分钟」。
        """
        text = (items_raw or "").strip()
        if not text:
            if not item:
                return None
            entry = {"name": self._canonical_item(item)}
            if mins is not None:
                entry["mins"] = mins
            if effort:
                entry["effort"] = effort
            return [entry] if entry.get("name") else None

        parts = re.split(r"[;；,，、+\n]+", text)
        out = []
        for part in parts:
            part = part.strip()
            if not part:
                continue
            m = re.fullmatch(r"(.+?)\s*(\d{1,3})\s*(?:分钟|分钟|min|分钟)?", part)
            if m and m.group(1).strip():
                name = self._canonical_item(m.group(1))
                minutes = max(1, min(600, int(m.group(2))))
                if name:
                    out.append({"name": name, "mins": minutes})
            else:
                name = self._canonical_item(part)
                if name:
                    out.append({"name": name})
            if len(out) >= 12:
                break
        return out or None

    # ---------- LLM 工具 ----------

    @filter.llm_tool(name="fitness_checkin")
    async def fitness_checkin_tool(
        self,
        event: AstrMessageEvent,
        item: str = "",
        items: str = "",
        date_hint: str = "",
        mins: str = "",
        effort: str = "",
        mode: str = "auto",
    ):
        """记录一次健身打卡到日历（支持今天、补录历史、多个训练项目）。

        什么时候用：用户说「今天练了腿」「昨天跑步 30 分钟」「补一下前天」「今天跑步20分钟加拉伸15分钟」等。
        注意：执行前不需要反复确认，用户明确表达了练过什么就直接记录。

        Args:
            item(string): 单个训练项目名称，例如「力量训练」「跑步机」「腿」；用户只说了动作类型就填这个。
            items(string): 多个项目时使用，写成「跑步 20；拉伸 15」这样的串，每段是项目名加可选分钟数。只有一个项目时留空。
            date_hint(string): 日期。可以填「今天」「昨天」「前天」或 2026-10-28、10-28。用户没提日期就留空（默认今天）。
            mins(string): 时长分钟数，纯数字。用户没说就留空。
            effort(string): 辛苦程度，可选 easy/normal/hard/drained/maxed 或 轻松/适中/吃力/脱力/力竭。用户没说就留空。
            mode(string): 写入方式。用户说「又练了」「再加一个」这类补充时填 append（累加到当天已有记录）；
                说「记错了」「其实是」「改成」这类修正时填 replace（整体替换当天）；
                拿不准留空 auto（当天已有记录时按追加处理，避免误删）。
        """
        if not self._allow_tools():
            yield event.plain_result("健身相关功能现在是关闭的。")
            return

        day = self._parse_day(date_hint)
        if not day:
            yield event.plain_result("日期我没看懂，可以说「今天」「昨天」或者 2026-10-28。")
            return
        err = self._guard_day(day)
        if err:
            yield event.plain_result(err)
            return

        minutes = self._parse_mins(mins)
        clean_effort = self._parse_effort(effort)
        item_list = self._build_items(items, item, minutes, clean_effort)

        try:
            client = await self._ready_client()
            doc = await client.pull()

            # 用户只说「练了」「还是老样子」而没给项目名时，
            # 沿用最近一次的项目，而不是直接打回。这样一句话就能记完。
            if not item_list:
                last_items = _last_items(doc, today=date.today())
                if last_items:
                    item_list = last_items
                else:
                    yield event.plain_result(
                        "没听清练的是什么，能说一下项目名吗？比如力量训练、跑步机。"
                    )
                    return

            existed = st.mark_of(doc, day) is not None

            # auto：当天已有记录时走追加，避免用户随口补充一句就把整天数据冲掉。
            action = (mode or "auto").strip().lower()
            if action in ("replace", "覆盖", "修改", "更正"):
                data = await client.mark_day(day, items=item_list)
            elif action in ("append", "追加", "补充"):
                data = await client.append_day(day, item_list)
            else:
                data = (
                    await client.append_day(day, item_list)
                    if existed
                    else await client.mark_day(day, items=item_list)
                )
            entry = data.get("entry") or {}
            yield event.plain_result(render.render_marked(entry, day, existed))
        except FitnessError as exc:
            yield event.plain_result(f"没记上：{exc}")
        except Exception as exc:  # noqa: BLE001
            logger.error(f"健身插件打卡失败: {exc}", exc_info=True)
            yield event.plain_result("打卡出错了，稍后再试。")

    @filter.llm_tool(name="fitness_status")
    async def fitness_status_tool(self, event: AstrMessageEvent, range: str = "today"):
        """查询健身打卡情况，用来回答「我今天练了吗」「这周练了几次」「下次该练什么」「我的训练规律」。

        Args:
            range(string): 查询范围，可选：
                today（今天）/ week（本周明细）/ month（本月）/ recent（最近几次）/ stats（累计汇总）
                advice（下一步该练什么 + 与上周对比，用户问「我最近怎么样」「该练啥」时用）
                rhythm（训练规律，用户问「我一般周几练」时用）
                parts（近 28 天部位分布，用户问「哪里练得多/少」时用）
        """
        if not self._allow_tools():
            yield event.plain_result("健身相关功能现在是关闭的。")
            return

        today = date.today()
        key = (range or "today").strip().lower()
        try:
            client = await self._ready_client()
            doc = await client.pull()
            if key in ("week", "周", "本周"):
                text = render.render_week(doc, today)
            elif key in ("month", "月", "本月"):
                text = render.render_month(doc, today)
            elif key in ("recent", "最近"):
                text = render.render_recent(doc)
            elif key in ("stats", "统计", "汇总"):
                text = render.render_stats(doc, today)
            elif key in ("advice", "建议", "下一步", "plan"):
                # 「下一步该练什么」：把建议和周对比拼在一起，回答「我最近怎么样、该练啥」
                text = (
                    insight.suggestion(doc, today)
                    + "\n"
                    + insight.compare_weeks(doc, today)
                )
            elif key in ("rhythm", "规律", "习惯"):
                text = insight.rhythm(doc, today)
            elif key in ("parts", "部位", "分布"):
                parts = insight.part_stats(doc, days=28, today=today)
                if not parts["counts"]:
                    text = "最近 28 天还没有记录。"
                else:
                    rows = [
                        f"{name} {times} 次"
                        for name, times in sorted(parts["counts"].items(), key=lambda kv: -kv[1])
                    ]
                    neglected = insight.neglected_parts(doc, today)
                    text = "最近 28 天部位分布：" + "、".join(rows)
                    if neglected:
                        text += f"\n已经 10 天以上没练：{'、'.join(neglected)}"
            else:
                text = render.render_today(doc, today)
            yield event.plain_result(text)
        except FitnessError as exc:
            yield event.plain_result(f"读不到记录：{exc}")
        except Exception as exc:  # noqa: BLE001
            logger.error(f"健身插件查询失败: {exc}", exc_info=True)
            yield event.plain_result("查询出错了，稍后再试。")

    @filter.llm_tool(name="fitness_advice")
    async def fitness_advice_tool(self, event: AstrMessageEvent, focus: str = "next"):
        """给出健身建议：下次该练什么、哪个部位被冷落了、最近的训练节奏如何。

        什么时候用：用户问「下次练什么」「我最近怎么样」「练得均衡吗」「哪天练比较好」。
        这些建议基于真实打卡记录计算，数据不足时会明确说明，不要自己编造。

        Args:
            focus(string): 关注点，可选 next（下次练什么，默认）/ balance（部位是否均衡）/ rhythm（习惯周几练）/ compare（和上周比）。
        """
        if not self._allow_tools():
            yield event.plain_result("健身相关功能现在是关闭的。")
            return

        today = date.today()
        key = (focus or "next").strip().lower()
        try:
            client = await self._ready_client()
            doc = await client.pull()

            if not st.checked_keys(doc):
                yield event.plain_result("还没有打卡记录，先练一次我来帮你分析。")
                return

            if key in ("balance", "均衡", "部位"):
                stats = insight.part_stats(doc, today=today)
                if not stats["counts"]:
                    text = "最近 28 天没有记录，先练几次再看。"
                else:
                    parts = sorted(stats["counts"].items(), key=lambda kv: -kv[1])
                    detail = "、".join(f"{p}×{c}" for p, c in parts)
                    neglected = insight.neglected_parts(doc, today)
                    text = f"最近 28 天：{detail}。"
                    if neglected:
                        text += f"\n{'、'.join(neglected)} 已经 10 天以上没练。"
            elif key in ("rhythm", "节奏", "规律"):
                text = insight.rhythm(doc, today)
            elif key in ("compare", "对比", "上周"):
                text = insight.compare_weeks(doc, today)
            else:
                text = insight.suggestion(doc, today)

            yield event.plain_result(text)
        except FitnessError as exc:
            yield event.plain_result(f"拿不到数据：{exc}")
        except Exception as exc:  # noqa: BLE001
            logger.error(f"健身插件建议失败: {exc}", exc_info=True)
            yield event.plain_result("分析出错了，稍后再试。")

    @filter.llm_tool(name="fitness_uncheck")
    async def fitness_uncheck_tool(self, event: AstrMessageEvent, date_hint: str = ""):
        """取消某一天的健身打卡（用户说「删掉今天的打卡」「昨天记错了取消一下」时用）。

        Args:
            date_hint(string): 要取消的日期，可以填「今天」「昨天」或 2026-10-28。留空表示今天。
        """
        if not self._allow_tools():
            yield event.plain_result("健身相关功能现在是关闭的。")
            return

        day = self._parse_day(date_hint)
        if not day:
            yield event.plain_result("日期我没看懂，可以说「今天」「昨天」或者 2026-10-28。")
            return
        err = self._guard_day(day)
        if err:
            yield event.plain_result(err)
            return

        try:
            client = await self._ready_client()
            await client.unmark_day(day)
            yield event.plain_result(f"{day} 的打卡取消了。")
        except FitnessError as exc:
            yield event.plain_result(f"没取消失：{exc}")
        except Exception as exc:  # noqa: BLE001
            logger.error(f"健身插件取消打卡失败: {exc}", exc_info=True)
            yield event.plain_result("取消失败，稍后再试。")


def _last_items(doc: dict, today: date, limit: int = 3) -> list[dict] | None:
    """取最近一次打卡的项目，作为「没说项目」时的兜底。"""
    keys = [k for k in st.checked_keys(doc) if st.parse_ymd(k) <= today]
    if not keys:
        return None
    mark = st.mark_of(doc, keys[-1])
    items = (mark or {}).get("items") or []
    out = []
    for it in items[:limit]:
        name = it.get("name")
        if not name:
            continue
        # 复用历史项目名时也要过一遍归一表，避免把早先的口语名（如「腿」）一直传下去
        entry = {"name": canonical_item(name, st.clean_tag)}
        if it.get("mins"):
            entry["mins"] = int(it["mins"])
        out.append(entry)
    return out or None
