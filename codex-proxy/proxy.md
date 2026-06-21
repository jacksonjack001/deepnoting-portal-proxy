# Codex Proxy 项目详解

## 1. 这是什么项目

`codex-proxy` 本质上是一个 **本地 AI 网关 / 协议转换层**。它把 OpenAI Codex Desktop 使用的后端能力，重新包装成多种常见 API 形态，然后暴露给外部客户端使用。

从代码和 README 可以看出，它主要做三件事：

1. **对接 Codex / ChatGPT 上游后端**
2. **把上游的 Codex Responses 协议翻译成 OpenAI / Anthropic / Gemini / Ollama 风格接口**
3. **提供一个本地 Web Dashboard 和可选 Electron 壳层，方便管理账号、代理、模型和用量**

项目入口是 `src/index.ts`，启动时会加载配置、TLS 指纹、账号池、代理池、模型池、Dashboard 路由，再启动本地 Hono HTTP 服务。

## 2. 项目的核心定位

如果用一句话概括：

> 它不是“另一个模型服务”，而是一个 **复刻 Codex Desktop 客户端行为、再向外转协议** 的中间层。

也就是说，这个项目自己不训练模型，也不真正提供推理能力。真正的推理能力来自：

- OpenAI 的 Codex / ChatGPT 上游后端
- 或者用户额外配置的第三方 Provider（OpenAI / Anthropic / Gemini / OpenRouter / 自定义 OpenAI-compatible）

这也是为什么它内部有一个非常重要的模块：`UpstreamRouter`。这个路由器会决定某个 `model` 最终要走：

- 运行时 API key 池
- 显式 Provider
- 自定义模型路由
- 还是默认 Codex 路径

可以看 `src/proxy/upstream-router.ts` 的优先级注释，里面把整个路由策略写得很清楚。

## 3. 它对外暴露了什么能力

这个项目对外暴露的不是单一接口，而是一组兼容层：

- OpenAI Chat Completions：`/v1/chat/completions`
- Anthropic Messages：`/v1/messages`
- Gemini 风格：`/v1beta/models/...`
- Codex 原生 Responses：`/v1/responses`
- Embeddings / Models / Admin / Dashboard 等辅助接口
- 可选 Ollama Bridge

相关路由入口在：

- `src/routes/chat.ts`
- `src/routes/messages.ts`
- `src/routes/gemini.ts`
- `src/routes/responses.ts`
- `src/routes/models.ts`
- `src/routes/web.ts`

对应的协议翻译器在：

- `src/translation/openai-to-codex.ts`
- `src/translation/codex-to-openai.ts`
- `src/translation/anthropic-to-codex.ts`
- `src/translation/codex-to-anthropic.ts`
- `src/translation/gemini-to-codex.ts`
- `src/translation/codex-to-gemini.ts`

所以你可以把它理解成一个“**多协议入口 + 单/多上游出口**”的编排层。

## 4. 启动架构：服务是怎么起来的

### 4.1 启动入口

启动核心在 `src/index.ts`。

服务启动时大致流程是：

1. 加载 `config/default.yaml` 和 `data/local.yaml`
2. 加载 `config/fingerprint.yaml`
3. 加载静态模型配置
4. 初始化代理检测
5. 初始化原生 TLS 传输层
6. 初始化上下文、账号池、刷新器、CookieJar、ProxyPool
7. 注册所有 API 路由和 Web Dashboard
8. 启动 HTTP 服务
9. 启动后台任务：模型刷新、配额快照、代理健康检查、自更新检查等

这里能看出项目不是“只有一个转发函数”，而是一套比较完整的本地服务。

### 4.2 配置系统

配置系统的结构比较清晰：

- 默认配置：`config/default.yaml`
- 指纹配置：`config/fingerprint.yaml`
- 本地覆盖：`data/local.yaml`
- 运行时落盘状态：`data/` 下若干 JSON / YAML

`src/config-loader.ts` 会自动创建 `data/local.yaml`，并把本地覆盖 merge 进默认配置。`src/config.ts` 再把它们解析成强类型配置，并提供热重载入口。

因此这套系统支持：

- 默认配置跟随仓库
- 本地用户配置独立覆盖
- 更新后热重载
- Electron / CLI 共用同一套配置读取逻辑

### 4.3 Electron 和 CLI 复用同一套后端

这个仓库有两种典型运行方式：

- **CLI/Node 服务模式**：直接 `npm run dev` / `npm start`
- **Electron 桌面壳模式**：通过 `packages/electron/electron/main.ts` 把同一个后端嵌进去

Electron 主进程做的事情非常关键：

1. 先决定用户数据目录和资源目录
2. 动态导入打包后的后端 `server.mjs`
3. 调 `setPaths()` 改写后端的 `config/ data/ public/ bin/` 路径
4. 再调用同一个 `startServer()` 启动本地服务
5. 浏览器窗口加载 `http://127.0.0.1:<port>/`

也就是说，Electron 不是另一套实现，而是 **把同一个 Hono 后端包进了一个桌面壳**。

## 5. 一次请求是如何被处理的

下面以 `POST /v1/chat/completions` 为例。

### 5.1 第 1 层：入口路由

`src/routes/chat.ts` 做的事情包括：

- 解析 JSON
- 用 `zod` 校验请求体
- 判断模型应该路由到哪里
- 把 OpenAI 请求翻译成 Codex 请求
- 记录 ingress 日志
- 如果是第三方上游，就走 direct handler
- 如果是 Codex 路径，就走 account pool + proxy handler

这一层已经体现出项目的核心设计：

> 对外是 OpenAI 风格接口，对内统一收敛为 Codex 请求对象，再交给上游执行层。

### 5.2 第 2 层：协议翻译

例如 OpenAI Chat Completions 会先通过 `src/translation/openai-to-codex.ts` 变成 Codex Responses 请求。

翻译内容不仅仅是 `messages -> input`，还包含：

- 工具调用 / function calling
- structured outputs
- reasoning effort
- 流式响应格式
- tuple schema 等兼容逻辑

反向输出时，`src/translation/codex-to-openai.ts` 会把 Codex 的事件流重新组织成 OpenAI SSE chunk。

这部分是项目非常重的“协议适配层”。

### 5.3 第 3 层：上游选择

`UpstreamRouter` 会按优先级决定请求去哪里：

1. 运行时 API key 池精确命中模型
2. 显式 provider 前缀，如 `openai:gpt-4o`
3. alias
4. `model_routing`
5. 已知 Codex 模型
6. 内建模式匹配
7. 默认 Codex

这说明该项目不是死板地“只转发给 Codex”，而是支持 **一部分模型走 Codex，一部分模型走第三方 Provider**。

### 5.4 第 4 层：Codex 代理执行

如果最终走的是 Codex，上游处理会进入 `src/routes/shared/proxy-handler.ts`。

这个 handler 不是单函数，而是一整个状态机/流程编排器，负责：

- 获取账号
- 构建 CodexApi 实例
- 处理 turn state / prompt cache / session affinity
- 失败重试
- 账号切换
- 流式输出
- 非流式收集
- 错误分类与状态更新
- 请求日志和诊断

该模块拆得很细，说明项目在“真实代理场景下的异常恢复”上投入很多。

### 5.5 第 5 层：真正请求上游

真正对上游发请求的是 `src/proxy/codex-api.ts`。

它会把请求发往：

- `POST /backend-api/codex/responses`
- `POST /backend-api/codex/responses/compact`
- WebSocket `.../codex/responses`

它还会注入一组 Codex / Desktop 风格头部和 metadata，例如：

- `Authorization`
- `ChatGPT-Account-Id`
- `originator`
- `x-openai-internal-codex-residency`
- `x-client-request-id`
- `x-codex-installation-id`
- `x-codex-turn-state`
- `x-codex-window-id`
- `OpenAI-Beta: responses_websockets=...`

上游返回后，再由翻译层重新包装成 OpenAI / Anthropic / Gemini 风格响应。

## 6. 它为什么“可以接上 Desktop”

这是这个项目最关键的问题。

先说结论：

> 它并不是“注入官方 Desktop 进程”或者“劫持本地桌面应用 IPC”，而是 **在网络协议层把自己伪装成一个足够像 Codex Desktop 的客户端**。

它之所以能工作，靠的是下面几层“对齐”。

### 6.1 认证层对齐：直接走 Codex / OpenAI 的 OAuth PKCE

`src/auth/oauth-pkce.ts` 实现了原生 OAuth PKCE 登录，而不是依赖外部 Codex CLI。

它会：

- 生成 PKCE challenge
- 使用配置中的 `oauth_client_id`
- 请求 OpenAI/Auth0 授权页面
- 交换 access token / refresh token
- 后续按 refresh token 刷新 access token

配置里的 `oauth_client_id`、授权端点、token 端点都在 `config/default.yaml`。

这意味着它不是“伪造一个完全假的账号系统”，而是直接走 **真实 OpenAI 登录链路**，拿到真实可用的 token。

### 6.2 协议层对齐：请求目标和字段形状对齐 Desktop

`src/proxy/codex-api.ts` 里把真正的目标地址定到了 `https://chatgpt.com/backend-api` 这一族接口，并且请求体、头部、client metadata 都尽量与 Desktop 保持一致。

它还处理：

- `turnState`
- `conversationId`
- `windowId`
- `parentThreadId`
- `turnMetadata`
- `betaFeatures`

所以本质上它是在说：

> “我不是 OpenAI 公共 API 的普通客户端；我是一个会说 Codex Desktop 那套语言的客户端。”

### 6.3 指纹层对齐：User-Agent、sec-ch-ua、header order 对齐

`src/fingerprint/manager.ts` 和 `config/fingerprint.yaml` 负责构造“看起来像 Desktop”的请求头。

包括：

- `User-Agent` 模板：`Codex Desktop/{version} ({platform}; {arch})`
- `sec-ch-ua`
- `Accept-Encoding`
- `Accept-Language`
- `sec-fetch-*`
- header 的顺序

这里甚至连 **header 排序** 都显式控制了，而不是只关心字段存在与否。这说明作者关注的是“客户端画像”整体相似性，而不只是功能可用。

### 6.4 TLS 层对齐：原生 Rust addon 模拟 Desktop 的 TLS 特征

`src/tls/transport.ts` 只认原生 transport，真正实现放在 `src/tls/native-transport.ts` 和 `native/src/lib.rs`。

README 和代码注释都明确写了：

- 使用 `reqwest + rustls`
- 依赖版本被锁定
- 目标是让 TLS 指纹尽量贴近真实 Codex Desktop

这一步非常关键，因为很多系统不会只看 HTTP 头，还会看：

- TLS ClientHello 特征
- ALPN / cipher suite 组合
- HTTP/2 / WebSocket 细节

所以这个项目能接近 Desktop，不只是因为它会发 `User-Agent`，而是因为它把 **网络栈也尽量做成同一类客户端**。

### 6.5 会话层对齐：复用 installation_id、turn state、长连接

项目会维护稳定的 installation id，见 `src/proxy/installation-id.ts`。

它的查找顺序很有意思：

1. 先读 `~/.codex/installation_id`
2. 再读自己 `data/installation_id`
3. 最后才自己生成

这意味着如果用户本机本来就有 Codex 生态留下的 installation id，项目会优先复用。

再往上，项目还会：

- 在请求头和 `client_metadata` 都写入 `x-codex-installation-id`
- 回传并复用 `x-codex-turn-state`
- 用 `(entryId, conversationId)` 维度复用上游 WebSocket 连接

`src/proxy/ws-pool.ts` 的注释甚至直接解释了原因：

- 上游 WebSocket LB 会把同一连接稳定路由到同一 backend
- 这样 prompt cache 更热
- 这和真实 Codex CLI/桌面端的长连接复用策略是一致的

所以它不只是“能发请求”，而是努力保持 **像真实桌面端那样的会话连续性**。

### 6.6 版本/Prompt/模型层对齐：从 Desktop 包里提取指纹

项目最有代表性的机制之一，是 `scripts/build/extract-fingerprint.ts` 和 `scripts/build/full-update.ts`。

它们会：

1. 接收一个本地 `Codex.app` 或解包后的 `app.asar`
2. 从 ASAR 里提取：
   - 版本号
   - build number
   - electron 版本
   - `originator`
   - API base URL
   - 模型 ID
   - WHAM endpoint
   - system prompts
3. 输出抽取结果
4. 再通过 `apply-update` 把这些结果更新回本仓库配置

也就是说，这个项目并不是手写一套永远不变的“假 Desktop 配置”，而是建立了一条：

> **从真实 Desktop 安装包 -> 提取指纹/Prompt/模型 -> 回灌到代理配置**

的更新链路。

这就是它长期能跟着 Desktop 版本变化一起演进的核心原因。

## 7. 它不是怎么实现的

为了避免误解，这里也要明确说清楚：

### 7.1 它不是本地 IPC 劫持

从仓库代码看，这个项目没有去 hook 官方 Codex Desktop 的本地进程通信，也没有在本机开一个“假冒桌面应用的内嵌接口”让官方桌面端调用。

它的主路径是：

- 自己启动本地 Hono 服务
- 自己走 OAuth
- 自己直接访问上游 `chatgpt.com/backend-api`

所以严格说，它是 **模拟 Desktop 的网络客户端**，不是“侵入 Desktop 进程内部”。

### 7.2 它不是修改官方桌面应用二进制

更新脚本会读取本地 `app.asar`，但目的是：

- 提取版本与指纹
- 更新自己的配置

而不是去 patch 官方程序。

### 7.3 它不是单纯的 HTTP Header 伪装

如果只是伪造 `User-Agent`，这个项目不会有：

- 原生 Rust TLS addon
- 安装 ID 复用
- WebSocket 会话池
- turn state 复用
- Desktop prompt / endpoint / model 抽取链路

所以它的实现深度明显比“改几个请求头”更深。

## 8. 账号、Cookie、代理、模型是怎么管理的

### 8.1 账号池

`src/auth/account-pool.ts` 负责统一管理账号生命周期，包含：

- 多账号存储
- 轮换策略
- 失效、封禁、429 状态管理
- token 刷新后的 WS 驱逐
- quota / usage 记录

这说明它并不把账号当“单 token 字符串”，而是有完整的状态机。

### 8.2 Refresh Scheduler

`RefreshScheduler` 负责在 token 过期前刷新，且当请求过程中遇到 401 时还能触发即时刷新。

这样做是为了避免长期运行时大量请求因 token 过期失败。

### 8.3 CookieJar

`CookieJar` 会捕获并回放 Cloudflare / 上游相关 cookie。

这和前面 TLS / header 指纹一起，构成“客户端像真度”的一部分。

### 8.4 ProxyPool

项目支持：

- 全局代理
- 每账号代理
- 代理健康检查
- 直连回退

这一层不是附属功能，而是很多认证链路和上游请求链路的一部分。

### 8.5 ModelFetcher

`src/models/model-fetcher.ts` 会按 plan 去上游拉真实模型列表，再覆盖本地静态模型配置。

所以模型目录不是纯静态写死，而是：

- 静态 `config/models.yaml` 作为基线
- 运行时从真实后端拉取，按账号 plan 合并

## 9. Dashboard 和桌面壳做了什么

### 9.1 Dashboard

这个项目不是只有 API，还带了一套 Web 控制台。它能做：

- 登录
- 管理账号
- 查看模型目录
- 管理 API key 池
- 查看日志
- 查看连接状态和健康度
- 管理代理
- 调整设置

`src/routes/web.ts` 是 Web 入口，其它 `src/routes/admin/*` 则是控制面板后端接口。

### 9.2 Dashboard 鉴权

Dashboard 登录用的不是另一套独立用户系统，而是复用 `proxy_api_key` 作为 Dashboard 密码。这样本地部署时省掉了一层复杂的用户管理。

### 9.3 Electron 壳

Electron 壳层的定位不是“官方 Desktop 插件”，而是：

- 把本代理打包成一个独立桌面应用
- 同时带上 tray、窗口、自动更新能力
- 让普通用户不用自己手动起 Node 服务

所以 `packages/electron` 更像是 **Codex Proxy 的桌面发行版**，不是对官方 Codex Desktop 的嵌入模块。

## 10. 这个项目真正高价值的地方

我认为它最有技术含量的部分有四块：

### 10.1 协议翻译层

它不是简单转发，而是认真做了：

- OpenAI ↔ Codex
- Anthropic ↔ Codex
- Gemini ↔ Codex
- 工具调用 / structured outputs / 流式事件重组

### 10.2 上游“像真度”

项目把对齐做到了多层：

- OAuth
- header
- header order
- UA
- TLS
- installation id
- WebSocket 会话策略
- prompt / version / endpoint 抽取

这决定了它不是“粗糙模拟”，而是“尽量复刻”。

### 10.3 多账号 / 多上游编排

它内部其实实现了一个比较完整的“本地推理网关控制面”。

尤其是账号池、代理池、API key 池、模型路由，这些拼起来已经接近一个小型 AI Gateway。

### 10.4 与官方版本保持同步的更新链

很多类似项目只能在某个版本上工作；这个项目专门做了：

- appcast 检查
- 本地 ASAR 指纹提取
- 配置热更新

这是它可持续维护的基础设施。

## 11. 这个项目的边界和脆弱点

再强的实现，也有边界：

### 11.1 强依赖上游协议稳定性

一旦 Codex Desktop 上游：

- 改 OAuth 细节
- 改请求头
- 改 TLS 指纹敏感点
- 改 event schema
- 改系统 Prompt 注入方式

这个代理就需要同步更新。

### 11.2 指纹提取链需要维护

`config/extraction-patterns.yaml` 里使用了针对打包 JS 的 regex / marker。桌面端打包结构一变，提取脚本就可能失效，需要更新模式。

### 11.3 它复刻的是“行为”，不是官方内部实现

即使已经很像，它终究不是官方客户端源码原样运行，而是“行为复现”。

因此某些极细节、灰度逻辑、服务端实验开关，仍然可能与官方桌面端不完全一致。

## 12. 用一句话总结它的实现原理

如果只保留最核心的一句话：

> `codex-proxy` 通过 **真实 OAuth 登录 + Desktop 风格请求头/指纹/TLS + Codex 原生 Responses 协议复刻 + 多协议翻译输出**，把自己实现成了一个“足够像 Codex Desktop 的网络客户端”，再把这个能力封装成本地 OpenAI/Anthropic/Gemini/Ollama 兼容网关。

## 13. 我对“为什么它能介入 Desktop”的最终结论

更准确的说法不是“介入 Desktop”，而是：

> **它没有侵入 Desktop 进程本身，而是在网络层、认证层、指纹层和会话层复现了 Desktop 的关键行为，因此可以借用同一套上游能力。**

换句话说，它成功的关键不是“黑进去”，而是“像到足够可用”。

## 14. 关键文件索引

如果后续要继续读源码，建议按这个顺序看：

1. `README.md` —— 项目定位和支持能力
2. `src/index.ts` —— 服务启动总入口
3. `src/routes/chat.ts` —— OpenAI Chat 入口
4. `src/routes/shared/proxy-handler.ts` —— Codex 代理主流程
5. `src/proxy/codex-api.ts` —— 上游 Codex HTTP/WS 调用
6. `src/translation/*` —— 各协议互转
7. `src/fingerprint/manager.ts` —— 请求头 / 指纹构造
8. `src/tls/native-transport.ts` 与 `native/src/lib.rs` —— 原生 TLS 层
9. `src/auth/oauth-pkce.ts` —— 真实登录与刷新
10. `src/proxy/ws-pool.ts` —— 长会话与 prompt cache 复用
11. `scripts/build/extract-fingerprint.ts` —— 从 Desktop 包提取版本/Prompt/指纹
12. `packages/electron/electron/main.ts` —— 桌面壳如何复用同一后端

## 15. 附：项目的最短心智模型

你可以把它记成五层：

1. **入口层**：接 OpenAI / Anthropic / Gemini / Ollama 请求
2. **翻译层**：统一转成 Codex 请求对象
3. **路由层**：决定走 Codex 还是第三方 Provider
4. **执行层**：账号池 + 代理池 + Cookie + TLS + WS + 重试
5. **仿真层**：OAuth、UA、header、TLS、installation id、turn state、Prompt/版本提取

这五层叠起来，才构成了它“看起来像 Desktop，外面看起来又像标准 API”的能力。
