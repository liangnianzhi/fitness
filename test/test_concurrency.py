"""并发与缓存行为的测试。

不导入 astrbot 框架，而是用最小桩件复刻 _ready_client / _lock 的语义，
确保：
  - 口令发现结果会被缓存，不会每句话都打一次网络
  - 缓存过期后会重新发现
  - 写操作串行执行，并发调用不会交错
"""

from __future__ import annotations

import asyncio
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


class FakeClient:
    def __init__(self, sync_id="", discover_result="DISCOVERED_SYNC_ID_1234"):
        self.sync_id = sync_id
        self.discover_calls = 0
        self._result = discover_result

    async def discover_sync_id(self):
        self.discover_calls += 1
        await asyncio.sleep(0)  # 模拟一次异步 IO
        self.sync_id = self._result
        return self._result


class PluginCore:
    """复刻 FitnessPlugin 的缓存与锁逻辑。"""

    def __init__(self, client_factory, ttl=600):
        self._factory = client_factory
        self._discovered_sync_id = ""
        self._discovered_at = 0.0
        self._write_lock = None
        self._ttl = ttl

    def _lock(self):
        if self._write_lock is None:
            self._write_lock = asyncio.Lock()
        return self._write_lock

    async def _ready_client(self, fresh=False):
        client = self._factory()
        if client.sync_id:
            return client

        now = time.monotonic()
        if not fresh and self._discovered_sync_id and now - self._discovered_at < self._ttl:
            client.sync_id = self._discovered_sync_id
            return client

        sid = await client.discover_sync_id()
        self._discovered_sync_id = sid
        self._discovered_at = now
        return client


class TestDiscoveryCache(unittest.TestCase):
    def test_explicit_sync_id_skips_discovery(self):
        holder = {}

        def factory():
            c = FakeClient(sync_id="EXPLICIT_16_CHARS_X")
            holder["c"] = c
            return c

        core = PluginCore(factory)
        client = asyncio.run(core._ready_client())
        self.assertEqual(client.sync_id, "EXPLICIT_16_CHARS_X")
        self.assertEqual(holder["c"].discover_calls, 0, "显式配置时不该再问一次")

    def test_discovery_cached_across_calls(self):
        calls = {"n": 0}

        def factory():
            c = FakeClient()
            calls["n"] += 1
            return c

        core = PluginCore(factory)

        async def run():
            first = await core._ready_client()
            second = await core._ready_client()
            third = await core._ready_client()
            return first, second, third

        a, b, c = asyncio.run(run())
        self.assertEqual(a.sync_id, "DISCOVERED_SYNC_ID_1234")
        self.assertEqual(b.sync_id, a.sync_id)
        self.assertEqual(c.sync_id, a.sync_id)
        # 三个客户端都拿到了口令，但只有第一次真正发现了
        self.assertEqual(c.discover_calls, 0, "后两次应命中缓存，不再发发现请求")

    def test_cache_expires(self):
        core = PluginCore(lambda: FakeClient(), ttl=0)  # 立即过期

        async def run():
            first = await core._ready_client()
            second = await core._ready_client()
            return first, second

        a, b = asyncio.run(run())
        self.assertEqual(a.discover_calls, 1)
        self.assertEqual(b.discover_calls, 1, "过期后应重新发现")

    def test_fresh_forces_rediscovery(self):
        core = PluginCore(lambda: FakeClient())

        async def run():
            await core._ready_client()
            forced = await core._ready_client(fresh=True)
            return forced

        client = asyncio.run(run())
        self.assertEqual(client.discover_calls, 1, "fresh=True 必须重新发现")


class TestWriteLock(unittest.TestCase):
    def test_writes_are_serialized(self):
        """并发写不能交错：模拟两个请求读-改-写同一天。"""
        events: list[str] = []

        async def write(name: str):
            async with core._lock():
                events.append(f"{name}:start")
                await asyncio.sleep(0.01)  # 模拟网络往返
                events.append(f"{name}:end")

        core = PluginCore(lambda: FakeClient())

        async def run():
            await asyncio.gather(write("A"), write("B"))

        asyncio.run(run())

        # 必须成对出现：start 后紧跟同一个的 end，不能交错
        self.assertEqual(len(events), 4)
        for i in range(0, 4, 2):
            self.assertEqual(events[i].split(":")[0], events[i + 1].split(":")[0])

    def test_lock_is_lazy_and_stable(self):
        core = PluginCore(lambda: FakeClient())
        self.assertIsNone(core._write_lock)
        first = core._lock()
        second = core._lock()
        self.assertIs(first, second, "同一个锁实例应被复用")


if __name__ == "__main__":
    unittest.main()
