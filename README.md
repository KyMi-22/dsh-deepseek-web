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

> 下载慢或连不上 GitHub 时，安装界面里有「**安装源**」选项，可以切到国内镜像源。

### 方式二：命令行

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

<details>
<summary>从本地目录安装（改代码时用）</summary>

```bash
npx @deepseek-ai/dsh plugin --profile desktop add /path/to/dsh-deepseek-web
```

界面方式也可以：第 4 步填本地目录的完整路径。

</details>

<details>
<summary>安装报错</summary>

先确认 Node 版本，低于 `22.19.0` 会过不了 engine 检查：

```bash
node --version
```

如果是 GitHub 连不上，用界面方式并切换安装源，或给命令行配置代理。

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

**Q：安装一直超时，换安装源也没用？**

如果你的网络需要代理才能访问 GitHub，多半是这个原因：**`git` 和 `pnpm` 默认都不读系统代理**（系统代理只对浏览器生效），需要单独配。

先确认代理端口（Windows 的「设置 → 网络和 Internet → 代理」里能看到），然后：

```bash
# git 走代理——GitHub 仓库安装要靠它
git config --global http.proxy http://127.0.0.1:7890
git config --global https.proxy http://127.0.0.1:7890

# npm/pnpm 走代理——拉 npm 包要靠它
npm config set proxy http://127.0.0.1:7890
npm config set https-proxy http://127.0.0.1:7890
```

把 `7890` 换成你自己的端口。配完回 DSH 界面重试，**不用重启**。

为什么换安装源没用：安装源只改 npm registry，而 GitHub 仓库形式的安装最后仍要连 github.com，那一步走的是 `git`。

代理关掉后如果 npm 报错，用下面的命令还原：

```bash
git config --global --unset http.proxy
git config --global --unset https.proxy
npm config delete proxy
npm config delete https-proxy
```

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

## 开发

```bash
npm test        # 12 套离线测试
npm run check   # 语法检查
```

技术细节（数据流、种子事件格式、撤销为什么先归档、同步节奏为什么随机）见 **[docs/DESIGN.md](docs/DESIGN.md)**。

## 许可

[MIT](LICENSE)
