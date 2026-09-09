# Command Code 反代网关

## 项目概述

Command Code (commandcode.ai) 的本地反向代理网关。接收下游 OpenAI 兼容请求（`/v1/chat/completions`），转换为上游 Command Code 专有 wire 协议，再将流式 SSE 响应转回标准 OpenAI 格式返回给客户端（ZCode、Cursor 等）。

## 核心文件

- `cmdc-server.mjs` — 唯一源码文件，纯 Node.js（零依赖），约 2200 行
- `README.md` — 项目规范文档（描述了 Tauri 桌面应用的规划，但当前实际实现为单文件 Node.js 服务）

## 运行与部署

- **PM2 托管**，应用名 `cmdc-hub`，监听 `127.0.0.1:8888`
- 重启方式：`pm2 restart cmdc-hub`（**不要**手动 kill，PM2 会自动拉起）
- 端口冲突时自动递增（EADDRINUSE → port+1）
- 凭据来源：`~/.commandcode/auth.json`（apiKey / userId / userName）

## 架构要点

### 请求流转

```
客户端 (ZCode/Cursor) → POST /v1/chat/completions
  → adaptOpenAiMessagesToWire()  转换消息格式
  → adaptOpenAiToolsToWire()     转换工具定义
  → fetch(api.commandcode.ai/alpha/generate)  上游调用
  → 解析上游 SSE 流 (text-delta / tool-call / finish)
  → 重新封装为标准 OpenAI SSE chunk 返回客户端
```

### 上游 Wire 协议关键约束

- **System prompt** 必须放在 `params.system`，**不能**混入 `params.messages`（否则 400 错误）
- `params.messages[i].content` **必须是数组** `[{type: "text", text: ...}]`，不能是原始字符串
- 消息角色只允许 `user` / `assistant` / `tool`，不允许 `system`
- 上游网关有 **60 秒空闲超时**：推理模型思考期间 SSE 流静默会被掐断
- 上游事件流为自定义 JSON，类型包括 `start` / `start-step` / `reasoning-start` / `reasoning-delta` /
  `reasoning-end` / `text-start` / `text-delta` / `text-end` / `tool-call` / `finish-step` / `finish` /
  `provider-metadata` / `error`
- `finish.totalUsage` 带完整明细：`inputTokenDetails.cacheReadTokens`（缓存命中）、
  `outputTokenDetails.reasoningTokens`（思考消耗）、`cachedInputTokens`
- 上游默认已启用 `caching:auto` 与 `sort:ttft` 路由
- 实测接受的调优参数：`temperature` / `top_p` / `top_k` / `reasoning_effort` /
  `presence_penalty` / `frequency_penalty` / `stop` / `seed`。
  其中 `reasoning_effort:'low'` 能把思考 token 压到 0，是压首字延迟最有效的开关

### 首字延迟优化

- **上游长连接池**（`upstreamAgent`）：冷连接握手约 1150ms（TCP 215ms + TLS 250~1000ms），
  复用后约 400ms。Node 内建 `fetch` 的连接池空闲 4s 即回收，而 agent 场景两次请求间隔常超过 4s，
  因此改用 `https.request` + 自管 `https.Agent`（`keepAlive:true`）
- 启动时预热一条连接，空闲超过 60s 自动补预热
- 客户端与上游 socket 均 `setNoDelay(true)`，避免 Nagle 攒包给每帧加延迟
- 剩余的首字时间基本是上游推理耗时，代理侧已无可压缩空间

### 断流处理：单轮重试 + 跨轮续传

分两层，取决于本轮是否已经向客户端吐出正文：

- **本轮未吐正文** → 内部重试（最多 3 次，间隔 1.5s），客户端完全无感
- **本轮已吐正文** → 不能重试（会重复），改走**自动续传**：把已产出正文作为 assistant 预填
  重新发起上游请求，接着往下写，全程复用同一条 SSE 流。最多 5 轮

续传的两个触发条件：中途断流且已产出正文、或 `finishReason:length` 被截断。
有工具调用时不续传（结构化参数重新生成容易前后矛盾）。

**续传衔接**：只做 assistant 预填不够——实测模型会把预填当成已完成回合，从头重写整篇。
因此额外追加一条明确的「接着写」用户指令，并在续传轮开头攒够 400 字后做衔接判定：
- 检测到重开头（新内容以已产出内容的开头起始）→ 丢弃该段并结束回答，避免吐重复内容
- 检测到尾部重叠 → 裁掉重复部分再输出

其他：可重试状态码 408/409/429/500/502/503/504；握手 60s 兜底超时；
客户端断开时立即中止上游拉流；静默期每 15s 发一次 SSE 注释行心跳保活。

### 其他兼容性要点

- `finish_reason` 一律归一到 OpenAI 标准值 `stop` / `length` / `tool_calls`（不能用 Anthropic 的 `end_turn`）
- 思考内容走 `delta.reasoning_content`，不混进 `delta.content`
- `max_tokens` 缺省取模型目录里的 `maxTokens`（上限非消耗量，填大不额外扣费），
  客户端传值时取二者较小值
- 请求体按 Buffer 收集后统一解码，避免多字节 UTF-8 字符在 chunk 边界被劈开

### UI 面板

首页（`/`）渲染完整 Dashboard HTML，包含：
- 终端状态监控与实时日志（轮询 `/api/logs`），含首字延迟 / 缓存命中率 / 思考正文比 / 续传轮次
- 额度用量看板（5 小时 / 周 / 月限额）
- 全模型额度容量对比柱状图（支持搜索筛选）
- 模型列表表格（40+ 款模型，含价格、上下文、最大输出）

API 端点：
- `GET /api/usage` — 实时额度数据
- `GET /api/logs` — 终端日志与统计
- `POST /api/logs/clear` — 清空日志
- `GET /v1/models` — 模型列表
- `POST /v1/chat/completions` — 核心代理接口

## 编码规范

- 语言：JavaScript (ES Module)，Node.js ≥ 18
- 零外部依赖，仅使用 `http`、`fs`、`os`、`path`、`crypto` 内置模块
- 注释使用中文
- 日志通过内存环形队列 `recentLogs` 缓存（最多 60 条），不落盘
- 进程级异常守护（`uncaughtException` / `unhandledRejection`）防止单次请求异常拖垮服务

## 已知注意事项

- 上游 API 凭据 `~/.commandcode/auth.json` 必须存在且有效，否则代理无法工作
- 模型目录 `ALL_MODELS` 中部分模型的 `maxTokens` 标注了"必须填对"（如 DeepSeek 系列为 200000），客户端必须设置正确值
- 非流式请求（`stream: false`）也支持，但主要场景为流式 SSE
- 上游 SSE 事件格式为自定义 JSON（非标准 OpenAI SSE），需经 `handleLine` 逐行解析转换
