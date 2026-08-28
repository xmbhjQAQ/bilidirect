# bilidirect

B站视频直链与 XML 弹幕 API 服务。

它接收视频 BV 号，调用 B 站接口获取视频信息和临时播放地址，并提供一个带跨域响应头的 XML 弹幕转发接口。项目可以直接在本地电脑或 VPS 上使用 Node.js 运行。

> 本项目不是 B 站官方服务。请只处理你有权使用的内容，并遵守 B 站服务条款及当地法律。

## 功能

- 根据 BV 号获取视频标题、封面、时长、分P和 CID 等信息
- 获取 B 站临时视频直链，不在本服务保存或转发视频文件
- 实时转发 B 站 XML 弹幕，并补充浏览器所需的 CORS 响应头
- 支持 API key 鉴权和来源限制

请求和媒体的关系如下：

```text
浏览器 ──解析/弹幕请求──> bilidirect ──> B站接口
浏览器 <────视频直链──── B站 CDN
```

视频流不会经过本服务，只有解析请求和弹幕 XML 请求会经过本服务。

## 快速开始

### 1. 准备环境

需要 Node.js 20 或更高版本。本项目没有运行时依赖，不需要执行 `npm install`。

### 2. 获取项目

```bash
git clone https://github.com/xmbhjQAQ/bilidirect.git
cd bilidirect
```

### 3. 创建配置

```bash
cp config.example.json config.json
nano config.json
chmod 600 config.json
```

Windows PowerShell 可以使用：

```powershell
Copy-Item config.example.json config.json
notepad config.json
```

### 4. 启动服务

```bash
node server-vps.mjs
```

默认只监听本机 `127.0.0.1:8787`：

```text
http://127.0.0.1:8787/api/health
```

另开一个终端测试解析：

```bash
curl -G 'http://127.0.0.1:8787/api/parse' \
  --data-urlencode 'bvid=BV1B7411m7LV'
```

生产环境建议使用 systemd 守护进程，并通过反向代理提供 HTTPS 公网地址。不要直接暴露 Node 服务端口。

## API

以下示例假设服务地址为：

```text
https://api.example.com
```

### `GET /api/parse`

解析视频并获取播放信息。

```bash
curl -G 'https://api.example.com/api/parse' \
  --data-urlencode 'bvid=BV1B7411m7LV'
```

也支持 `POST` JSON：

```bash
curl 'https://api.example.com/api/parse' \
  -H 'Content-Type: application/json' \
  --data '{"bvid":"BV1B7411m7LV","page":1,"qn":80}'
```

参数：

| 参数 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `bvid` | 是 | - | 视频 BV 号 |
| `page` | 否 | `1` | 分P序号，也支持 `p` |
| `qn` | 否 | `80` | 清晰度，支持 `16`、`32`、`64`、`80`、`112`、`116`、`120`、`125`、`126`、`127`、`128`、`208` |
| `fnval` | 否 | `0` | `0` 请求 MP4/durl；`4048` 请求 DASH 信息 |
| `fourk` | 否 | `1` | 是否请求 4K，取值 `0` 或 `1` |
| `probe` | 否 | `1` | 是否探测直链。传 `0` 可跳过探测 |
| `key` | 按配置 | - | API key，GET 使用 query 参数，POST 可放 JSON body |

成功响应：

```json
{
  "ok": true,
  "code": 0,
  "data": {
    "bvid": "BV1B7411m7LV",
    "aid": 98647868,
    "cid": 168325345,
    "page": 1,
    "title": "视频标题",
    "duration": 590,
    "directUrl": "https://upos-...bilivideo.com/...mp4?...",
    "streamType": "durl",
    "format": "mp4",
    "quality": 80,
    "danmakuUrl": "https://api.example.com/api/danmaku?cid=168325345&bvid=BV1B7411m7LV",
    "danmukuUrl": "https://api.example.com/api/danmaku?cid=168325345&bvid=BV1B7411m7LV",
    "danmakuSourceUrl": "https://comment.bilibili.com/168325345.xml",
    "video": {},
    "playback": {}
  }
}
```

常用字段：

- `duration`：当前分P时长，单位为秒
- `cid`：当前分P CID，可用于获取弹幕
- `directUrl`：B站临时签名视频地址
- `playback.directUrlExpiresAt`：直链预计过期时间，Unix 秒级时间戳
- `danmakuUrl` / `danmukuUrl`：本服务的 XML 弹幕地址
- `danmakuSourceUrl`：B站原始 XML 地址，浏览器跨域场景应优先使用本服务地址

`directUrl` 会过期，请在需要播放时重新调用解析接口，不要把它当作永久链接保存。

### `GET /api/danmaku`

获取并转发当前分P的 XML 弹幕。

```bash
curl 'https://api.example.com/api/danmaku?cid=168325345&bvid=BV1B7411m7LV'
```

参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `cid` | 是 | 当前分P CID |
| `bvid` | 否 | 用于构造请求 B 站时的 Referer |
| `key` | 按配置 | API key |

成功响应的 `Content-Type` 为：

```text
text/xml; charset=utf-8
```

本接口不保存弹幕，也不转换 XML 内容。

### `GET /api/health`

检查服务是否能够正常响应：

```bash
curl 'https://api.example.com/api/health'
```

示例响应：

```json
{
  "ok": true,
  "service": "bilibili-direct-parser",
  "cookieConfigured": false,
  "corsEnabled": true,
  "apiKeyConfigured": true
}
```

健康检查只代表本服务在线，不代表 B 站一定允许当前出口请求；完整测试请调用 `/api/parse`。

## 鉴权与跨域

### API key

配置 `API_KEY` 后，`/api/parse` 和 `/api/danmaku` 需要鉴权。支持：

```http
X-API-Key: 你的key
```

或：

```text
?key=你的key
```

POST 请求还可以把 key 放在 JSON body 中。`/api/health` 不需要 API key。

query 参数适合临时测试，但可能出现在浏览器历史、代理记录和访问日志中；正式环境优先使用 `X-API-Key`。

### CORS

配置项：

| 配置项 | 说明 |
| --- | --- |
| `CORS_ENABLED` | 是否返回 CORS 响应头，默认开启 |
| `ALLOWED_ORIGINS` | 允许的 Origin，可填写 `*`、单个字符串或逗号分隔的多个来源 |

生产环境不要长期使用 `ALLOWED_ORIGINS: "*"`，应填写实际前端域名，例如：

```json
{
  "CORS_ENABLED": true,
  "ALLOWED_ORIGINS": ["https://www.example.com"]
}
```

## VPS 配置

复制 `config.example.json` 为 `config.json` 后修改：

```json
{
  "HOST": "127.0.0.1",
  "PORT": 8787,
  "CORS_ENABLED": true,
  "ALLOWED_ORIGINS": ["https://www.example.com"],
  "API_KEY": "",
  "BILIBILI_COOKIE": "",
  "BILIBILI_USER_AGENT": "Mozilla/5.0 ..."
}
```

| 配置项 | 说明 |
| --- | --- |
| `HOST` | Node 监听地址，默认 `127.0.0.1` |
| `PORT` | Node 监听端口，默认 `8787` |
| `API_KEY` | 非空时启用接口鉴权 |
| `BILIBILI_COOKIE` | 可选的 B站 Cookie，用于降低部分请求被 HTTP 412 拦截的概率 |
| `BILIBILI_USER_AGENT` | 请求 B 站时使用的 User-Agent |

`config.json` 仅用于本地/VPS，不要提交到 Git。Cookie 和 API key 也不要写入前端代码。

## systemd 后台运行

创建 `/etc/systemd/system/bilidirect.service`：

```ini
[Unit]
Description=Bilibili direct parser
After=network-online.target

[Service]
WorkingDirectory=/opt/bilidirect
Environment=CONFIG_FILE=/etc/bilidirect/config.json
ExecStart=/usr/bin/node /opt/bilidirect/server-vps.mjs
User=bilidirect
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

启动和查看日志：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bilidirect
sudo systemctl status bilidirect
sudo journalctl -u bilidirect -f
```

如果项目放在其他目录，请同步修改 `WorkingDirectory`、`CONFIG_FILE` 和 `ExecStart`。

## 常见错误

| HTTP | code | 说明 |
| ---: | ---: | --- |
| `400` | `-400` | 参数无效 |
| `401` | `-401` | API key 缺失或错误 |
| `404` | `-404` | 路径不存在或找不到分P |
| `502` | `-412` | B站风控返回 HTTP 412 |
| `502` | `-502` | B站接口或网络请求失败 |
| `500` | `-500` | VPS Node 服务内部异常 |

收到 HTTP 412 时，可以先检查服务器出口是否被 B 站风控；必要时在 VPS `config.json` 中配置有效的 `BILIBILI_COOKIE`。不要把 Cookie 放入公开仓库。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `worker.js` | 核心 API 逻辑 |
| `server-vps.mjs` | 将核心逻辑包装为 Node.js HTTP 服务 |
| `config.example.json` | VPS 配置模板 |

## License

详见仓库中的 `LICENSE` 文件。
