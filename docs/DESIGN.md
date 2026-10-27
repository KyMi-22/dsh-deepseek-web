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
| `index.js` | Host 入口：注册 provider、同步引擎、设置页路由、快捷侧问路由、工具拦截 |
| `client.js` | 浏览器半边：设置页 + 快捷侧问面板（右栏 tab 与入口按钮） |
| `src/api.js` | `/api/v0` 客户端：分页、历史、建会话、图片上传、SSE 解析、错误分类 |
| `src/adapter.js` | provider 适配：message → prompt，图片引用收集，SSE → `StreamChunk` |
| `src/sync.js` | 网页对话 → 种子会话；工作区；撤销 |
| `src/store.js` | 插件状态（token、绑定、账本、侧问线程），原子写入 |
| `src/pow.js` | `DeepSeekHashV1` 求解器 |
| `src/pow-async.js` | 求解放到 worker 线程，带进程内回退 |
| `src/pow-worker.js` | worker 入口 |
| `src/http.js` | 设置页路由用的 JSON / 请求体工具 |
| `src/tool-guard.js` | 网页版会话的工具白名单 |
| `src/quick-ask.js` | 快捷侧问：压缩背景、每会话一条网页线程、SSE 泵 |
| `src/quick-ask-tag.js` | 侧问线程命名与导入排除规则（无依赖叶子模块） |
| `src/update.js` | 自更新：语义版本比较、Release 查询、下载与摘要校验 |

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

## 图片与文件上传

带图消息在 completion 之前走三步：`readImage`（附件存储校验读取）→ `upload_file`（该端点单独解一次 PoW）→ 轮询 `fetch_files` 等解析离开 `PENDING`。上传拿到的是文件 id，随 `ref_file_ids` 进入 completion——与浏览器端的请求形状一致。

文档走同一条链路，差别只有三处：字节来自 `readFileStream`（逐块拼接，20 MB 上限）、媒体类型由扩展名推断（`mediaTypeForName`）、上传头部的 `x-model-type` 用 `file`（图片用 `vision`）。`FileBlock` 的引用只有 `{attachmentId, name}`，没有媒体类型——这是附件存储「文件原样、类型无关」的设计，所以类型在适配器侧补。

**解析结果 `FAILED` 自动重试一次**：解析跑在网页端的异步队列里，偶发的 `FAILED` 不代表文件本身有问题（实测 PNG/WebP/GIF 与 18.9 MiB 大图都能通过）。`uploadFile` 捕获 `PARSE_FAILED` 后重新解 PoW、重新上传、再等一次解析；第二次仍失败才抛错，并带上文件名、媒体类型、字节数与原始状态/审核结果。错误码从 `BIZ` 独立为 `PARSE_FAILED`，重试只针对这一类，业务拒绝（`BIZ`）不重试。

两个容易踩的坑：

- **附件引用必须原样传递**。`ImageBlock.attachment` 里的 `bytes/width/height` 不是装饰信息：本地附件存储读取时会重新探测存储对象，逐字段核对引用（`mediaType`、`bytes`、`width`、`height`），缺一个字段就是 `ATTACHMENT_CORRUPT`。0.2.0 曾把引用裁剪成 `{attachmentId, mediaType, name}`，导致每条带图消息在上传前就被拒。
- **上传文件名按扩展名校验**。端点用文件名的扩展判断类型：无扩展名、或扩展名与 `mediaType` 不符（改名保存的文件常这样）都会被拒为 `unsupported file type`。适配器只保留与声明类型一致的名字，其余重新生成为 `image.<ext>`；文档的名字若已带任意扩展名就保留，缺扩展名时按媒体类型补（`documentFileName`）。
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

## 快捷侧问

「用内置模型聊到一半，切网页模型问个小问题」的老办法有两个代价：网页端得到一个只有一句的孤立对话，DSH 原对话的上下文又被这轮往返撑长。快捷侧问把这两个问题一起解掉：问答发生在一个**独立的右栏面板**里，背景是原对话的**压缩摘要**，原对话的日志一个字节都不动。

- **入口**：会话头部 `conversation.session.header.utilities` 席位里的常驻按钮（三点按钮旁边）。菜单项本身（`session-log-export` 的「更多操作」）没有扩展席位，塞不进去。
- **面板**：`ctx.sidebarRightTabs.register` + `sidebar.right.pane.tab` 正文注册，走文档预览同款的公开两级路径；`ctx.sidebarRight.openTab(kind, { preferNewPane: true })` 打开并展开右栏。右栏布局本就按会话隔离，侧问线程与面板天然同生命周期。
- **线程**：每个 DSH 会话**一条**网页对话，首次提问时创建并把压缩背景作为第一条消息发过去（`parent_message_id` 续链）。线程记录落在 `state.json` 的 `quickAsk`，重开面板可续聊。「刷新背景」丢弃当前线程、用最新压缩重建——旧网页对话不删（已属网页产品），只是不再引用。
- **命名与导入排除**：线程创建后立即把网页对话重命名为 `SideBar：<对应 DSH 对话名>`（`session/title` 事件的最后一个值；无标题时回退 `SideBar：快捷侧问`）。网页端拒绝给空对话改名，所以「无背景的裸线程」会在第一条回答落定后补改。导入规则（`selectImportBatch`）拒绝带该前缀的对话——其中也接受旧版本的 `[SideBar]` / `[快捷侧问]` 拼写。第二道保险是 `quickAsk` 账本里的网页对话 id 并入 `boundChatIds`，覆盖改名尚未落地的窗口。
- **压缩**：规则压缩，零成本、确定性。读 `sessionPersistence` 的只读句柄取会话日志，过滤出人类输入（`source.kind === 'user'`，剔除 harness 注入的运行时上下文）与助手回答（丢推理块和工具流量），从最新往回装进 12000 字符预算，每轮截 1600 字符，被裁掉的轮数以一行标注。
- **视觉**：面板与入口按钮使用宿主主题变量（`--dsw-specific-bubble`、`--dsw-radius-lg`、`--dsw-alias-*`），随明暗主题自动切换；入口图标是宿主自带的 Sparkle 轮廓路径（与三点按钮同尺寸、同 hover 底色）。顶部说明是一张独立卡片，标题行即折叠开关；偏好存 `localStorage`。对话列（表头、消息、输入框）统一收在面板宽度 80% 的居中列里，两侧各留 10% 留白（`padding-inline: 10%`）。
- **回复渲染**：助手回复用面板内自带的小型 Markdown 渲染器（`renderMarkdown`）转成 React 节点——标题、粗体/斜体/删除线、行内代码、围栏代码、列表、引用、分隔线、链接、管道表格、段内换行。**不拼 HTML 字符串**，模型输出无法注入标记；流式期间未闭合的围栏按代码块渲染。用户提问保持原文，不参与渲染。回复容器是圆角底色块（无描边），代码与表格按主题 token 着色；流式与落定同色（不设 `data-live` 弱化色）。
- **消息元信息**：每条消息渲染为「行容器 → 气泡 → 元信息行」：元信息行放复制按钮（DSH copy 轮廓，复制后短暂显示勾选）与时间戳（`HH:mm`，来自 Host 记录的 `at`；旧记录无该字段则不显示）。
- **输入框**：套用原生 composer 的两段式结构（输入区 + 底部工具栏），背景是半透明毛玻璃（`backdrop-filter` + 内高光 + 主题描边）。左下角的模型胶囊取代宿主的权限选择：菜单向上弹出，列出 `MODELS` 的四条网页路由（普通 / 深度思考 / 智能搜索 / 搜索+深度思考），选择后由 `/quick-ask/send` 的 `thinking`/`search` 标志决定走哪条路由。选项由 `/quick-ask/status` 下发（Host 的 `MODELS` 单一来源），浏览器端保留一份首帧兜底表。发送按钮是纸飞机图标圆钮。
- **附件**：回形针按钮打开多选文件选择器；选中的文件以原始字节 POST 到 `/quick-ask/upload`（文件名与媒体类型在 query，`readRawBody` 边读边限 20 MB），Host 调 `uploadFile`（`vision`/`file` 按媒体类型）上传到网页端并返回 id。发送时 id 进 `ref_file_ids`、文件名进 `quickAsk` 记录（气泡内展示为文件条）。只附文件不打字时 prompt 自动写成「请查看附件：…」，保证文本非空；发送失败会把暂存附件放回去，便于重试。
- **数据面**：`/quick-ask/status`（面板状态 + 模型选项）、`/quick-ask/upload`（原始字节上传）、`/quick-ask/reset`（换线程）、`/quick-ask/send`（SSE 流式回复，请求断开即中止生成）。问答记录只进 `quickAsk` 账本，**不写会话日志**——这是整个功能的存在理由。
- **失败语义**：创建线程（PoW、建会话、发背景）失败时面板报错、不落线程记录，可整轮重试；回复流中断则保留已到手的片段，父消息标记不动，避免重试分叉出两条回答。

## 自更新

设置页的「更新」一节只做三件事：查版本、下载包、把包交给插件管理器。**安装不是本插件做的**——`ctx.get('pluginManager').installBundle(tgz)` 拥有 profile、pnpm 与重组，插件只负责把文件准备好。

- **版本比较**：`src/update.js` 的 `parseVersion` / `compareVersions` 按数字三元组比较（`0.10.0 > 0.9.0`），tag 的 `v` 前缀与 `-rc` 后缀不参与比较。
- **查询**：`GET https://api.github.com/repos/<repo>/releases/latest`。网络策略上有取舍——`api.github.com` 在多数网络可直连，但 release 资源由 `github.com` / `objects.githubusercontent.com` 提供，部分网络会重置连接。
- **下载**：配置了 `updateProxy` 时走 `curl -x`（Node 的 fetch 只在进程启动时读一次代理环境变量，运行期改不了），否则用 fetch 流式写入。文件先写 `.part`，校验 GitHub 提供的 `sha256` 摘要与字节数一致后才改名；任何一步失败都删掉半成品，不会留下一个「看起来能装」的文件。
- **安装**：下载完成后先回应页面，再 `setTimeout` 触发 `installBundle(path, { enabled: true })`。安装会替换本插件文件并触发重组，本 fiber 随即销毁——所以页面拿到的是「已下载、正在安装」，随后定时刷新（20 秒；没有插件管理器时 60 秒并提示手动安装）。装失败时插件管理器恢复 profile 清单，旧版本继续运行。
- **开发版装回发布版**：当前版本高于最新 Release 时（`compareVersions` 返回 -1），`updatePayload` 给出 `rollbackTo`，页面显示「装回发布版」并复用同一条下载+安装链路。这既是开发版的自救入口，也是验证安装链路的途径。
- **没有插件管理器时**：只下载，页面给出路径，让用户在「设置 → 插件」里手动装。`capabilities` 与 `/update/status` 的 `canInstall` 都反映这一点。
