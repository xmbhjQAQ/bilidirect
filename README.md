# B站直链解析服务

这是一个用于获取 B 站视频元数据、临时播放直链和 XML 弹幕的 API 服务。核心逻辑位于 `worker.js`，可以部署为 Cloudflare Worker，也可以通过 `server-vps.mjs` 在 VPS 上运行。

服务本身不保存视频或弹幕文件：

- 视频由 B 站返回临时签名地址，浏览器直接请求 B 站 CDN 播放。
- 弹幕接口由本服务实时从 B 站获取 XML 并转发，只补充跨域响应头。
- `directUrl` 会过期，不能当作永久链接保存。

## API 快速索引

假设服务地址为：

```text
https://api.example.com
```

| 方法 | 路径 | 用途 | 响应类型 |
| --- | --- | --- | --- |
| `GET` | `/` | 查看服务信息和基础用法 | JSON |
| `GET` | `/api/health` | 健康检查 | JSON |
| `GET` / `POST` | `/api/parse` | 解析视频信息和播放直链 | JSON |
| `GET` | `/api/danmaku` | 获取并转发 XML 弹幕 | XML |
| `OPTIONS` | 任意路径 | CORS 预检请求 | `204` |

除 `/api/health` 外，接口是否需要 API key 由 `API_KEY` 配置决定。

## `/api/parse` 解析视频

### GET 请求

最简单的请求：

```text
GET /api/parse?bvid=BV1B7411m7LV
```

带分P、清晰度和格式参数：

```text
GET /api/parse?bvid=BV1B7411m7LV&page=1&qn=80&fnval=0&fourk=1&probe=1
```

如果服务配置了 `API_KEY`，调试时可以把 key 放在 query 参数中：

```text
GET /api/parse?bvid=BV1B7411m7LV&key=你的key
```

### POST 请求

```http
POST /api/parse
Content-Type: application/json
X-API-Key: 你的key

{
  "bvid": "BV1B7411m7LV",
  "page": 1,
  "qn": 80,
  "fnval": 0,
  "fourk": 1,
  "probe": 1
}
```

POST 也可以把 `key` 放在 JSON body 中：

```json
{
  "bvid": "BV1B7411m7LV",
  "key": "你的key",
  "page": 1
}
```

### 请求参数

| 参数 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `bvid` | 是 | 无 | B 站视频 BV 号，例如 `BV1B7411m7LV` |
| `page` | 否 | `1` | 分P序号，也支持使用别名 `p` |
| `qn` | 否 | `80` | 清晰度。支持：`16`、`32`、`64`、`80`、`112`、`116`、`120`、`125`、`126`、`127`、`128`、`208` |
| `fnval` | 否 | `0` | `0` 返回 MP4/durl；`4048` 请求 DASH |
| `fourk` | 否 | `1` | 是否请求 4K，取值 `0` 或 `1` |
| `probe` | 否 | `1` | 是否由服务端用 `Range: bytes=0-1` 检查直链。传 `0` 可跳过检查 |
| `key` | 按配置 | 无 | API key。GET 使用 query 参数，POST 可使用 JSON body |

`duration` 的单位是秒；`playback.timelength` 的单位是毫秒；`directUrlExpiresAt` 是 Unix 时间戳，单位是秒。

### 成功响应

HTTP 状态码为 `200`，响应结构如下：

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
    "description": "视频简介",
    "cover": "https://i0.hdslb.com/...jpg",
    "pic": "https://i0.hdslb.com/...jpg",
    "view": 123456,
    "playCount": 123456,
    "duration": 590,
    "directUrl": "https://upos-...bilivideo.com/...mp4?...",
    "streamType": "durl",
    "format": "mp4",
    "quality": 80,
    "danmakuUrl": "https://api.example.com/api/danmaku?bvid=BV1B7411m7LV&aid=98647868&cid=168325345&page=1",
    "danmukuUrl": "https://api.example.com/api/danmaku?bvid=BV1B7411m7LV&aid=98647868&cid=168325345&page=1",
    "danmakuSourceUrl": "https://comment.bilibili.com/168325345.xml",
    "video": {},
    "playback": {
      "apiMode": "legacy_html5",
      "streamType": "durl",
      "directUrl": "https://upos-...bilivideo.com/...mp4?...",
      "directUrlExpiresAt": 1787939199,
      "format": "mp4",
      "quality": 80,
      "timelength": 589675,
      "acceptQuality": [80, 16],
      "acceptDescription": ["高清 1080P", "流畅 360P"],
      "durl": [],
      "dash": null,
      "directProbe": {
        "status": 206,
        "ok": true,
        "contentType": "video/mp4",
        "contentRange": "bytes 0-1/125096322"
      },
      "candidates": []
    },
    "danmaku": {
      "url": "https://api.example.com/api/danmaku?bvid=BV1B7411m7LV&aid=98647868&cid=168325345&page=1",
      "sourceUrl": "https://comment.bilibili.com/168325345.xml",
      "format": "xml",
      "cid": 168325345,
      "aid": 98647868,
      "page": 1
    },
    "diagnostics": {}
  }
}
```

常用字段：

| 字段 | 说明 |
| --- | --- |
| `data.duration` | 视频总时长，单位为秒 |
| `data.cid` | 当前分P的 CID，获取弹幕时使用 |
| `data.directUrl` | B 站临时视频直链，可直接赋给 `<video>` |
| `data.playback.directUrlExpiresAt` | 直链预计过期时间 |
| `data.playback.directProbe` | 服务端直链探测结果。`206` 通常表示支持 Range 播放 |
| `data.danmukuUrl` | 本服务提供的 XML 弹幕地址 |
| `data.danmakuSourceUrl` | B 站原始 XML 地址，浏览器跨域时不建议直接使用 |
| `data.video.pages` | 所有分P的 `cid`、标题、时长和尺寸 |
| `data.video.owner` | UP 主信息 |
| `data.video.stat` | B 站统计信息 |

`video`、`playback`、`diagnostics` 中包含更完整的原始信息，客户端通常只需要 `duration`、`playback.directUrl`、`cid` 和 `danmukuUrl`。

## `/api/danmaku` 获取弹幕 XML

### 请求

```text
GET /api/danmaku?cid=168325345&bvid=BV1B7411m7LV
```

其中 `cid` 必填，`bvid` 用于构造请求 B 站时的 Referer，可选。`aid` 和 `page` 可以随链接传入，但本接口实际只依赖 `cid`。

如果配置了 API key：

```text
GET /api/danmaku?cid=168325345&bvid=BV1B7411m7LV&key=你的key
```

成功时：

- HTTP 状态码：`200`
- `Content-Type`：`text/xml; charset=utf-8`
- 响应内容：B 站 XML 原文
- 不保存文件，不转换为 JSON

使用解析接口返回的地址：

```js
const result = await fetch(
  'https://api.example.com/api/parse?bvid=BV1B7411m7LV&key=你的key'
).then((response) => response.json());

const { directUrl, duration, danmukuUrl } = result.data;
console.log('视频直链：', directUrl);
console.log('总时长（秒）：', duration);
console.log('弹幕 XML 地址：', danmukuUrl);
```

如果解析接口使用 `X-API-Key` 请求头鉴权，返回的 `danmukuUrl` 不会自动携带 key。此时需要由调用方给弹幕地址追加 key，或让弹幕请求也带上 `X-API-Key` 请求头。调试阶段可以使用解析接口的 `key` query 参数，让返回的 `danmukuUrl` 自动带上 key。query 参数可能出现在浏览器历史和服务器日志中，正式环境建议改用短期 token 或自行封装鉴权。

## `/api/health` 健康检查

```text
GET /api/health
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

健康检查只表示 Node/Worker 服务正常响应，不代表当前一定能通过 B 站风控或获取到某个视频直链。请用 `/api/parse` 做完整链路测试。

## 鉴权

配置 `API_KEY` 后，`/api/parse` 和 `/api/danmaku` 都需要鉴权。支持三种方式：

### GET query 参数

```text
?key=你的key
```

### 请求头

```http
X-API-Key: 你的key
```

### POST JSON body

```json
{
  "bvid": "BV1B7411m7LV",
  "key": "你的key"
}
```

如果没有配置 `API_KEY`，鉴权关闭，接口可以直接调用。生产环境建议配置 key，并限制 `ALLOWED_ORIGINS`。

## 错误响应和错误码

JSON 接口和弹幕接口发生错误时，响应结构统一为：

```json
{
  "ok": false,
  "code": -401,
  "message": "API key 缺失或错误",
  "details": {}
}
```

| HTTP 状态 | `code` | 含义 |
| ---: | ---: | --- |
| `400` | `-400` | 参数格式或取值错误 |
| `401` | `-401` | API key 缺失或错误 |
| `404` | `-404` | 找不到指定分P |
| `404` | `-404` | 未知路径也会返回 `Not Found` |
| `502` | `-412` | B 站 HTTP 412 风控拦截 |
| `502` | `-502` | B 站接口、弹幕接口或网络请求失败 |
| `502` | B 站返回的 code | B 站业务接口返回非零 code |
| `500` | `-500` | VPS Node 适配层内部异常 |

`details` 可能包含 B 站上游状态、请求端点、Cookie 是否配置、直链探测结果等诊断信息，客户端不应依赖其中的字段。

## 跨域和直链注意事项

`/api/parse`、`/api/health` 和 `/api/danmaku` 会按照 CORS 配置返回跨域响应头。视频直链是 B 站 CDN 地址，浏览器播放时建议：

```html
<video referrerpolicy="no-referrer" controls></video>
```

不要把 `data.danmakuSourceUrl` 直接交给浏览器端读取，因为 B 站原始 XML 地址通常没有允许你的网站读取的 `Access-Control-Allow-Origin`。应使用本服务返回的 `data.danmakuUrl` 或 `data.danmukuUrl`。

视频流不经过本服务，VPS 不会转发视频流量；只有解析请求和弹幕 XML 请求经过本服务。

## Cloudflare Worker 部署

```bash
npx wrangler login
npx wrangler deploy
```

如果需要登录态内容，在部署前单独配置服务端 Secret：

```bash
npx wrangler secret put BILIBILI_COOKIE
```

不要把 `BILIBILI_COOKIE` 返回给客户端，也不要提交到代码仓库。

## 部署到 VPS

`worker.js` 是核心解析逻辑，VPS 使用 `server-vps.mjs` 提供 Node HTTP 服务。需要 Node.js 20 或更高版本，不需要安装 npm 依赖。

配置项：

- `CORS_ENABLED`：`true`/`false`，控制是否返回 CORS 响应头，默认 `true`。
- `ALLOWED_ORIGINS`：允许的 Origin，JSON 中可写字符串或数组。
- `API_KEY`：非空时启用鉴权；GET 使用 `key` 参数，POST 可在 JSON body 中传 `key`，也支持 `X-API-Key` 请求头。

先上传这两个文件到 VPS，例如 `/opt/bilidirect/`：

```text
worker.js
server-vps.mjs
config.example.json
```

复制 `config.example.json` 为 `config.json`，填入实际配置。`config.json` 已被 `.gitignore` 忽略，不要提交到仓库。

临时运行测试：

```bash
cd /opt/bilidirect
cp config.example.json config.json
nano config.json
chmod 600 config.json
node server-vps.mjs
```

另开一个终端测试：

```bash
curl 'http://127.0.0.1:8787/api/parse?bvid=BV1B7411m7LV'
```

生产环境也可以把 JSON 配置放到独立目录：

```bash
sudo useradd --system --home /opt/bilidirect --shell /usr/sbin/nologin bilidirect
sudo chown -R bilidirect:bilidirect /opt/bilidirect
sudo install -d -o bilidirect -g bilidirect -m 700 /etc/bilidirect
sudo install -o bilidirect -g bilidirect -m 600 config.json /etc/bilidirect/config.json
```

JSON 内容示例：

```json
{
  "HOST": "127.0.0.1",
  "PORT": 8787,
  "CORS_ENABLED": true,
  "ALLOWED_ORIGINS": ["https://你的前端域名"],
  "API_KEY": "你的调试key",
  "BILIBILI_COOKIE": "完整Cookie"
}
```

然后用 systemd 守护：

```ini
# /etc/systemd/system/bilidirect.service
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

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bilidirect
sudo systemctl status bilidirect
```

外网访问建议通过 Nginx 反向代理并启用 HTTPS，前端请求地址改成：

```text
https://你的域名/api/parse?bvid=BV1B7411m7LV
```

Nginx 需要把公网 Host 和协议传给 Node，否则接口生成的 `danmukuUrl` 可能仍然是 `127.0.0.1:8787` 或 `http://`：

```nginx
server {
    listen 443 ssl;
    server_name api.example.com;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

通过 `https://api.example.com/api/parse` 请求时，返回的 `danmukuUrl` 会自动使用 `https://api.example.com/api/danmaku...`。直接在 VPS 上用 `127.0.0.1:8787` 测试时，返回本机地址是正常的。

如果在 Cloudflare Worker 上启用 key，建议使用 Secret：

```bash
npx wrangler secret put API_KEY
```
