<div align="center">
  <img src="icon.png" width="128" alt="dsh-deepseek-web">
  <h1>dsh-deepseek-web</h1>
  <p>把 DeepSeek 网页版的对话接进 DSH——侧边栏直接看历史，用网页版模型接着聊，不消耗 API 余额。</p>
</div>

---

## 能做什么

装上之后，侧边栏多出一个 **「对话」** 分组，里面是你在 [chat.deepseek.com](https://chat.deepseek.com) 上的对话。点开就能看完整历史，也能直接在这里继续聊。

继续对话时选 **DeepSeek 网页版** 模型，请求走的是网页端，费用记在网页产品上，**不花 API 额度**。

两边是通的：

- 在 DSH 里聊的内容，网页端也会有
- 在网页端继续聊过的对话，回 DSH 再接着聊时能接上

## 安装

装完都要**重启 DSH**。重启后「设置 → 插件」里应该能看到 `dsh-deepseek-web` 和它的图标。

### 方式一：在 DSH 界面里装（推荐）

1. 打开 DSH，侧边栏底部点 **设置**
2. 左侧选 **插件**
3. 点 **添加插件**
4. 在「包名或地址」里填：

   ```
   https://github.com/KyMi-22/dsh-deepseek-web
   ```

5. 点 **安装**，等它跑完
6. 回到插件列表确认 `dsh-deepseek-web` 是启用状态，然后重启 DSH

> 这一步会通过 git 访问 github.com。如果连不上或者一直超时，用下面的 tgz 方式。

### 方式二：从下载的 tgz 装（GitHub 连不上时用）

只要浏览器能打开下载页面就行，不经过 git。

1. 打开 [Releases](https://github.com/KyMi-22/dsh-deepseek-web/releases)，下载最新的 `dsh-deepseek-web-x.y.z.tgz`
2. 设置 → 插件 → **添加插件**
3. 在「包名或地址」里填 tgz 的**完整路径**，例如：

   ```
   C:\Users\你\Downloads\dsh-deepseek-web-0.1.13.tgz
   ```

4. 点 **安装**，之后同样重启 DSH

> 路径里的反斜杠直接填，不用转义。不知道完整路径的话，在文件管理器里右键 tgz →「复制文件地址」。

### 方式三：命令行

需要先有 Node（`^22.19.0` 或 `>=24`）。按你用的 DSH 形态选一条：

**桌面版**

```bash
npx @deepseek-ai/dsh plugin --profile desktop add github:KyMi-22/dsh-deepseek-web
```

**Web 版**

```bash
npx @deepseek-ai/dsh plugin --profile web add github:KyMi-22/dsh-deepseek-web
```

> 如果 `dsh` 已经在你的 PATH 里（比如从源码构建过），把开头的 `npx @deepseek-ai/dsh` 换成 `dsh`。
>
> 装本地 tgz 同理，把 `github:...` 换成 tgz 的路径即可。

<details>
<summary>从本地目录安装（改代码时用）</summary>

```bash
npx @deepseek-ai/dsh plugin --profile desktop add /path/to/dsh-deepseek-web
```

界面方式也可以：方式一第 4 步填本地目录的完整路径。

</details>

<details>
<summary>安装报错</summary>

**Node 版本太低**——低于 `22.19.0` 会过不了 engine 检查：

```bash
node --version
```

**连不上 GitHub / 一直超时**——改用「方式二」的 tgz，绕开 git。坚持用仓库地址的话，需要让你的 `git` 能访问 github.com（`git` 不读 Windows 的系统代理设置，得单独配）。

**装完看不到插件**——确认已启用，然后重启 DSH。热重载不一定能覆盖 profile 的 bundle 列表变化。

</details>

## 开始使用

### 1. 拿到 user token

1. 浏览器登录 [chat.deepseek.com](https://chat.deepseek.com)
2. 按 `F12`，切到 **Console** 标签
3. 粘贴这一行并回车，复制输出的内容

```js
JSON.parse(localStorage.userToken).value
```

输出的是一长串字符。这就是你的登录凭证，**不要发给别人**。

### 2. 填进插件

DSH 里打开 **设置 → DeepSeek 网页版**，把 token 粘进输入框，点「保存并验证」。验证通过会显示你的账号。

### 3. 同步对话

同一页点「立即同步」。之后默认每 5 分钟自动同步一次，不用管它。

### 4. 开始聊

回到侧边栏，展开 **对话** 分组，点任意一条就能看历史。想继续聊，在输入框的模型选择器里选 **DeepSeek 网页版**。

## 两个方向的同步规则

插件只在一种情况下会写网页端：**用「DeepSeek 网页版」模型聊天时**。其他情况网页端不会变。这两件事容易搞混，分开说。

### 情况一：导入的对话，改用 DSH 的模型继续

原本在网页端的对话导入之后，你切到 DSH 自带的模型（比如 `DeepSeek V4`）接着聊。

| | 影响 |
|---|---|
| **网页端** | 对话**定格在导入那一刻**。之后在这里聊的内容，网页端看不到 |
| **DSH** | 正常继续。导入的历史是普通消息，模型能完整读到 |
| **文件** | **能生成**。相对路径落在会话工作目录 `$DSH_HOME/deepseek-web/conversations`，绝对路径按模型指定的位置 |

网页端不同步不是插件偷懒：官方模型的请求发往 `api.deepseek.com`，网页对话住在 `chat.deepseek.com`，是两套独立的产品，API 没有「往某个网页对话追加一条消息」这种接口。

> 想让网页端也保持同步，就别切模型——继续用「DeepSeek 网页版」。

### 情况二：在 DSH 里新建对话，用 DS 网页模型

在 DSH 里新建会话（哪个分组都行），模型选择器里选「DeepSeek 网页版」。

| | 影响 |
|---|---|
| **网页端** | 会**创建对应对话**，你的提问和模型的回复都写进去 |
| **DSH** | 正常，有完整的本地记录 |
| **文件** | **不会生成**。网页接口没有工具调用通道，模型只能输出文本 |
| **分组** | 与会话在哪个分组**无关**。即使建在「对话」分组之外，同样会写到网页端 |

这就是这个插件的主要用法：用网页版的免费额度跑 DSH 的对话。

### 一句话对照

| 场景 | 网页端 | 能生成文件 |
|---|---|---|
| 直接在网页端聊 | 正常，就是多一条消息 | 否 |
| 导入的对话 + DSH 模型 | 定格，看不到后续 | 是 |
| 任意会话 + 网页版模型 | 创建或写入对应对话 | 否 |

## 常用操作

| 想做什么 | 怎么做 |
|---|---|
| 马上拉取新对话 | 设置页点「立即同步」 |
| 同步了但侧边栏没变化 | 点「热重载并刷新」 |
| 清空导入的对话 | 设置页点「撤销导入」 |
| 调整同步范围 | 设置里的 `syncWindow`（默认只同步本周） |

**关于撤销**：撤销会把「对话」分组下的会话归档、删掉插件导入的那些，然后删除分组。你在 DSH 里自己新建、用网页版模型聊过的对话**只会被归档，文件保留**，不会丢。

## 可选设置

在插件配置里可以调：

| 字段 | 默认 | 说明 |
|---|---|---|
| `syncWindow` | `week` | 同步范围：`week` / `month` / `all`，或数字（最近 N 天） |
| `syncIntervalSeconds` | `300` | 自动同步的均值间隔，实际会上下浮动 30% 左右；`0` 表示只手动同步 |
| `autoSync` | `true` | 关掉后台自动同步 |
| `baseUrl` | `https://chat.deepseek.com` | 站点地址 |

不想让 token 落盘的话，用环境变量启动 DSH：

```powershell
$env:DEEPSEEK_WEB_TOKEN = '<token>'
```

## 常见问题

**Q：输入框里的模型选择器找不到「DeepSeek 网页版」？**

先确认插件已启用（设置 → 插件），然后重启 DSH。provider 是在插件加载时注册的。

**Q：同步完成但侧边栏是空的？**

点设置页的「热重载并刷新」。侧边栏读的是会话索引，有时候需要重新构建一次才看得到。

**Q：提示 token 无效？**

token 会过期。重新执行上面「拿 token」的三步，用新的替换掉。

**Q：会话里的模型为什么不会调用工具？**

DeepSeek 网页版的接口只收一段文本，没有函数调用通道。这是接口本身的限制。需要工具时，在 DSH 里新建一个会话，选官方 API 的模型即可。

**Q：我的对话内容会被发到哪里？**

只发往 `chat.deepseek.com`，就是你本来就在用的那个网站。插件不向任何第三方发送数据。

## 限制

- **不发起工具调用**：网页端接口没有 function-calling 通道。联网搜索和深度思考是网页版自带的能力，通过模型选择器里的对应版本启用。
- **不支持内嵌网页**：`chat.deepseek.com` 设置了 `frame-ancestors 'none'`，任何页面都无法用 iframe 嵌入。
- **同步有延迟**：网页端没有推送接口，只能轮询。
- **网页对话会一直变长**：一个 DSH 会话绑定一个网页对话后就不再更换，聊得越久上下文占用越多。改进方向见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 后续计划

已知但还没做的方向，包括上面那条的解法（改用临时对话 + 压缩上下文），都在 **[docs/ROADMAP.md](docs/ROADMAP.md)**。

## 开发

```bash
npm test        # 12 套离线测试
npm run check   # 语法检查
```

技术细节（数据流、种子事件格式、撤销为什么先归档、同步节奏为什么随机）见 **[docs/DESIGN.md](docs/DESIGN.md)**。

## 许可

[MIT](LICENSE)
