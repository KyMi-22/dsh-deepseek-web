# 设计说明

面向想读代码或改代码的人。用户向的说明在 [README](../README.md)。

## 数据流

```
DSH 会话 ──► deepseek-web provider ──► chat.deepseek.com
   ▲                                        │
   │                                        ▼
   └──── 导入：读历史 ── 写种子会话 ◄── /api/v0/*
```

两个方向用的不是同一条链路：

- **继续对话**：DSH 把用户消息交给 provider，provider 调网页端 `chat/completion`，SSE 流回来翻译成 `StreamChunk`。网页端记得自己的历史，所以只发最新那句。
- **导入对话**：插件调 `chat/history_messages` 拉整个对话，转成 DSH 的种子事件，落成一个普通会话。

## 模块

| 文件 | 职责 |
|---|---|
| `index.js` | Host 入口：注册 provider、同步引擎、设置页路由、工具拦截 |
| `client.js` | 浏览器半边：设置页 |
| `src/api.js` | `/api/v0` 客户端：分页、历史、建会话、图片上传、SSE 解析、错误分类 |
| `src/adapter.js` | provider 适配：message → prompt，图片引用收集，SSE → `StreamChunk` |
| `src/sync.js` | 网页对话 → 种子会话；工作区；撤销 |
| `src/store.js` | 插件状态（token、绑定、账本），原子写入 |
| `src/pow.js` | `DeepSeekHashV1` 求解器 |
| `src/pow-async.js` | 求解放到 worker 线程，带进程内回退 |
| `src/pow-worker.js` | worker 入口 |
| `src/http.js` | 设置页路由用的 JSON / 请求体工具 |
| `src/tool-guard.js` | 网页版会话的工具白名单 |

## 为什么是「工作区」

侧边栏的 `sidebar.workspaces` 是单例槽位，带 `shadows-shipped-ui` 标记——往里注册会顶掉官方整个会话浏览区。DSH 自己的模型就是「工作区 → 会话」，所以一个名为「对话」的独立工作区既能拿到原生分组、折叠、搜索，又完全不碰官方 UI。

坑：**创建工作区不会自动收养目录里已有的会话**。成员关系是工作区上的显式记录，还要按会话存档的 `cwd` 校验。所以每轮同步都会把已导入的会话 `attachSession` 一遍（幂等），否则工作区是空的。

## 导入的会话必须「看起来像真会话」

种子日志不是随便写几条消息。DSH 的投影、标题、请求纪元都从这些事件推导，序列必须和真实循环一致：

```
turn/start → step/start → user/message → request/header → request/context
→ session/title → assistant/message → step/end → turn/end
```

- 缺 `step/start` / `step/end`：assistant 消息不在任何 step 内，内容渲染不出来
- 缺 `session/title`：侧边栏那一行没有标题
- 缺 `request/header` / `request/context`：resume 时不知道该用哪个 provider/model
- turn 与 step 都从 **1** 开始

会话 id 是**新生成的 UUID**，不是网页 id。两个身份分开后，归档一条旧残留永远不会遮蔽以后重新导入的同一个对话；而且 DSH 会校验会话 id，把网页 id 或它的装饰形式直接当 id 用会在创建时被拒。

## 导入的会话为什么能立刻看见

`agentLoop.createAgent` 是唯一会挂上会话日志写入器的创建路径，但写入带缓冲。创建完立刻 `dispose()`，可能在日志落盘前就释放了会话——而侧边栏渲染一行靠的是会话查询索引，它只看得见已持久化的会话。

所以创建之后、释放之前，插件会显式 `ctx.sessions.flush(session)` 把日志推下去。会话必须是 live 的才拿得到对象，dispose 之后就只剩缓冲里的写入。

## 撤销：先归档，再删文件

删掉会话文件**不会**把它从进程内的会话索引移除，侧边栏仍会列出它——只是不再属于任何工作区，于是掉进「未分组」，看起来像"撤销反而弄得更乱"。

归档是唯一能让运行时停止列出会话的受支持方式，而它要读会话存档的 header；文件一旦删掉这个调用就失败了。所以顺序只能是：先归档（文件还在），再删文件。

**按目录找，不只按账本找**。账本只跟踪"从网页拉过来的"对话。在 DSH 里新建、用网页版模型的对话也住在这个目录下，但账本里没有；只按账本撤销，它的 `cwd` 会指向已注销的目录，掉进「未分组」。所以撤销时用 `sessionQuery.filterSessions({kind:'cwd'})` 扫整个目录。

**来源用不可变字段记**。`bindings` 里有 `origin`（`imported` / `local`），写入后不改。不能用 `seeded` 判断来源——它在首轮回答完成后会被改成 `true`，含义是"已经聊过了"。

**来源不明就保留**。`origin` 之前写入的账本无法证明来源，按不可删除处理：删掉用户写的对话不可逆，留一个文件只是不整洁。

**归档失败也不删**。归档失败说明可能还在活动，此时删文件会把文件从运行中的会话底下抽走，也毁掉重试归档唯一需要的副本。

## 只发用户那句话

发给网页端的 prompt 只有用户最后输入的内容：不带 system prompt，不带历史轮次，也不带 harness 注入的记账消息。

DSH 每轮都会往 `messages` 里塞若干条 **user 角色** 的消息，靠 `source.kind` 区分：

| `source.kind` | 内容 |
|---|---|
| `user` | 真人输入（带 `rpcId`、`clientTimeZone`） |
| `runtime-context` | 环境块：工作目录、沙箱策略、团队身份、GUI URL |
| `time-context` | 时间和时区 |
| `skill-catalog` | 技能清单 |
| `user-approval` | 审批策略变更通知 |
| `subagent-settled` | 子代理结束通知 |

早期版本按文本开头匹配，结果 `time-context` 那段被当成真人输入发了出去，成了网页对话的开场白。现在以 `source.kind === 'user'` 为准，文本特征只作为 source 缺失时的兜底。

## 辅助调用不碰网页

DSH 除了主对话，还会发起两类辅助 LLM 调用：会话标题生成（`purpose: 'session-title'`）和历史压缩（`compaction`）。它们也走 `ctx.llm`，因此也会落到这个 provider 上。

转发到网页端的话，每个 DSH 会话都会在网页上多出「Session title generation」这种垃圾对话，还白花额度。所以适配器**在本地回答**这两类调用：标题取首条用户消息，压缩取各轮对话的截断摘要。

## 标题两边一致

网页端用自己的模型从首轮内容生成标题，中文提问常被翻成英文。所以首轮回答结束后，插件用 `update_title` 把网页会话改成和 DSH 一样的标题（取用户输入第一行，超 32 字截断）。网页端**拒绝给空会话改名**，所以这一步必然发生在回答之后。

之后在 DSH 里重命名，标题也会同步过去：订阅 `session/event`，只处理 `session/title`：

```js
ctx.on('session/event', (session, event) => {
  const planned = planTitlePush(event, session.id, (id) => store.binding(id));
  if (planned !== null) void api.renameSession(planned.chatSessionId, planned.title);
});
```

约束都是有意为之：以会话日志为准（事件带的就是侧边栏显示的标签）；只推有绑定的会话；种子事件不走 `session/event`，所以导入不会被当成改名；只写网页端不写回 DSH，不构成回路。

## 同步节奏

默认 5 分钟一次，每次在均值上下浮动 30%。

早期用 `setInterval` 每 60 秒刷一次。列表接口是只读的，不违规，但**固定节拍本身就是最强的机器特征**——真人不会按秒表刷列表。

`syncNow` 串行：第二次调用复用正在进行的那一次。两轮并发会各自读到「这个对话还没导入」的旧状态，各建一个 DSH 会话，正好是导入要避免的重复。

## PoW

网页端发消息要过 PoW 挑战。`DeepSeekHashV1` 是自定义 Keccak 变体：lane 的 32 位两半互换、23 轮、自定义 rho/pi 表——**不是**标准 SHA3-256。求解器照 worker 逐字移植。

求解是一秒量级的紧循环，跑在 Host 线程上会卡住所有其它会话，所以放进 worker 线程（`pow-async.js`），worker 不可用时回退到进程内并记一次告警。每次求解新建 worker：复用线程能省 30–50 ms 启动，但要回答"线程求解中途死了，排队的人怎么办"，半死的线程池比慢一点的开机更糟。

置换的 scratch 缓冲（`C`/`D`/`W`）**不做轮间清零**：theta 在读之前写满 `C` 和 `D`，rhoPi/chi 重写它们消费的内容，清零是纯开销。一次 solve 大约 15 万候选 × 23 轮 × 136 字节块，这是包里最热的循环。正确性由 `pow.test.mjs` 里钉住的真实挑战向量（服务端签发并已解出答案的那一条）保证——算法漂移会立刻被它抓住。

## 图片上传

带图消息在 completion 之前走三步：`readImage`（附件存储校验读取）→ `upload_file`（该端点单独解一次 PoW）→ 轮询 `fetch_files` 等解析离开 `PENDING`。上传拿到的是文件 id，随 `ref_file_ids` 进入 completion——与浏览器端的请求形状一致。

两个容易踩的坑：

- **附件引用必须原样传递**。`ImageBlock.attachment` 里的 `bytes/width/height` 不是装饰信息：本地附件存储读取时会重新探测存储对象，逐字段核对引用（`mediaType`、`bytes`、`width`、`height`），缺一个字段就是 `ATTACHMENT_CORRUPT`。0.2.0 曾把引用裁剪成 `{attachmentId, mediaType, name}`，导致每条带图消息在上传前就被拒。
- **解析未完成就发送会被拒**（HTTP 422），所以等到 `SUCCESS` 才继续；等待上限 60 秒，轮询间隔 1.2 秒。全部失败都发生在 completion 之前，整轮可以安全重试。

网页端对图片自行计量（上传响应带 `token_usage`），DSH 侧把保留出现的图片计为「模型可见、成本未知」（`imageRequestPricing` 返回 `visualTokens: 0`），不从像素估算。

## token

存在 `$DSH_HOME/deepseek-web/state.json`，目录 `0700`、文件 `0600`（POSIX），设置页只显示末四位。

也可以完全不落盘：

```powershell
$env:DEEPSEEK_WEB_TOKEN = '<token>'
```

环境变量优先级最高，此时 `state.json` 里的旧值被忽略，设置页保存会返回 409（避免"存了却不生效"的错觉）。

**「保证安全」做不到，只能限制影响范围**。风险从高到低：

1. **云同步**（最现实）：`~/.dsh` 落在 OneDrive / Dropbox / iCloud 同步目录里，token 会跟着上云。这是唯一值得主动检查的一条。
2. 同机其他用户：Windows 用户目录 ACL 已隔离，POSIX 靠 `0600`。
3. 本机恶意软件：任何本地凭证都挡不住，DPAPI 也一样（同一用户态可解）。

保护级别与浏览器保存的登录 cookie 相当。

**为什么不用 DSH 登录态或扫码自动获取**：DSH 的 `deepseekAccount` 管的是 **Platform**（platform.deepseek.com）的 OAuth grant，`resolveToken(url)` 限制为 inference origin；网页版是 `chat.deepseek.com`，不同 origin、不同凭证体系。同一个账号不代表同一个凭证。DSH 的 `startSignIn()` 授权的同样是 Platform，换不回网页版 token。改用 `credentials` 服务也不增加安全性——`.credentials.yaml` 同样是明文。

## 凭据提交边界

`state.token` 在保存期间是**候选值**，磁盘上是**已提交值**。两者必须分开：

- `flush()` 在**写入执行时**快照，不在调用时。调用时快照会把排队期间尚未被接受的候选 token 一起带上。
- 凭据保存进行中，普通后台写（绑定、账本行）只落盘 `committedToken`。否则保存失败回滚后，磁盘上仍留着被拒绝的凭证。
- 保存失败时回滚到 `committedToken`，不是"内存里刚才的值"——并发写可能已经把它推到更新的状态。
- 整个「设值 → 持久化 → 回滚」由一个队列串行。

## 重试标记

`error.submitted` 决定适配器是否释放去重标记（同一条用户消息不重复发）。

- **提交前的失败一律可重试**：无挑战、PoW 未解、连接失败。这些情况下模型什么都没看到。标记对任何抛出的值生效，不只是 `DeepSeekWebError`。
- **提交中/后的失败不可重试**：`fetch` 拒绝无法区分"请求没发出去"和"服务端收到了但响应丢了"，两种情况下 socket 都一样断。标为未确定，适配器不重试，避免一条提问得到两次回答。

代价是请求在途断开后需要手动重发。这是刻意的取舍。

## SSE 解析

逐行解析，不按 `\n\n` 切分：规范允许 CRLF，chunk 边界可能落在任何地方。早期按 `\n\n` 切分的版本会把两条 `\r\n\r\n` 分隔的记录合成一段无法解析的文本，退化成 `data: null`，整条回复丢失。

另外有 120 秒空闲守卫：`reader.read()` 会一直阻塞到服务端发东西，一条停止产出又不关闭的流会永远占住调用方（以及被它串行化的同步）。

## 工具白名单

`src/tool-guard.js` 是白名单，不是黑名单。插件承诺「网页版对话不写本地文件」，黑名单保不住这个承诺——组合里新增一个工具，名单就静默失效一次。早期的黑名单漏了 `pwsh`（任意命令）和 `plugin_manager`（安装代码）。

网页版对话本来也不会发起工具调用（接口没有通道），所以拒绝未知工具没有代价。
