import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Service Worker 的策略检查。
 *
 * 不启动真实 SW 运行环境（Node 没有），而是静态检查关键约束。
 * 这些约束一旦破坏，后果是「打卡数据在多端不一致」或「用户永远停在旧版本」，
 * 都属于上线后极难排查的类型，所以值得用测试钉住。
 */

const here = dirname(fileURLToPath(import.meta.url))
const swSource = readFileSync(join(here, '..', 'public', 'sw.js'), 'utf8')

test('SW 不缓存 /api/ 请求', () => {
  assert.match(
    swSource,
    /url\.pathname\.startsWith\('\/api\/'\)/,
    '必须显式跳过 /api/ 路径'
  )
  assert.match(swSource, /return\s*$/m, '命中 /api/ 时应直接返回，走浏览器默认网络请求')
})

test('SW 只处理 GET 请求', () => {
  assert.match(swSource, /request\.method !== 'GET'/)
})

test('SW 放行跨域请求（page-agent CDN）', () => {
  assert.match(swSource, /url\.origin !== self\.location\.origin/)
})

test('SW 用网络优先，而不是缓存优先', () => {
  // 缓存优先会让用户长期停在旧版本，出了 bug 也修不掉
  const fetchBlock = swSource.slice(swSource.indexOf("self.addEventListener('fetch'"))
  const tryIndex = fetchBlock.indexOf('await fetch(request)')
  const cacheIndex = fetchBlock.indexOf('caches.match(request)')
  assert.ok(tryIndex > -1, '必须尝试网络请求')
  assert.ok(cacheIndex > -1, '必须有缓存回退')
  assert.ok(tryIndex < cacheIndex, '网络请求要在缓存回退之前（网络优先）')
})

test('SW 只缓存成功的响应', () => {
  assert.match(swSource, /fresh\.ok/, '不能缓存 404/500')
})

test('SW 在激活时清理旧版本缓存', () => {
  assert.match(swSource, /caches\.delete/, '升级时要清掉旧缓存，否则磁盘会越积越多')
})

test('预缓存列表包含首屏必需的资源', () => {
  for (const f of ['/index.html', '/app.js', '/store.js', '/analysis.js', '/styles.css']) {
    assert.ok(swSource.includes(f), `预缓存应包含 ${f}`)
  }
})

test('预缓存允许单个文件失败，不阻塞安装', () => {
  assert.match(swSource, /allSettled/, '用 allSettled 而不是 all，避免一个 404 拖垮整个安装')
})
