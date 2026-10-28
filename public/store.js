/** Worker 同步客户端；注入 fetch 便于测试 */
export function createSync(fetchImpl, basePath = '/api') {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis)
  const client = {
    async pull(syncId) {
      const res = await doFetch(`${basePath}/state/${encodeURIComponent(syncId)}`, {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) throw new Error(`pull failed: ${res.status}`)
      const data = await res.json()
      return data && data.doc ? normalizeState(data.doc) : null
    },
    async push(syncId, state) {
      const res = await doFetch(`${basePath}/state/${encodeURIComponent(syncId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: serialize(state),
      })
      if (!res.ok) throw new Error(`push failed: ${res.status}`)
      return true
    },
    /**
     * 安全推送：先让服务端按天合并再返回最终文档。
     * 机器人或其他设备在我们开着页面时写入的打卡，不会被这次推送覆盖。
     * 老版本 Worker 没有 /merge 时退回普通 push，保证不炸。
     */
    async merge(syncId, state) {
      const res = await doFetch(`${basePath}/state/${encodeURIComponent(syncId)}/merge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: serialize(state),
      })
      if (res.status === 404 || res.status === 405) return client.push(syncId, state)
      if (!res.ok) throw new Error(`merge failed: ${res.status}`)
      const data = await res.json()
      return data && data.doc ? normalizeState(data.doc) : true
    },
    async config() {
      try {
        const res = await doFetch(`${basePath}/config`, { headers: { accept: 'application/json' } })
        if (!res.ok) return { store: false }
        return await res.json()
      } catch {
        return { store: false }
      }
    },
  }
  return client
}
