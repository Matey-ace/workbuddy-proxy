# WorkBuddy Proxy

将本机 WorkBuddy 登录会话接入 OpenAI、Anthropic 和 Ollama 兼容接口的本地代理，附带浏览器管理台、模型目录、调用记录和网页适配模式。

本仓库保存软件源码、启动脚本、示例配置和项目资料。每台机器的登录态、密钥、证书、请求记录及个人配置均保留在本机。

## 功能

| 功能 | 当前实现 |
| --- | --- |
| OpenAI 兼容接口 | `/v1/chat/completions`、`/v1/models`；`/v1/completions` 转换到聊天接口 |
| Anthropic 兼容接口 | `/v1/messages`，另有 `/anthropic/v1/messages` 别名 |
| Ollama 兼容接口 | `/api/chat`、`/api/generate`、`/api/tags`、`/api/version` |
| 流式响应 | SSE / NDJSON；支持非流式聚合 |
| 原生直连 | 读取本机 WorkBuddy 登录资料，支持国内版和国际版 |
| 网页适配 | Cookie / Bearer、可配上游路径、响应字段路径、会话映射 |
| 工具调用 | 原生模式转发上游工具协议；网页模式通过提示词和增量解析器适配 |
| 管理台 | 配置、模型与额度、账号池、调用记录、日志、本机发现、抓包 |
| 运行辅助 | 并发队列、Windows 一键启动与可选开机自启 |

这些是兼容接口，具体参数和模型能力取决于适配层与上游。模型名称、数量、积分倍率和促销信息以运行时目录为准。

## 环境要求

- 本次验证使用 **Node.js 24.16.0**。当前锁定的 Playwright 依赖要求 Node.js 20 及以上；`package.json` 中的 `>=18` 是现有声明。
- Windows 是当前一键启动、本机发现和桌面登录集成的主要环境。
- 原生模式需要在本机安装并登录对应版本的 WorkBuddy。
- HTTPS 抓包使用 OpenSSL；仅在选择该功能时需要准备。
- Playwright 登录需要另行安装 Chromium；普通代理启动无需下载浏览器。

## 快速开始

```powershell
git clone https://github.com/Matey-ace/workbuddy-proxy.git
cd workbuddy-proxy
npm ci
npm start
```

打开管理台：<http://127.0.0.1:8787>。默认只监听本机，默认 API Key 为 `sk-workbuddy-local`，管理台默认没有口令。

Windows 也可以双击 `一键启动.bat`：首次安装依赖，后台启动并打开管理台。`启动.bat` 在前台显示日志。

默认尝试原生直连；进入管理台检查本机发现、登录状态和模型目录，再从目录选择实际可用的模型。原生凭据就绪与否取决于桌面版本、登录状态和本机存储格式。

### 配置方式

**程序不会自动加载 `.env`。** `.env.example` 是变量说明。请在启动终端设置环境变量；也可显式加载：

```powershell
Copy-Item .env.example .env
# 编辑 .env，填写适合本机的配置；占位的网页域名只用于说明。
node --env-file=.env src/server.js
```

直接设置变量的例子：

```powershell
$env:API_KEY = 'replace-with-your-local-key'
$env:ADMIN_PASSWORD = 'replace-with-your-admin-password'
$env:WB_REGION = 'cn'
npm start
```

管理台保存的上游配置写入根目录 `config.json`。网页模式也可以从 `config.example.json` 复制并编辑；示例中的域名和模型别名需要替换。部分配置需重启生效，字段优先级的现有限制见 [项目资料](docs/PROJECT_GUIDE.md)。

## API 使用

先读取模型目录：

```powershell
$headers = @{ Authorization = 'Bearer sk-workbuddy-local' }
Invoke-RestMethod http://127.0.0.1:8787/v1/models -Headers $headers
```

将返回的模型 ID 填入请求：

```powershell
$body = @{
  model = 'MODEL_ID_FROM_CATALOG'
  messages = @(@{ role = 'user'; content = '你好' })
  stream = $false
} | ConvertTo-Json -Depth 10

Invoke-RestMethod http://127.0.0.1:8787/v1/chat/completions `
  -Method Post -Headers $headers -ContentType 'application/json' -Body $body
```

Python OpenAI SDK 客户端示例（自行安装 `openai`）：

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="sk-workbuddy-local",
)
model_id = client.models.list().data[0].id
reply = client.chat.completions.create(
    model=model_id,
    messages=[{"role": "user", "content": "你好"}],
)
print(reply.choices[0].message.content)
```

| 客户端协议 | Base URL | 请求鉴权 |
| --- | --- | --- |
| OpenAI 兼容客户端 | `http://127.0.0.1:8787/v1` | `Authorization: Bearer <API_KEY>` |
| Anthropic 兼容客户端 | `http://127.0.0.1:8787` | `x-api-key: <API_KEY>` 或 Bearer |
| Ollama 兼容客户端 | `http://127.0.0.1:8787` | 对话接口同样需要 API Key |

客户端是否支持自定义地址和请求头，以其实际配置为准。Ollama 模型列表与版本接口公开可读。

## 国内版与国际版

启动时用 `WB_REGION=cn` 选择国内版，`WB_REGION=ai` 选择国际版。更改默认上游后重启服务。

管理台和原生管理接口可通过 `?region=cn` 或 `?region=ai` 分别查询状态、模型与额度，例如 `/api/native/catalog?region=ai`。查询区域不会改变服务启动时选择的默认区域。

国际版适配会补充缺少的 system 消息，并在需要时将上游流式结果聚合为非流式响应。具体可用模型请查询对应区域目录。

## 网页适配与账号池

原生模式不适用时，可设置 `WB_UPSTREAM_MODE=web`，配置真实网页接口和登录信息：

1. 在管理台保存上游地址、聊天路径和可选的响应字段路径。
2. 导入本机账号的 Cookie / Bearer，或配置 `data/accounts.json`。
3. 通过管理台连通性探测确认返回结构，再接入客户端。

账号池格式见 [accounts.example.json](data/accounts.example.json)，支持 `weight` 和 `enabled`；401/403 会影响账号启用状态。网页模式工具调用依赖模型遵循提示词，效果需按目标模型验证。

抓包功能是可选项：管理台可启停本地代理（默认端口 `8899`），本地证书保存在 `certs/`。只将需要调试的浏览器流量交给该代理，调试结束后恢复代理配置。仓库不包含已生成证书或私钥。

## 常用变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | HTTP 监听地址与端口 |
| `API_KEY` | `sk-workbuddy-local` | 对话 API 密钥 |
| `ADMIN_PASSWORD` | 空 | 管理接口口令，设置后启用认证 |
| `WB_UPSTREAM_MODE` | `auto` | `auto` / `native` / `web` |
| `WB_REGION` | `cn` | 默认上游区域：`cn` / `ai` |
| `MAX_CONCURRENCY` | `8` | 请求并发上限 |
| `TIMEOUT_MS` | `300000` | 上游超时 |
| `WB_DATA_DIR` | 项目下 `data/` | 运行数据目录 |
| `WB_BASE` / `WB_CHAT_PATH` | 示例占位域名 / `/api/chat` | 网页上游地址与聊天路径 |
| `WB_DELTA` / `WB_REASONING` | 空 | 网页响应字段路径 |
| `WB_MODEL_ALIAS` | 空 JSON 对象 | 网页模式模型别名 |
| `WB_SNIFF_PORT` | `8899` | 抓包代理默认端口 |
| `WORKBUDDY_AUTH_FILE` | 自动发现 | 原生登录资料路径覆盖 |
| `WORKBUDDY_AI_AUTH_FILE` | 自动发现 | 国际版登录资料路径覆盖 |

更多变量见 [.env.example](.env.example) 与 [项目资料](docs/PROJECT_GUIDE.md)。默认密钥只适合本机试用；如调整监听地址，应同时设置自己的 API Key、管理口令及访问来源限制。调用记录包含完整对话内容，应按本机数据管理。

## 验证与维护

```powershell
npm run selftest          # 工具调用解析器
node scripts/e2e.js       # 本地模拟上游，三套协议与鉴权
node scripts/live.js      # 已启动服务的真实上游验证，会发起模型调用
```

本次整理的验证范围与结果见 [验证记录](docs/VERIFICATION.md)。模拟测试通过不代表真实账号、余额或全部模型已验证。

Windows 可选自启：`node scripts/autostart.js enable`；查看：`status`；关闭：`disable`。

## 项目结构与资料

```text
src/                        服务、协议、上游、登录集成、队列与记录
public/index.html           浏览器管理台
scripts/                    启动、自启、证书、导入、测试与压测
data/accounts.example.json  账号池格式示例
config.example.json         网页上游配置示例
.env.example                环境变量参考
docs/PROJECT_GUIDE.md        架构、配置、接口、维护和上传边界
docs/VERIFICATION.md         本次验证记录
```

运行数据、`data-e2e/`、`certs/`、`config.json`、`.env`、`node_modules/`、本机研究工作台 `tools/` 已排除上传，其中仅保留账号池示例。

当前仓库未设置开源许可证；第三方依赖保留各自许可证。原生登录存储适配的实现参考信息见 [项目资料](docs/PROJECT_GUIDE.md)。
