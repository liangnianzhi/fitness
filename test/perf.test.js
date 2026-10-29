import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * 首屏性能约束。
 *
 * 打卡是每天打开一次的高频动作，首屏越轻越好。
 * 这里把「不许把重资源塞回首屏」钉死，避免以后又加回去。
 */

const here = dirname(fileURLToPath(import.meta.url))
const html = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8')
const appjs = readFileSync(join(here, '..', 'public', 'app.js'), 'utf8')

test('index.html 不静态引入 page-agent CDN', () => {
  assert.ok(
    !/cdn\.jsdelivr\.net|npmmirror\.com/.test(html),
    'CDN 脚本应由 app.js 懒加载，不要写进 HTML'
  )
})

test('index.html 只保留一个 script 标签（app.js）', () => {
  const tags = html.match(/<script/g) || []
  assert.equal(tags.length, 1, '首屏只应有 app.js 一个脚本')
})

test('首屏不做 page-agent 预热', () => {
  assert.ok(
    !/setTimeout\(loadPageAgent/.test(appjs),
    '预热会让每次打开都拉一次 100KB+ 的 CDN，国内还常拉不动'
  )
})

test('app.js 保留镜像回退，CDN 挂了也能用', () => {
  assert.match(appjs, /PAGEAGENT_MIRROR/, '必须保留 npmmirror 回退')
})

test('加载失败时不阻塞页面其余功能', () => {
  // loadPageAgent 失败应 resolve(false)，而不是 reject 出去炸掉调用方
  assert.match(appjs, /ai\.failed = true\s*\n\s*resolve\(false\)/)
})
