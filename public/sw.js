/**
 * sw.js — 让打卡 App 在断网时也能打开。
 *
 * 策略（刻意做得很简单，因为打卡页会频繁小改，缓存策略越复杂越容易出「改了没生效」）：
 *   - 静态资源（HTML/JS/CSS/图标）：网络优先，失败时回退到缓存。
 *     这样联网时永远拿到最新代码，断网时用上次成功的副本。
 *   - /api/*：完全不缓存，直接放行。打卡数据必须实时，缓存会造成多端不一致。
 *   - 其它请求：直接放行。
 *
 * 为什么不用「缓存优先」：这个项目改版频繁，缓存优先会让用户长期停在旧版本，
 * 出了 bug 也修不掉，是最常见的 PWA 事故来源。
 */

const CACHE = 'fitcal-v1'

// 预缓存这几个就够首屏用，其余在首次访问时顺带缓存
const PRECACHE = [
  '/',
  '/index.html',
  '/app.js',
  '/store.js',
  '/analysis.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/icons/icon.svg',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      // 单个文件失败不能拖垮整个安装流程
      await Promise.allSettled(PRECACHE.map((url) => cache.add(url)))
      await self.skipWaiting()
    })()
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      await self.clients.claim()
    })()
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event

  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // 只处理同源请求；API 与跨域（page-agent CDN）一律放行
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return

  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(request)
        // 只缓存成功的响应，避免把 404/500 存进去
        if (fresh && fresh.ok && fresh.type === 'basic') {
          const cache = await caches.open(CACHE)
          cache.put(request, fresh.clone())
        }
        return fresh
      } catch {
        const cached = await caches.match(request)
        if (cached) return cached
        // 页面导航失败时退回首页，至少能打开界面（数据在本机）
        if (request.mode === 'navigate') {
          const shell = await caches.match('/index.html')
          if (shell) return shell
        }
        return new Response('离线，且这一页还没缓存过。', {
          status: 503,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        })
      }
    })()
  )
})
