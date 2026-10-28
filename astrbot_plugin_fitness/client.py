"""client.py — 调用健身 Worker 的极薄客户端。

只做三件事：GET 状态、POST /mark 单日打卡、POST /merge 合并。
业务规则一律交给 Worker，这里不重算任何派生值。
"""

from __future__ import annotations

import asyncio
import json
import re
import urllib.error
import urllib.request

SYNC_ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
_UA = "AstrBot-Fitness/1.0 (+https://github.com/liangnianzhi/fitness)"


class FitnessError(Exception):
    """可读的失败原因，直接展示给用户。"""


class FitnessClient:
    def __init__(self, base_url: str, sync_id: str, timeout: int = 15):
        self.base_url = (base_url or "").rstrip("/")
        self.sync_id = (sync_id or "").strip()
        self.timeout = timeout

    # ---------- 校验 ----------

    def ensure_ready(self):
        if not self.base_url.startswith("http"):
            raise FitnessError("还没配置 Worker 地址，请在插件配置里填 worker_url")
        if not self.sync_id:
            raise FitnessError("还没拿到同步口令，先在 App 里打卡一次即可自动登记")
        if not SYNC_ID_RE.match(self.sync_id):
            raise FitnessError("同步口令格式不对（应为 16–64 位字母、数字、- 或 _）")

    @property
    def _active_url(self) -> str:
        return f"{self.base_url}/api/active"

    async def discover_sync_id(self) -> str:
        """零配置拿到同步口令。

        顺序：显式配置 -> Worker 的 /api/active 索引 -> 扫描 KV 里唯一的 state:* 键。
        目的是让用户不用手动抄口令，插件装好就能用。
        """
        if self.sync_id:
            return self.sync_id

        # 1) 优先问 Worker 的索引（它知道当前活跃口令）
        try:
            req = urllib.request.Request(
                self._active_url,
                headers={
                    "Accept": "application/json",
                    "User-Agent": _UA,
                },
            )
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                data = json.loads(resp.read().decode("utf-8", "replace"))
            sid = (data or {}).get("syncId") or ""
            if SYNC_ID_RE.match(sid):
                self.sync_id = sid
                return sid
        except Exception:
            pass

        raise FitnessError(
            "找不到同步口令。请在 App 里打卡一次（会自动登记），"
            "或在插件配置的 sync_id 里手动填写"
        )

    @property
    def _state_url(self) -> str:
        return f"{self.base_url}/api/state/{self.sync_id}"

    # ---------- HTTP ----------

    async def _request(self, method: str, url: str, payload=None) -> dict:
        """在事件循环里用线程池跑阻塞请求。

        为什么不用 aiohttp：不同部署环境的代理/DNS 行为差异很大，
        urllib 在中转代理与直连下都更稳；这里只做几个轻量 JSON 请求，
        线程池开销可以忽略。
        """
        return await asyncio.get_running_loop().run_in_executor(
            None, self._request_sync, method, url, payload
        )

    def _request_sync(self, method: str, url: str, payload) -> dict:
        body = None
        headers = {
            "Accept": "application/json",
            # Cloudflare 会拦掉 urllib 默认 UA（返回 403），必须带一个正常 UA
            "User-Agent": _UA,
        }
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                text = resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            text = exc.read().decode("utf-8", "replace") if exc.fp else ""
            if exc.code == 501:
                raise FitnessError("这个 Worker 没有绑定 KV 存储，云端同步不可用") from exc
            if exc.code == 400:
                raise FitnessError(_short_error(text, "请求被拒绝，检查数据格式")) from exc
            if exc.code >= 500:
                raise FitnessError(f"Worker 出错了（HTTP {exc.code}），稍后再试") from exc
            raise FitnessError(_short_error(text, f"请求失败（HTTP {exc.code}）")) from exc
        except urllib.error.URLError as exc:
            raise FitnessError(f"连不上 Worker：{exc.reason}，检查地址和网络") from exc
        except TimeoutError as exc:
            raise FitnessError(f"请求超时（{self.timeout} 秒）") from exc

        try:
            return json.loads(text)
        except ValueError as exc:
            raise FitnessError("Worker 返回的不是 JSON，检查地址是否填错") from exc

    # ---------- 对外方法 ----------

    async def pull(self) -> dict:
        """取回云端文档；没有任何记录时返回空骨架。"""
        self.ensure_ready()
        data = await self._request("GET", self._state_url)
        doc = data.get("doc")
        if not isinstance(doc, dict):
            return {"version": 1, "marks": {}, "unmarks": {}, "settings": {}, "meta": {}}
        return doc

    async def mark_day(self, day: str, *, name=None, mins=None, effort=None, items=None) -> dict:
        """单日打卡 / 改档。读-改-写全程在 Worker 完成，不会覆盖别的天。"""
        self.ensure_ready()
        payload = {"action": "mark", "day": day}
        if items:
            payload["items"] = items
        if name:
            payload["name"] = name
        if mins is not None:
            payload["mins"] = mins
        if effort:
            payload["effort"] = effort
        return await self._request("POST", f"{self._state_url}/mark", payload)

    async def append_day(self, day: str, items: list[dict]) -> dict:
        """在当天已有日程上追加项目（同名自动合并时长），用于「又练了…」这类补充。

        与 mark_day 的区别：mark_day 是整体替换（改档），append_day 是累加。
        """
        self.ensure_ready()
        return await self._request(
            "POST", f"{self._state_url}/mark", {"action": "append", "day": day, "items": items}
        )

    async def unmark_day(self, day: str) -> dict:
        """取消某天的打卡。"""
        self.ensure_ready()
        return await self._request(
            "POST", f"{self._state_url}/mark", {"action": "unmark", "day": day}
        )

    async def merge(self, doc: dict) -> dict:
        """整份文档交给服务端按天合并（用于设置类改动）。"""
        self.ensure_ready()
        return await self._request("POST", f"{self._state_url}/merge", doc)


def _short_error(text: str, fallback: str) -> str:
    """从 Worker 的错误 JSON 里取出人话，取不到就用兜底文案。"""
    try:
        import json

        obj = json.loads(text)
        if isinstance(obj, dict) and obj.get("error"):
            return str(obj["error"])[:120]
    except Exception:
        pass
    return fallback
