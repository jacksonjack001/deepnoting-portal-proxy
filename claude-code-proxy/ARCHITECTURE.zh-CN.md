# claude-code-proxy 架构与管理台实现说明

这份文档分两部分：

1. 说明仓库原有的代理能力是如何工作的。
2. 说明这次新增的“额度查看 + 账户管理”页面为什么这样设计、具体怎么落地。

目标读者是后续维护者，而不是纯使用者。所以这里更关注实现路径、数据流、约束和权衡。

## 1. 项目定位

`claude-code-proxy` 的核心目标一直很简单：

- 对外暴露一个 Anthropic `messages` 兼容代理。
- 不直接要求用户持有 Anthropic Console API Key。
- 优先使用 Claude Web / Claude Code 相关 OAuth 凭据来发起请求。
- 尽量把上游接口伪装成“Claude Code 官方客户端”可接受的请求格式。

仓库原始形态更接近“可运行代理 + 浏览器 OAuth 辅助页”，不是一个完整的管理后台项目。

## 2. 原始仓库是如何实现代理能力的

### 2.1 启动与入口

入口文件是 [server/server.js](/root/ai-proxy/claude-code-proxy/server/server.js:1)。

它负责几件事：

- 读取 `server/config.txt`
- 初始化日志
- 创建原生 `http.createServer`
- 注册 OAuth 页面和 API 路由
- 注册 `/v1/messages` 和 `/v1/:preset/messages` 代理入口
- 根据是否运行在 Docker 中决定绑定 `127.0.0.1` 还是 `0.0.0.0`

这个项目没有使用 Express、Koa 之类框架，而是直接用 Node 内建 `http` 模块做路由分发。好处是依赖少、路径清晰；代价是所有请求解析、错误处理、静态文件返回都要自己写。

### 2.2 认证来源与优先级

原始代理的认证思路是“三层兜底”，现在依然保留：

1. 请求头里的 `x-api-key`
2. 本地 OAuth token
3. Claude Code 凭据文件

对应实现主要在 [server/ClaudeRequest.js](/root/ai-proxy/claude-code-proxy/server/ClaudeRequest.js:1) 和 [server/OAuthManager.js](/root/ai-proxy/claude-code-proxy/server/OAuthManager.js:1)。

具体逻辑：

- 如果客户端请求里带了 `x-api-key`，并且内容看起来像 `sk-ant...`，就直接把它当 Bearer token 用。
- 如果没有手工 token，则走 `OAuthManager.isAuthenticated()` / `getValidAccessToken()` 读取本地 OAuth token。
- 如果 OAuth token 不存在，而且 `fallback_to_claude_code=true`，则读取 `~/.claude/.credentials.json` 里的 Claude Code 凭据。

这让仓库既支持“纯浏览器 OAuth 登录”，也兼容老的“本机已装 Claude Code”的用法。

### 2.3 OAuth 是怎么实现的

OAuth 相关实现分成两层：

- 页面与路由：`server/server.js`
- PKCE、换 token、刷新 token：`server/OAuthManager.js`

关键流程如下：

1. 用户访问 `/auth/login`
2. 页面前端调用 `/auth/get-url`
3. 服务端生成 PKCE 参数：`code_verifier`、`code_challenge`、`state`
4. 服务端把 `state -> code_verifier` 暂存到内存 `Map`
5. 浏览器跳转到 `https://claude.ai/oauth/authorize`
6. 用户在 Claude 页面完成授权
7. 用户把 `code#state` 粘回 `/auth/callback`
8. 服务器用 `platform.claude.com/v1/oauth/token` 交换 access token / refresh token
9. token 落盘，后续请求自动复用

几个实现细节值得注意：

- 使用 PKCE，而不是静态 client secret。
- `state` 带 10 分钟过期清理，避免内存里积累无效状态。
- token 将在过期前 1 分钟触发自动刷新。
- 并发刷新通过 `refreshPromise` / `refreshPromises` 做去重，避免同一个 token 被多次同时刷新。

### 2.4 代理请求是怎么构造的

上游请求构造主要在 [server/ClaudeRequest.js](/root/ai-proxy/claude-code-proxy/server/ClaudeRequest.js:1)。

原始仓库最关键的处理点有这些：

#### 1. 强制注入 Claude Code system prompt

Anthropic 这条链路要求 system prompt 的第一段是：

`You are Claude Code, Anthropic's official CLI for Claude.`

代码会在 `processRequestBody()` 里把这段 prompt 插到 `body.system` 的最前面。

#### 2. 清理 `cache_control.ttl`

有些前端会携带 `cache_control.ttl`，但上游端点不接受这个字段。项目会递归遍历 `system` 和 `messages[*].content[*]`，发现后直接删除。

#### 3. 过滤采样参数

为兼容某些 Sonnet 版本，项目允许启用 `filter_sampling_params=true`：

- `temperature` 和 `top_p` 同时出现时，只保留一个
- 默认值优先被删除
- 两者都非默认时偏向保留 `temperature`

#### 4. 保留并补齐 `anthropic-beta`

项目内置了一组默认 beta 头，并保留外部传入的 `anthropic-beta`。如果请求使用了 `context_management` 或 compaction，还会补相关 beta 标识，避免上游拒绝。

#### 5. 支持 preset

如果路径是 `/v1/:preset/messages`，会去 `server/presets/*.json` 读取预设：

- 可附加额外 system prompt
- 可在最后一条 `user` 消息后插入 suffix

这个能力原来就有，用于诸如 `pyrite` 这种预设人格。

### 2.5 上游响应是怎么回传的

原始项目支持两类响应：

- SSE 流式响应
- 普通 JSON 响应

处理逻辑也在 `ClaudeRequest.handleResponse()` / `streamResponse()`：

- 把上游状态码和响应头尽量透传回客户端
- 流式响应直接 `pipe`
- 非流式响应先拼接再 JSON parse，保证返回的是合法 JSON
- 如果上游返回 `401`，会尝试清缓存并刷新 token，然后自动重试一次

这就是原始仓库最核心的“proxy”能力。

### 2.6 原始仓库的限制

在这次改造前，仓库虽然能代理，但在运营/维护层面有明显短板：

- 默认只有单账户视角，本质上围绕 `tokens.json`
- 没有账户池、没有切换当前账户的 UI
- 没有额度查看入口
- 没有本地累计用量可视化
- `/auth/login` 和 `/auth/callback` 只是两个很薄的静态页，不是 dashboard

这也是这次补管理台的出发点。

## 3. 这次新增页面要解决什么问题

需求本质是两件事：

1. 能看到“这个账号还能不能用、用了多少”
2. 能管理“现在代理应该走哪个账号”

参考图来自另一个项目 `codex-proxy`，所以这次的 UI 目标不是随便补个表单，而是更接近一个轻量运维台：

- 顶部总览
- 账户列表卡片
- 额度条
- 使用统计
- 设置区

## 4. 设计约束与关键决策

### 4.1 为什么没有引入 React/Vite

`claude-code-proxy` 本身没有前端构建链，也不是前后端分离项目。

如果为了一个管理页引入：

- React / Vue
- Vite / Webpack
- 单独的 API client、构建脚本、静态资源产物

那么改造成本会明显超过需求本身，也会把这个仓库从“一个可运行 Node 代理”变成“一个要构建前端的全栈项目”。

所以这次选择的是：

- 继续用 `server/static/*.html/css/js`
- 由 [server/server.js](/root/ai-proxy/claude-code-proxy/server/server.js:206) 直接提供 `/dashboard`
- 使用原生 DOM + `fetch`

这套方案最符合当前仓库气质，也最方便部署。

### 4.2 为什么要做 `accounts.json`

原始项目只有 `~/.claude-code-proxy/tokens.json`，这天然只支持一个活跃 OAuth 身份。

为了支持多账户，需要一个新的持久化模型，因此新增了 [server/AccountStore.js](/root/ai-proxy/claude-code-proxy/server/AccountStore.js:7)：

- 持久化文件：`~/.claude-code-proxy/accounts.json`
- 支持多个账户
- 记录 `active_account_id`
- 每个账户可记录 label、token、过期时间、额度快照、累计 usage

但为了不破坏原有逻辑，这次没有直接废弃 `tokens.json`，而是做了“双写兼容”：

- 新增/切换账户时，会同步更新 `tokens.json`
- 老用户首次运行时，如果只有 `tokens.json` 没有 `accounts.json`，会自动迁移出一个默认账户

这样原有使用方式不会立刻断掉。

### 4.3 为什么额度展示用“探测请求 + 头解析”

这是这次设计里最重要的取舍。

我实际验证过：

- OAuth Bearer token 可以访问 `GET /v1/models`
- 也可以正常访问 `POST /v1/messages`
- 但不能访问 Anthropic 的 Admin Usage / Organization 类接口

这意味着：

- 做不了官方 Console 那种“组织月成本 / Admin Usage Report”
- 但可以从 `messages` 响应头里拿到真实的 unified rate-limit 信息

因此这次新增了：

- [server/quota.js](/root/ai-proxy/claude-code-proxy/server/quota.js:1)
- [server/AnthropicApi.js](/root/ai-proxy/claude-code-proxy/server/AnthropicApi.js:1)

方案是：

1. 先用 `GET /v1/models` 找一个尽可能便宜的模型，优先 `haiku`
2. 发一个极小的 `POST /v1/messages`
3. `max_tokens=1`
4. 从响应头里解析：
   - `anthropic-ratelimit-unified-5h-*`
   - `anthropic-ratelimit-unified-7d-*`
   - 以及可能存在的 classic rate-limit 头

这样面板里展示的“5 小时窗口 / 7 天窗口 / reset 时间 / utilization”都是真实数据。

### 4.4 为什么同时保留“本地累计 usage”

上游 Admin Usage API 不可用，不代表完全看不到使用情况。

代理本身每次成功请求时都能拿到响应体里的 `usage`，所以可以本地累加：

- `input_tokens`
- `output_tokens`
- `cache_creation_input_tokens`
- `cache_read_input_tokens`
- 请求次数
- 最近模型 / 最近响应时间

这部分数据不是 Anthropic Console 的官方账单，而是“本代理观测到的累计流量”。它的定位是运维辅助，不是财务对账。

## 5. 这次新增了哪些后端能力

### 5.1 账户存储层

[server/AccountStore.js](/root/ai-proxy/claude-code-proxy/server/AccountStore.js:7) 负责：

- 从 `tokens.json` 迁移到 `accounts.json`
- 维护当前活跃账户
- 新增、更新、重命名、删除账户
- 保存 quota 快照
- 累计 usage
- 生成 dashboard 所需的 overview 汇总数据

这个文件本质上是“轻量账户仓库”，没有数据库，完全文件化。

### 5.2 OAuthManager 从“单 token 管理器”变成“账户感知的 token 管理器”

[server/OAuthManager.js](/root/ai-proxy/claude-code-proxy/server/OAuthManager.js:1) 这次做了结构性升级：

- 支持按 `accountId` 刷新 token
- `loadTokens()` 优先读取当前激活账户
- `saveTokens()` 同时回写账户池和 legacy token 文件
- 增加 `activateAccount()` / `renameAccount()` / `removeAccount()`
- 增加 `updateAccountQuota()` / `recordProxyResponse()` / `recordUsage()`

也就是说，OAuthManager 不再只是“帮你换 token”，而是开始承担“当前生效账户状态协调器”的角色。

### 5.3 代理链路开始记录账户与额度

[server/ClaudeRequest.js](/root/ai-proxy/claude-code-proxy/server/ClaudeRequest.js:36) 这次新增了几块关键能力：

- 为每次请求记录当前认证来源
- 区分 manual token 与本地账户 token
- 成功请求后把响应头里的 quota 解析并写回账户
- 对流式和非流式响应都累计 `usage`
- 避免一次手工 `x-api-key` 请求污染全局缓存

这个改动的意义是：管理台不是孤立页面，而是和真实代理流量联动的。

### 5.4 新增管理 API

[server/server.js](/root/ai-proxy/claude-code-proxy/server/server.js:206) 里新增了管理台相关入口：

- `GET /dashboard`
- `GET /admin/dashboard`
- `POST /admin/accounts/:id/activate`
- `POST /admin/accounts/:id/refresh-quota`
- `PATCH /admin/accounts/:id`
- `DELETE /admin/accounts/:id`

同时保留原有：

- `/auth/login`
- `/auth/get-url`
- `/auth/callback`
- `/auth/status`
- `/auth/logout`
- `/v1/messages`

这样旧用法和新面板可以共存。

## 6. 这次新增了哪些前端能力

### 6.1 页面结构

新增静态资源：

- [server/static/dashboard.html](/root/ai-proxy/claude-code-proxy/server/static/dashboard.html:1)
- [server/static/dashboard.css](/root/ai-proxy/claude-code-proxy/server/static/dashboard.css:1)
- [server/static/dashboard.js](/root/ai-proxy/claude-code-proxy/server/static/dashboard.js:1)

页面分为四个 tab：

- `Overview`
- `Manage Accounts`
- `Usage Stats`
- `Settings`

这和参考图的结构是一致的：先看整体状态，再看账户，再看使用，再看配置。

### 6.2 UI 设计思路

这次不是简单堆表单，而是沿着 `codex-proxy` 的管理台视觉做了几个明确选择：

- 顶部 sticky bar，放全局状态与主要动作
- 概览卡片放核心数字，不让用户先看明细
- 账户列表使用卡片而不是纯表格，方便直接展示 quota 进度条
- 5h / 7d 用不同颜色的横条，视觉上区分短窗口和周窗口
- 弹窗只负责“新增账户”，避免把 OAuth 流塞在 dashboard 本页里

因为没有 React，这里全部使用原生 DOM 渲染。逻辑上比较直接：

1. 首次加载请求 `/admin/dashboard`
2. JS 在前端组装 overview / usage / settings
3. 对账户操作发起对应的 REST 调用
4. 成功后重新拉一次 dashboard 数据

### 6.3 OAuth 辅助页也做了重构

原本的 `login.html` / `callback.html` 比较薄，只够完成授权。

这次做了两点增强：

- `login.html` 可以给账户命名
- `callback.html` 在成功后向父窗口 `postMessage`，dashboard 能自动刷新

这样“从管理台点 Add Account -> 完成 OAuth -> 回到管理台看到新账户”形成了完整闭环。

## 7. 新增页面的完整数据流

### 7.1 新增账户

1. 用户在 `/dashboard` 点 `Add Account`
2. dashboard 打开 `/auth/login?label=...`
3. `login.html` 调 `/auth/get-url`
4. `server.js` 生成 PKCE 并把 label 绑定到 state
5. 用户授权后把 `code#state` 提交到 `/auth/callback`
6. `OAuthManager.exchangeCodeForTokens()` 换回 token
7. `OAuthManager.saveTokens()` 创建或更新账户
8. `probeQuota()` 发极小探测请求，拿到真实额度头
9. quota 写回账户
10. `callback.html` 通知 dashboard 刷新

### 7.2 切换账户

1. 前端点击 `Use This`
2. 调 `POST /admin/accounts/:id/activate`
3. `OAuthManager.activateAccount()` 更新 `active_account_id`
4. 同步回写 `tokens.json`
5. 清空 proxy token cache
6. 之后所有普通 `/v1/messages` 请求自动走新账户

### 7.3 刷新额度

1. 前端点击 `Refresh Quota`
2. 调 `POST /admin/accounts/:id/refresh-quota`
3. 后端读取该账户 token
4. `probeQuota()` 发一个小请求
5. `quota.js` 解析头信息
6. 返回最新 dashboard 数据

### 7.4 普通代理请求

1. 客户端调用 `/v1/messages`
2. `ClaudeRequest` 选定当前认证来源
3. 处理 system prompt / sampling / cache_control / beta headers
4. 请求上游 `api.anthropic.com/v1/messages`
5. 响应回传给客户端
6. 同时把 quota 和 usage 写回当前账户

## 8. 为什么这个方案适合当前仓库

这次没有把仓库重构成完整后台框架，原因很现实：

- 目标是补管理能力，不是重写项目
- 仓库已经能跑，应该优先保留其低依赖和可直接执行的特性
- 静态 dashboard 足够满足当前“查看额度 + 管理账户”需求
- `accounts.json` 方案便于迁移，不要求引入数据库

从维护视角看，这样做的优点是：

- 修改范围集中
- 不破坏既有代理行为
- 兼容老的 token 文件
- 测试仍然保持轻量

## 9. 这次新增或强化的测试

为了避免这次改造只停留在“页面能打开”，我补了几类测试：

- [server/quota.test.js](/root/ai-proxy/claude-code-proxy/server/quota.test.js:1)
  - 验证 unified / classic rate-limit 头解析
- [server/AccountStore.test.js](/root/ai-proxy/claude-code-proxy/server/AccountStore.test.js:1)
  - 验证账户创建、激活、删除、legacy token 同步
- 原有 `OAuthManager.test.js` / `server.test.js` / `ClaudeRequest.test.js`
  - 继续覆盖 OAuth、代理和路由主路径

## 10. 当前已知限制

这个版本已经能满足“额度查看 + 账户管理”，但有几个边界要明确：

### 1. 不是 Anthropic 官方账单面板

这里的 quota 是真实的，但账单不是官方 Usage API。

原因是当前 OAuth token 对 Admin Usage / Organization 类接口没有权限。

### 2. 本地 usage 只统计经过本代理的请求

如果同一个账户在别处也在用，这里不会自动看到外部流量。

### 3. quota 刷新本质上会消耗一次极小请求

虽然 `max_tokens=1` 已经很轻，但它不是零成本。

### 4. 没有账号级权限系统

当前 dashboard 默认是本机/本服务可见，不带单独登录鉴权。

## 11. 后续可继续演进的方向

如果后面要继续做，可以考虑：

- 给 dashboard 增加简单密码或反向代理鉴权
- 记录更细粒度的请求日志
- 把 preset 使用情况也纳入统计
- 支持导入/导出 `accounts.json`
- 如果后续 Anthropic 放开权限，再接入官方 Usage / Cost API
- 如果 UI 继续变复杂，再考虑迁移到构建型前端

## 12. 一句话总结

原始 `claude-code-proxy` 的强项是“把 Claude OAuth / Claude Code 凭据包装成一个可用的 Anthropic messages 代理”；这次新增的管理台并没有改变它的核心代理模型，而是在不引入重型依赖的前提下，为它补上了：

- 多账户
- 当前账户切换
- 真正来自上游响应头的额度视图
- 本地 usage 聚合
- 一套可直接访问的内置 dashboard

这也是这次改造的核心原则：**增强可观测性和可运维性，但不破坏原有代理能力和部署方式。**
