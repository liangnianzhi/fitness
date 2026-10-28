# 健身打卡日历

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/liangnianzhi/fitness)

点上面的按钮，整套应用会部署到你自己的 Cloudflare 账号，不用装任何东西。

浏览器会跳到 Cloudflare 的配置页，确认仓库名和 Worker 名后点 Deploy。Cloudflare 会自动完成三件事：把源码复制到你自己的 GitHub 账号下（之后可以继续改）、创建打卡记录用的 KV 命名空间并回填 id、构建并发布到 `https://fitness.你的子域.workers.dev`。

部署完用 iPhone Safari 打开这个地址，点分享，选 添加到主屏幕，就是一个全屏的打卡 App。想换名字或绑自定义域名，都在 Cloudflare 控制台的 Worker 详情页里改。

---

## 这是什么

一个苹果风格、可编辑的健身打卡日历：周、月、年三种视图，左右滑动或上下翻页，点一天就能打卡并给出「2026/10/17 健身打卡成功」这样的明确反馈。

记录长期保存在本地，并通过 KV 跨设备同步，同时接入 [alibaba/page-agent](https://github.com/alibaba/page-agent) 生成每周和每月的第一次打开时的频次分析：上周练够了吗、是不是偷懒、接下来该怎么安排。

纯静态页面加一个轻量 Worker，没有任何构建步骤。

---

## 功能

- 苹果端审美：系统字体（SF Pro 与 PingFang SC）、iOS 分组卡片、Segmented Control、8pt 间距、单强调色、只用透明度表达层级、深色模式、安全区适配刘海与小横条。
- 点击某天即打卡：点任意一天即切换勾选状态，Toast 提示 `2026/10/17 健身打卡成功`；取消打卡可在 Toast 里撤销。
- 日历下方立即打卡：主按钮跟随当前选中日期，选中的是今天时显示「立即打卡」，改天则为「为这天打卡」。
- 周、月、年切换：顶部 Segmented Control；左右滑动翻上或下一个周期，上下滑动也可翻页；年视图点某个月直达该月。
- 历史记录不丢失：localStorage 为主存储，KV 云端备份自动双向同步，支持 JSON 导出与导入（导入是合并不是覆盖）。
- 编辑打卡：长按某天打开编辑抽屉，可改训练项目与时长，或删除该天记录。
- 周、月分析：每周、每月的第一次打开自动展示「上周回顾」或「上月回顾」，带达标徽标、事实标签和下一步计划。
- 一天多项目：一次健身可勾选多个训练项目，**每个项目单独设置时长**，总时长自动汇总。
- 辛苦程度：轻松、适中、吃力、脱力、力竭五档，按强度着色；一天有多个项目时自动取最高档。
- 自定义项目：「其他」里输入名字即可**固定成新标签**，之后一直可选，并记住它上次用的时长。
- 长按编辑：日历上任意一天、或「最近打卡」里的任意一条，长按都能编辑；编辑界面已禁用文字选择，不会误触「拷贝/查询」。
- 年视图点某个月直接跳到该月。
- 另外还有：连续打卡天数、本周还差几次、年视图每月密度点阵、最近 5 次打卡、触感反馈（iOS 上生效）。

---

## 用聊天记录健身（AstrBot 插件）

仓库里的 `astrbot_plugin_fitness/` 是一个 AstrBot 插件，把这份日历接进聊天。
**不用任何斜杠命令，直接说人话就行。**

| 你说 | 效果 |
| --- | --- |
| 今天练了腿，45 分钟，挺累的 | 记成 力量训练 / 45′ / 吃力 |
| 昨天跑步 30 分钟 | 补录到昨天 |
| 前天跑步20分钟加拉伸15分钟 | 一次记两个项目，自动汇总 |
| 我今天练了吗 | 今天状态 + 本周进度 + 连续天数 |
| 这周练了几次 | 本周明细，逐天打勾 |
| 今天记错了，取消一下 | 撤销今天的打卡 |

### 三个设计要点

1. **业务逻辑不搬进插件。** 打卡规则、多端合并、时长派生全部留在 `store.js` / `worker.js`，
   插件只做「取文档 → 调接口」，手机和机器人永远同一套口径。
2. **写操作走 `POST /api/state/:id/mark`。** 由 Worker 在服务端完成读-改-写，
   所以机器人打卡不会覆盖别的日期，也不会被手机端正在打开的页面 push 顶掉。
   为此 Worker 新增了 `/mark`、`/merge` 与 `/api/active` 三个端点。
3. **口令零配置。** Worker 每次写入会把口令登记到 KV 的 `meta:active`，
   插件读 `GET /api/active` 即可拿到，不用手抄那串 22 位口令。

### 安装

把 `astrbot_plugin_fitness/` 整个目录放进 AstrBot 的 `data/plugins/`，重启后启用即可。
配置项只有 `worker_url`（已预填）和可选的 `sync_id`。

### 口语归一

说「练腿」「撸铁」「深蹲」都会归到内置的 **力量训练**，「慢跑」「快走」归到 **跑步机**，
避免日历上冒出一堆同义标签把统计拆散。认不出的词（比如「打球」）保留原样，当作自定义项目。

### 测试

```bash
npm test          # Worker / 前端 60 个用例
npm run test:py   # 插件纯逻辑 14 个用例
npm run test:all  # 全部
```

---

## 关于每周、每月分析（重点）

先说结论：能实现，而且不需要额外后端，但要用对 page-agent 的定位。

- page-agent 是页内 GUI Agent，用法是 `new PageAgent({model, baseURL, apiKey})` 然后 `agent.execute(...)`，它靠读页面 DOM 的文本结构去决策。
- 让它分析健身数据这件事，统计本身必须由本地代码算好，这是唯一能保证数字不出错的方式。page-agent 负责把结论读出来，重写成 1 到 2 句人话并给出下一步计划。
- 把 LLM 当数据库去自由发挥是错的，模型会编造次数。所以本项目里数字 100% 来自本地计算，模型只负责表达。

因此即使 page-agent 脚本加载失败、没有 API Key、或者断网，卡片里永远有一份可用的本地分析，不会出现空白或报错。

调用链路是：页面加载后判断本周期是否已弹过，用本地纯函数算出次数、目标、环比和文案并立刻渲染，然后在首次调用前弹一次原生授权确认，再构造 PageAgent 执行提示词，最后把结果覆盖到卡片正文，失败就保留本地文案。

## 接入方式（官方一行 script）

index.html 里就是 page-agent 官方 README 给出的接入形式，只加了几个参数：

    <script
      src="https://cdn.jsdelivr.net/npm/page-agent@1.12.4/dist/iife/page-agent.demo.js?autoInit=false&showPanel=false&lang=zh-CN"
      crossorigin="anonymous"
      defer
    ></script>

- autoInit=false：只要库，不要它自动创建的 demo agent，我们自己 new PageAgent 才能传教练指令。
- showPanel=false：默认不弹面板，不遮挡日历，真正分析时才 show，结束自动收起。
- lang=zh-CN：面板中文。
- 国内访问 jsDelivr 不稳时，app.js 会自动回退到官方给的 npmmirror 镜像。

模型可以在页面里「AI 分析」抽屉中填自己的，任何 OpenAI 兼容接口都行，例如 DashScope 的兼容模式地址配 qwen3.5-plus。留空则用 page-agent 官方的免费测试模型，仅用于技术评估。

## 第一次打开是怎么判断的

用 sessionStorage 记录本周和本月的回顾已经弹过，而不是拿 lastWeeklySeen 当开关。因为只要有一个分支忘了写标记，用户就再也看不到回顾，这是「新的一周不弹分析」最常见的成因。

现在的行为：同一天反复刷新不会重复弹；跨周或跨月后的第一次打开一定弹；24 小时后允许再提醒一次。新用户（总打卡少于 3 次且上周为 0）不会弹回顾，避免第一天打开就被说教。

---

## 国内访问不了怎么办

`*.workers.dev` 在国内需要代理才能稳定打开，这是 Cloudflare 域名的问题，不是本项目的问题。
按推荐程度从高到低：

### 方案一：给 Worker 绑一个自己的域名（最稳、最省事）

Cloudflare Workers 支持 **Custom Domain**，把自有域名解析到 Cloudflare 后：

1. Cloudflare 控制台 → 你的 Worker → Settings → Domains & Routes → Add → Custom Domain
2. 填一个自己的子域名（例如 `fit.example.com`），Cloudflare 会自动配置 DNS 和证书

之后访问 `https://fit.example.com` 就能**直连**。原因是 `workers.dev` 这个域名在国内被干扰，而你自己的域名没有这个问题，流量仍然走 Cloudflare 全球网络。这是目前国内用 CF Workers 最普遍的做法，比换平台更省事。

> 需要一个自己的域名（阿里云/腾讯云几十元一年都可以）。如果域名也托管在 Cloudflare，直接加 Custom Domain 即可。

### 方案二：继续用 workers.dev，但走 Cloudflare 优选 IP

用 [CloudflareSpeedTest](https://github.com/XIU2/CloudflareSpeedTest) 这类工具测出当前可用的 CF 边缘 IP，然后把 `fitness.你的子域.workers.dev` 通过本地 hosts 文件指向优选 IP。
**缺点**：只对你自己那台设备有效，换网络或 IP 变化就要重测，不适合分享给别人。

### 方案三：换平台

本项目是**零构建的纯静态站点 + 一个很小的 Worker**，迁移成本很低：

| 平台 | 国内可访问性 | 迁移难度 | 说明 |
| --- | --- | --- | --- |
| **Vercel** | 一般，`*.vercel.app` 时常被墙 | 中 | 静态部分直接可用；`/api/*` 要改写成 `api/` 下的 Serverless Function |
| **Netlify** | 一般，`*.netlify.app` 同样不稳 | 中 | 用 `netlify/functions` 替代 Worker |
| **GitHub Pages** | 时好时坏 | 低 | 只能放静态资源，KV 同步和 `/api` 用不了（打卡记录退回纯本机存储） |
| **国内对象存储 + CDN**（阿里云 OSS / 腾讯云 COS + 又拍云等） | 好 | 低 | 静态部分几块钱一个月；同样没有服务端，同步功能不可用 |
| **Zeabur / Railway** | 一般 | 中 | 支持 Node 服务，可整套搬过去 |

需要重点说明的是：**跨设备同步依赖 Cloudflare KV**，换到没有对应存储的平台就得自己接一个数据库（Supabase、Upstash、MongoDB 均可）。
如果只是自己一台手机用，完全不需要同步，直接把 `public/` 目录丢到任意静态托管即可，打卡记录存在浏览器本机。

### 我的建议

先用**方案一**：绑一个自己的域名，一次配置长期有效，功能（含 KV 同步与 AI 分析）全都不用改。
实在不想买域名，再考虑方案三里的国内对象存储（但会失去同步功能）。

---

## 数据与隐私

- 打卡记录默认存在浏览器本机（localStorage，键 fitcal.state.v1），同时同步到你自己账号下的 KV。
- 同步口令同时是访问凭证（22 位随机串），可在 App 内「设置 → 数据」生成与复制，请当作密码保管。云端只存打卡日期、项目、时长与目标设置。
- iOS Safari 的 ITP 会在连续 7 天未与页面交互后清理脚本可写存储；有了 KV 同步就不怕，也可以随时导出记录备份。
- 开启 AI 分析时，第一次会弹原生确认，明确告知只发送打卡次数、目标、时长这些统计数字，不发送任何个人信息。确认后 7 天内不再询问。
- 设置里可以关闭「首次打开自动分析」。

---

## 目录

- public/index.html：页面骨架，含 page-agent 一行接入
- public/styles.css：iOS 风格视觉与深色模式
- public/app.js：渲染、手势、打卡交互、page-agent 调用
- public/analysis.js：纯逻辑，日期、ISO 周、统计、教练文案，可单测
- public/store.js：状态、多设备合并、本地持久化、同步客户端
- public/manifest.webmanifest：PWA 清单
- public/icons：矢量图标 icon、icon-maskable、apple-touch-icon
- src/worker.js：Worker，静态资源加 /api/config 与 /api/state/:id
- test：node --test 单测，覆盖 analysis、store、worker、edge、items
- astrbot_plugin_fitness：AstrBot 插件，自然对话打卡与查询
- wrangler.jsonc：Cloudflare 配置
- package.json

## 设计上的几个取舍

1. 日期一律用本地时区的年月日，不用 UTC 毫秒做跨日判断，否则东八区会出现跨日错位。
2. 一周从周一开始，ISO-8601 周序号，跨年周以周四所在年份为准。
3. 已打卡等于打卡时间戳晚于取消打卡时间戳，两台设备合并时就是干净的 last-write-wins，不需要复杂的冲突解决。
4. 渲染用原生 DOM，没有引入运行时框架，首屏只有三个小文件，零构建。
5. 图标用 SVG，是文本，在仓库里可读可改，也避免二进制资源在同步时丢失。

---

## License

MIT
