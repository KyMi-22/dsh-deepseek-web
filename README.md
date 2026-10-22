# dsh-deepseek-web

把 **chat.deepseek.com（DeepSeek 网页版）** 的对话接入 DSH。

- 侧边栏出现一个独立的 **「对话」工作区**，网页版的每个对话都在里面，可展开、搜索、折叠。
- 点开任意对话即可看到完整历史（含思考过程），并**直接在 DSH 里继续聊**。
- 继续对话走的是**网页端模型**，用量记在网页产品上，**不消耗 API 余额**。
- 网页端接口没有函数调用通道，因此这些会话不发起工具调用，也不会写本地文件；写入类工具另有一道拦截作为兜底。

## 安装

```powershell
dsh plugin add "C:\path\to\dsh-deepseek-web"
```

或在 DSH 里通过插件管理器安装本目录，然后重启（或热重载）。

## 使用

1. 设置 → **DeepSeek 网页版**。
2. 粘贴 chat.deepseek.com 的 user token，点「保存并验证」。
3. 点「立即同步全部对话」（之后默认每 5 分钟自动同步一次，间隔随机浮动）。
4. 回到侧边栏，展开 **对话** 工作区。
5. 在输入框的模型选择器里选 **DeepSeek 网页版**（或「深度思考」版本）继续对话。

### 撤销

设置页的 **撤销导入** 依次做三件事：

1. **归档**对话目录下的**所有**会话——既有插件从网页导入的，也有你在 DSH 里新建的；
2. 删掉**插件导入的那些**会话文件（你在 DSH 里新建的对话，日志保留）；
3. 删除「对话」工作区并清空导入记录。

两个设计点都踩过坑：

**必须按目录找，不能只按导入记录找。** 导入记录只跟踪"从网页拉过来的"对话。你在 DSH 里用网页版模型新建的对话同样住在这个目录下，但它在记录里查不到；如果只按记录撤销，它就会被剩下——`cwd` 仍指向已注销的目录，于是掉进「未分组」。所以撤销时用 `sessionQuery.filterSessions({ kind: 'cwd', values: [对话目录] })` 把整个目录扫一遍。

**归档必须在删文件之前。** 删掉会话文件并不会把它从进程内的会话索引里移除，侧边栏仍会列出它——只是不再属于任何工作区，于是同样掉进「未分组」，看起来像"撤销反而弄得更乱"。归档是唯一能让运行时停止列出某个会话的受支持方式，而它需要读取会话存档的 header；文件一旦删除这个调用就失败了。所以顺序只能是：先归档（文件还在），再删文件。

网页版上的对话不受影响，随时可以重新同步。撤销后后台同步暂停 10 分钟，免得刚清空又被自动导回来；点一次「立即同步」即可恢复。

### 同步不会重复导入

在 DSH 里**新建**一个会话并用网页版模型聊天时，网页端会同时出现一个对话。下次同步如果不加区分，就会把这个对话当成"网页版上的新对话"再导入一次，结果侧边栏出现两个一模一样的对话。

所以同步只挑选**尚未与 DSH 会话绑定**的网页对话：

- 插件为新建的 DSH 会话创建网页对话时，只写 `bindings`（**不写** `imported`），下一次同步按绑定关系跳过；
- 选择导入批次时再排除一遍 `bindings` 里已绑定的网页对话 id。

两条记录刻意分开，因为它们的含义不同：`bindings` 说"这个网页对话属于哪个 DSH 会话"，`imported` 说"这个网页对话是被导入进来的"。撤销按后者决定删不删文件——把本地新建的会话写进 `imported`，撤销时就会删掉用户自己的对话。

`bindings` 里另有一个不可变的 `origin` 字段（`imported` / `local`）。不能用 `seeded` 判断来源：它在首轮回答完成后会被改成 `true`，含义是"已经聊过了"，不是"从哪来的"。

### 会话 id 与双身份

每个导入的网页对话会拿到一个**新生成的 UUID** 作为 DSH 会话 id，而不是复用网页那边的 id：

- 两个身份分开后，归档一条旧残留永远不会遮蔽以后重新导入的同一个对话；
- 会话 id 是会被校验的，把网页 id 或它的任何装饰形式（`dsw-<id>` 之类）直接当会话 id 用会在创建时被拒。

网页 id 与 DSH 会话 id 的对应关系由插件自己的导入记录维护。

## 获取 token

1. 在浏览器里登录 [chat.deepseek.com](https://chat.deepseek.com)
2. 按 `F12` 打开开发者工具，切到 **Console（控制台）** 面板
3. 粘贴并运行下面这行，复制它输出的那串字符

```js
JSON.parse(localStorage.userToken).value
```

4. 粘贴到设置页的输入框，点「保存并验证」

网页端把凭证存在 `localStorage` 的 `userToken` 键里，形式是 `{"value":"…","__version":"0"}`——只需要 `value` 引号里的那一串。`token` 等同于你的登录凭证，不要分享给他人。

设置页的「连接」区块里也内置了这份说明（折叠状态，点开即可看到）。

### token 存在哪里

默认保存在 `$DSH_HOME/deepseek-web/state.json`，目录 `0700`、文件 `0600`（POSIX），设置页不会回显它（只显示末四位）。

如果不想让它落盘，用环境变量启动 DSH：

```powershell
$env:DEEPSEEK_WEB_TOKEN = '<token>'
```

环境变量优先级最高，此时 `state.json` 里的旧 token 会被忽略，设置页也会提示凭证来自环境变量（保存按钮返回 409，避免出现"存了却不生效"的错觉）。

**关于「保证安全」**：明文落盘做不到"保证"，只能限制影响范围。实际风险从高到低是——

1. **云同步**（最现实）：如果你的 `~/.dsh` 落在 OneDrive / Dropbox / iCloud 的同步目录里，token 会跟着上云。这是唯一值得你主动检查的一条。
2. 同机其他用户：Windows 的用户目录 ACL 已做隔离，POSIX 上靠 `0600`。
3. 本机恶意软件：任何本地凭证都挡不住，DPAPI 也一样（同一用户态下可解）。

这个文件的保护级别与浏览器保存的登录 cookie 相当。

**为什么不用「DSH 登录态」或「弹网页扫码」自动获取**：

- DSH 的 `deepseekAccount` 管的是 **Platform**（platform.deepseek.com）的 OAuth grant，`resolveToken(url)` 明确限制为 inference origin。网页版是 `chat.deepseek.com`，**不同 origin、不同凭证体系**——同一个账号不代表同一个凭证。
- DSH 确实有 `startSignIn()`（浏览器授权、`waiting-browser` 阶段、`authorizeUrl`），但它授权的同样是 Platform，换不回网页版 token。
- 想拿网页版 token 只能模拟网页登录流程（扫码/短信 → 换 token），那是在逆向登录协议，稳定性差且有合规风险。
- 改用 `credentials` 服务也不增加安全性：我查过 `.credentials.yaml`，**同样是明文**，没有任何加密标记。

## 工作原理

| 部分 | 说明 |
|---|---|
| `src/pow.js` | 网页端发消息需要 PoW 挑战。这里是按其 worker 逐字移植的 `DeepSeekHashV1` sponge（自定义 Keccak 变体：lane 高低字互换、23 轮，**不是**标准 SHA3-256）。 |
| `src/pow-async.js` | 把求解放到 worker 线程，避免一秒多的紧循环卡住 Host 事件循环；worker 不可用时回退到进程内。 |
| `src/pow-worker.js` | worker 线程入口，只做「解一个挑战」这一件事。 |
| `src/api.js` | `/api/v0` 客户端：分页拉会话、读历史、建会话、发消息并解析 SSE 的 JSON-patch 增量。 |
| `src/adapter.js` | `deepseek-web` provider：把 DSH 的 `messages` 转成网页端 prompt，把回复流翻译成 `StreamChunk`。 |
| `src/sync.js` | 把网页对话变成带种子事件的 DSH 会话，落在「对话」工作区目录下。 |
| `src/store.js` | 插件自有状态（token、会话映射），原子写入。 |
| `src/http.js` | 设置页路由用的传输小工具：JSON 回复、带大小上限的请求体读取。 |
| `src/tool-guard.js` | 网页版会话的工具白名单（安全边界，独立成文件便于单独审阅）。 |
| `index.js` | Host 入口：注册 provider、同步引擎、设置页路由、写文件拦截。 |
| `client.js` | 浏览器半边：设置页。 |

### 为什么是「工作区」而不是新的侧边栏分组

侧边栏的 `sidebar.workspaces` 是单例槽位且标记为 `shadows-shipped-ui`——往里面注册会顶掉官方整个会话浏览区。DSH 本身的模型就是「工作区 → 会话」，所以一个名为「对话」的独立工作区既能得到原生分组、折叠、搜索，又完全不碰官方 UI。

### 导入会话必须「看起来像真会话」

种子日志不是随便写几条消息就行，DSH 的投影、标题和请求纪元都从这些事件推导。一次导入必须给出与真实循环一致的事件序列：

```
turn/start → step/start → user/message → request/header → request/context
→ session/title → assistant/message → step/end → turn/end
```

- 缺 `step/start`／`step/end`：assistant 消息不在任何 step 内，**对话内容渲染不出来**。
- 缺 `session/title`：侧边栏那一行**没有标题**。
- 缺 `request/header`／`request/context`：resume 时**不知道该用哪个 provider/model**。
- turn 与 step 都从 **1** 开始，和真实循环一致。

另外，**创建工作区并不会自动收养目录里已有的会话**：成员关系是工作区上的一条显式记录，还要按会话存档的 `cwd` 校验。所以每轮同步都会把已导入的会话 `attachSession` 一遍（重复调用是幂等的），否则工作区是空的、会话全落在「未分组」。

### 导入的会话为什么能立刻看见

`agentLoop.createAgent` 是唯一会挂上会话日志写入器的创建路径，但写入是**带缓冲**的。创建完立刻 `dispose()`，有可能在日志真正落到存储之前就把会话释放掉——而侧边栏渲染一行靠的是会话查询索引，它只看得见已持久化的会话。这就是「同步完要重载/刷新才出现」的来源。

所以创建之后、释放之前，插件会显式调用一次 `ctx.sessions.flush(session)` 把日志推下去。会话还是 live 的时候 `flush` 才拿得到会话对象，一旦 `dispose` 就只剩缓冲里的写入。

同一轮里随后执行的 `attachSession` 也依赖会话存档的 header——日志没落盘它也会失败。

### 只发用户那一句

发给网页端的 prompt **只有你最后输入的那句话**：不带 system prompt，不带历史轮次，也不带 harness 注入的任何内容。

DSH 每一轮都会往 `messages` 里插入若干条 **user 角色** 的记账消息。它们靠 `source.kind` 区分，只有 `user` 是你真的打的字：

| `source.kind` | 内容 |
|---|---|
| `user` | **真人输入**（带 `rpcId`、`clientTimeZone`） |
| `runtime-context` | 环境块：工作目录、沙箱策略、审批策略、团队身份、GUI URL |
| `time-context` | 时间与时区：`Time sampled while preparing turn N…` |
| `skill-catalog` | `<system-reminder>` 里的技能清单 |
| `user-approval` | 审批策略变更通知 |
| `subagent-settled` | 子代理结束通知 |

早期版本只按文本开头匹配 `Current runtime context.`，于是 `time-context` 那段（以 `Time sampled while preparing turn` 开头）被当成真人输入发了出去，成了网页对话的开场白。现在**以 `source.kind === 'user'` 为准**，文本特征只作为 source 缺失时的兜底。

网页会话自己记得之前的轮次，所以不需要重复上传历史。

### 标题两边一致

网页端会用自己的模型从首轮内容生成标题——中文提问常被它翻成英文。所以首轮回答结束后，插件用 `update_title` 把网页会话改成与 DSH 相同的标题（取你输入的第一行，超过 32 字截断）。注意网页端**拒绝给空会话改名**，所以这一步必然发生在回答之后。

之后你在 DSH 里**重命名对话**，标题也会同步过去：插件订阅 `session/event`，只处理 `session/title` 事件——

```js
ctx.on('session/event', (session, event) => {
  const planned = planTitlePush(event, session.id, (id) => store.binding(id));
  if (planned !== null) void api.renameSession(planned.chatSessionId, planned.title);
});
```

几个约束都是有意的：

- **以会话日志为准**。改名的结果是 `session/title` 事件，它带的就是侧边栏显示的标签；
- **只推有绑定的会话**。DSH 会话通过绑定表映射到网页对话，没有绑定就没有可改的目标；
- **种子事件不会误触发**。seed 写入的标题不会走 `session/event`，所以导入对话不会被当成一次改名；
- **不构成回路**。我们只写网页端的标题，不写回 DSH，因此不会来回触发。

### 辅助调用不碰网页

DSH 除了主对话，还会发起两类辅助 LLM 调用：会话标题生成（`purpose: 'session-title'`）和历史压缩（`purposes: 'compaction'`）。它们同样走 `ctx.llm`，因此也会落到这个 provider 上。

如果转发到网页端，每个 DSH 会话都会在网页上多出「Session title generation」「Declining roleplay」这种垃圾会话，还白花网页额度。适配器因此**在本地回答这两类调用**：标题取首条用户消息，压缩取各轮对话的截断摘要。

### 联网搜索

DeepSeek 网页版的联网搜索是它独有的能力（API 侧没有）。模型选择器里额外提供两个开关它的模型：

| 模型 | 深度思考 | 联网搜索 |
|---|---|---|
| `DeepSeek 网页版` | 关 | 关 |
| `DeepSeek 网页版 · 深度思考` | 开 | 关 |
| `DeepSeek 网页版 · 智能搜索` | 关 | 开 |
| `DeepSeek 网页版 · 搜索 + 深度思考` | 开 | 开 |

开启后回答会带 `[citation:N]` 引用。搜索过程中网页端会推送 `TOOL_SEARCH` / `TOOL_OPEN` 分片（内容是「Found 16 web pages」这类记账信息），解析时会丢弃，不会混进答案正文。

### 同步后看不到新对话？

同步做的是写完会话、挂上工作区归属，但侧边栏那一行来自**会话索引**。索引的刷新时机不由插件控制，所以偶尔会有「同步完成了，列表还没变」的窗口。

「对话同步」区块里的 **热重载并刷新** 按钮走官方 HMR：`ctx.get('hmr').runExclusive(() => hmr.reconcileProfile())` 重新组合插件树、重建索引，随后页面自动刷新。

如果当前 Host 没启用 HMR（比如 headless 组合），按钮会明确告诉你，此时手动刷新页面（`Ctrl+R`）或重启 DSH 即可。

## 测试

```powershell
npm test            # 离线：adapter chunk 契约 / prompt 过滤 / seed 事件 / 同步与撤销 / 设置页渲染
npm run check       # 语法检查
$env:DS_TOKEN = '<user token>'
npm run test:live   # 联网：PoW、会话列表、历史、流式回复
```

## 限制

- **工具调用**：网页端 `chat/completion` 只接受一段 `prompt` 字符串，没有 function-calling 通道，所以模型不会发起**自定义**工具调用。这是接口限制，不是插件缺陷。网页版自带的能力（联网搜索、深度思考）通过上面的模型变体启用。
- **内嵌网页版**：`chat.deepseek.com` 返回 `content-security-policy: frame-ancestors 'none'`，任何 iframe/webview 嵌入都会被浏览器拒绝，因此没有做页面内嵌。
- **实时性**：网页端没有推送接口，同步靠轮询（`syncIntervalSeconds`，默认 300 秒且随机浮动）或手动触发。

## 配置

在 bundle 的 `config` 里可设：

| 字段 | 默认 | 说明 |
|---|---|---|
| `token` | 空 | 首次配置也可以写在这里。注意每次挂载时，**非空的 `config.token` 会覆盖** `state.json` 里保存的值（除非设置了 `DEEPSEEK_WEB_TOKEN`，它优先级最高）。 |
| `baseUrl` | `https://chat.deepseek.com` | 站点地址。 |
| `autoSync` | `true` | 是否后台同步。 |
| `syncIntervalSeconds` | `300` | 后台同步的**均值**间隔（秒）。实际间隔在 ±30% 内随机浮动，见下。设为 `0` 则只在手动触发时同步。 |
| `syncWindow` | `'week'` | 同步范围：`'week'`（本周，周一 00:00 起）、`'month'`（本月 1 日起）、`'all'`（全部），或一个数字表示最近 N 天。 |

### 为什么同步间隔是随机的

早期版本用 `setInterval` 每 60 秒刷一次会话列表。这个行为本身不违规——`fetch_page` 是只读接口——但**固定节拍本身是最强的机器特征**：真人不会按秒表刷列表，而检测方只要看间隔的方差就能把脚本和人对上。

所以现在改成递归 `setTimeout`，每次延迟在均值上下浮动 30%：

```js
export function nextSyncDelayMs(baseSeconds, random = Math.random) {
  const factor = 1 + (random() * 2 - 1) * 0.3;   // 0.7 ~ 1.3
  return Math.round(baseSeconds * factor * 1000);
}
```

均值也从 60 秒放宽到 **5 分钟**。想更频繁就手动点「立即同步全部对话」——手动操作没有节拍特征。

### 同步不会并发

`syncNow` 是串行的：第二次调用会**复用**正在飞的那一次，而不是再开一轮。

这不是洁癖。两轮并发同步会各自读到「这个对话还没导入」的旧状态，然后**各自创建一个 DSH 会话**——正是导入功能要避免的重复。手动点击撞上后台定时器时，这是真实可能发生的。

### 同步范围与排序

默认只同步**本周**的对话——账号里历史对话很多时，一次性全导进来会让侧边栏淹没在旧会话里。

导入顺序是**从旧到新**，这样最近的那条排在「对话」分组的最前面。原因是 `attachSession` 把会话插到列表头部，所以最后挂上去的（也就是最新的）自然落在第一个。

改动 `syncWindow` 不会删除已导入的对话，只影响之后同步的范围。

## 许可

MIT
