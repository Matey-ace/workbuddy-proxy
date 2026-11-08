# WorkBuddy Proxy 项目资料

整理日期：2026-11-08。资料以本次提交的本地源码为依据；历史说明中的模型数量、余额、版本兼容和实测输出不作为本次验证结论。

## 项目定位

WorkBuddy Proxy 是 Node.js ESM 本地服务，版本声明为 `1.0.0`。通过一套 HTTP 服务提供三种聊天协议和浏览器管理台，便于支持自定义 API 地址的客户端复用本机 WorkBuddy 会话。

运行时主要使用 Node.js 内置模块；唯一外部直接依赖为 Playwright，供浏览器登录脚本使用。管理台是单个 HTML 文件，没有前端构建步骤。

## 请求路径

```text
客户端 → server.js（路由 / 鉴权 / 并发队列）
       → openai.js / anthropic.js / ollama.js（协议适配）
       → 原生 workbuddy.js 或网页 upstream.js → 上游
       → 流式转换 / 非流式聚合 → 客户端

管理台 → /api/* → 配置、登录状态、目录、额度、记录和抓包
```

原生模式借助 `creddecrypt.js` 读取本机桌面登录存储，必要时调用桌面应用自身运行时处理加密字段。网页模式使用 `auth.js` 管理 Cookie / Bearer 与账号池，并由 `toolParser.js` 还原提示词式工具调用。

## 模块清单

| 文件 | 职责 |
| --- | --- |
| `src/server.js` | HTTP、静态管理台、对话与管理路由、管理登录 |
| `src/config.js` | 默认值、环境变量、用户配置、运行目录 |
| `src/openai.js` | OpenAI 响应、SSE 和工具调用适配 |
| `src/anthropic.js` | Anthropic Messages 转换 |
| `src/ollama.js` | Ollama Chat / Generate / Tags / Version |
| `src/workbuddy.js` | 原生聊天、区域、请求头、令牌刷新、模型和额度 |
| `src/creddecrypt.js` | 认证文件查找、字段解密、令牌解析 |
| `src/localdiscover.js` | 安装目录、账号摘要、版本及网关发现 |
| `src/upstream.js` | 网页请求、字段提取、会话映射、工具提示注入 |
| `src/auth.js` | 登录态、账号池、权重与失效处理 |
| `src/models.js` | 模型目录、来源、别名及持久化 |
| `src/toolParser.js` | 增量解析 JSON / 代码块式工具调用 |
| `src/queue.js` | 并发限制与排队 |
| `src/stats.js` / `src/reqlog.js` | 用量汇总与完整请求记录 |
| `src/logger.js` | 服务日志 |
| `src/mitm.js` | 可选 HTTPS 调试代理、CA 与站点证书 |
| `public/index.html` | 管理台界面与管理请求 |

## 配置与数据

程序直接读取进程环境变量，不自动读取 `.env`。使用该文件时以 `node --env-file=.env src/server.js` 启动；双击启动脚本不会主动加载它。

根目录 `config.json` 是本机配置，由管理台保存或按示例手工创建。当前实现将其 `upstream` 和 `aliases` 合并到运行配置。

现有优先级存在例外：合并逻辑以 `WB_` 加属性名大写判断环境覆盖，因此 `chatPath` 的检测名为 `WB_CHATPATH`，实际读取变量为 `WB_CHAT_PATH`；`deltaPath` 等也有类似差异。JSON 的 `aliases` 会直接覆盖 `WB_MODEL_ALIAS`。同时使用环境变量与 JSON 时避免同一字段重复配置，并核对管理台实际值。本次未重构这部分行为。

| 路径 | 内容 | 入库 |
| --- | --- | --- |
| `config.example.json` | 占位网页上游配置 | 是 |
| `.env.example` | 变量参考，示例管理口令与默认值不同 | 是 |
| `data/accounts.example.json` | 虚构账号池格式 | 是 |
| `config.json` / `.env` | 本机配置与口令 | 否 |
| `data/` 其余文件 | 登录态、缓存、调用记录、统计、截图和日志 | 否 |
| `data-e2e/` | 模拟测试文件 | 否 |
| `certs/` | CA、私钥和站点证书缓存 | 否 |
| `tools/` | 本机研究脚本、固定路径和提取的第三方片段 | 否 |
| `node_modules/` | 安装依赖 | 否，以锁文件恢复 |

请求记录 `data/requests.jsonl` 可能包含对话、工具内容和调用来源。新机器可重新安装依赖并登录；运行数据迁移需单独处理。

## 接口速查

| 方法 / 路径 | 用途 |
| --- | --- |
| `GET /health`、`/healthz` | 健康状态 |
| `GET /v1/models` | 模型列表，需 API Key |
| `POST /v1/chat/completions` | OpenAI 聊天 |
| `POST /v1/completions` | 文本输入转换为聊天请求 |
| `POST /v1/messages` | Anthropic Messages |
| `POST /api/chat`、`/api/generate` | Ollama 对话与生成，需 API Key |
| `GET /api/tags`、`/api/version` | Ollama 模型与版本，公开可读 |
| `POST /api/admin/login` | 配置管理口令后登录 |
| `GET /api/status` | 运行摘要，含本机配置摘要与 API Key |
| `GET/POST /api/config` | 查看 / 保存配置 |
| `POST /api/credentials`、`/api/accounts` | 保存单账号 / 账号池 |
| `GET /api/native/status?region=cn` | 原生登录状态 |
| `GET /api/native/catalog?region=ai` | 模型、倍率、促销、余额聚合 |
| `GET /api/native/models`、`/api/native/balance` | 分开查询目录 / 余额 |
| `POST /api/native/refresh` | 刷新指定区域令牌 |
| `GET /api/discover` | 本机发现摘要 |
| `GET /api/requests`、`/api/requests/:id` | 调用记录列表 / 详情 |
| `POST /api/probe` | 网页适配连通性探测 |
| `POST /api/sniff/start`、`/api/sniff/stop` | 启停本地抓包代理 |
| `GET /api/sniff/list`、`/api/ca` | 调试请求列表 / CA 下载 |

`ADMIN_PASSWORD` 为空时管理端不要求口令；设置后管理登录令牌或 API Key 可访问管理接口。默认监听 `127.0.0.1`，适用于本机工具；改变部署方式前应核对这些访问行为。

## 维护与排错

| 现象 | 先检查 |
| --- | --- |
| 启动失败 | Node.js、依赖、端口占用、前台日志或 `data/server.log` |
| 原生登录异常 | 对应桌面版本已登录、认证路径和区域、存储格式变化 |
| 模型失败 | 实际目录 ID、区域、额度与上游返回 |
| 配置未生效 | `.env` 显式加载、重复字段、合并例外、重启 |
| 网页内容为空 | 上游地址、聊天路径、响应结构、字段路径 |
| 工具调用不稳定 | 原生转发与网页提示适配的差异，目标模型完整调用循环 |
| 管理接口 401 | 管理口令、管理登录令牌或 API Key |
| 抓包失败 | OpenSSL、证书目录、端口和浏览器代理配置 |

原生模型目录先尝试产品配置接口，再尝试旧目录接口，最后使用内置列表。`source=fallback` 只代表兜底名称，不保证该账号具有全部模型权限。

## 验证边界与后续工作

本次用独立副本做语法检查、解析器自测和模拟端到端测试，见 [验证记录](VERIFICATION.md)。真实凭据、实际余额、真实模型调用、证书信任、自启和各客户端 UI 配置需在对应环境另行验证。

已有 e2e 最后一组只检查健康状态，并未证明上游 401 后自动切换账号；测试组标题不代表该功能已验证。后续可补充账号失效、队列取消和真实工具循环测试。

维护优先项：统一配置优先级；更新 Node.js 引擎声明；完善依赖安装失败提示；为原生登录及上游兼容增加独立夹具。这些列为后续工作，本次以整理与上传为主。

## 来源与许可

`creddecrypt.js` 和 `workbuddy.js` 注释记录了对 `dsh-connect-workbuddy 5.20.2` 的参考。本次仅记录已有说明，未做第三方来源或许可证审计，未上传本机提取的第三方应用片段。

本仓库未新增开源许可证；`package.json` 的 `private: true` 表示 npm 发布保护，与 GitHub 可见性是独立设置。首次上传选择私有仓库。依赖许可按随包声明保留。
