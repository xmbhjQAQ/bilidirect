import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./worker.js";


const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(SCRIPT_DIR, "config.json");
const CONFIG = loadConfig(CONFIG_FILE);
const HOST = String(setting("HOST", "host", "127.0.0.1"));
const PORT = Number(setting("PORT", "port", 8787));
const MAX_BODY_BYTES = 1024 * 1024;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("PORT 必须是 1-65535 之间的整数");
}


function loadConfig(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("配置文件必须是 JSON 对象");
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`读取配置文件失败（${file}）：${error.message}`);
  }
}


function setting(envName, jsonName, fallback) {
  if (process.env[envName] !== undefined) return process.env[envName];
  if (CONFIG[envName] !== undefined) return CONFIG[envName];
  if (CONFIG[jsonName] !== undefined) return CONFIG[jsonName];
  return fallback;
}


function textSetting(envName, jsonName, fallback) {
  const value = setting(envName, jsonName, fallback);
  return Array.isArray(value) ? value.join(",") : String(value ?? "");
}


function requestHeaders(nodeRequest) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(nodeRequest.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}


function firstHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value;
}


function publicRequestUrl(nodeRequest) {
  const forwardedHost = firstHeaderValue(nodeRequest.headers["x-forwarded-host"]);
  const host = forwardedHost || nodeRequest.headers.host || `${HOST}:${PORT}`;
  const forwardedProto = firstHeaderValue(nodeRequest.headers["x-forwarded-proto"]);
  const protocol = String(forwardedProto || "http")
    .split(",", 1)[0]
    .trim()
    .toLowerCase();
  const safeProtocol = protocol === "https" ? "https" : "http";
  return new URL(nodeRequest.url || "/", `${safeProtocol}://${host}`);
}


function readBody(nodeRequest) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    nodeRequest.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("请求体过大"));
        nodeRequest.destroy();
        return;
      }
      chunks.push(chunk);
    });
    nodeRequest.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    nodeRequest.on("error", reject);
  });
}


function sendJson(nodeResponse, status, payload) {
  const body = JSON.stringify(payload);
  nodeResponse.statusCode = status;
  nodeResponse.setHeader("Content-Type", "application/json; charset=utf-8");
  nodeResponse.setHeader("Cache-Control", "no-store");
  nodeResponse.setHeader("Content-Length", Buffer.byteLength(body));
  nodeResponse.end(body);
}


function runtimeEnv() {
  return {
    CORS_ENABLED: textSetting("CORS_ENABLED", "corsEnabled", true),
    ALLOWED_ORIGINS: textSetting("ALLOWED_ORIGINS", "allowedOrigins", "*"),
    API_KEY: textSetting("API_KEY", "apiKey", ""),
    BILIBILI_COOKIE: textSetting("BILIBILI_COOKIE", "bilibiliCookie", ""),
    BILIBILI_USER_AGENT: textSetting("BILIBILI_USER_AGENT", "bilibiliUserAgent", ""),
  };
}


const server = http.createServer(async (nodeRequest, nodeResponse) => {
  try {
    const url = publicRequestUrl(nodeRequest);
    const method = nodeRequest.method || "GET";
    const body = ["GET", "HEAD", "OPTIONS"].includes(method)
      ? undefined
      : await readBody(nodeRequest);
    const request = new Request(url, {
      method,
      headers: requestHeaders(nodeRequest),
      body,
    });
    const response = await worker.fetch(request, runtimeEnv());

    nodeResponse.statusCode = response.status;
    response.headers.forEach((value, name) => nodeResponse.setHeader(name, value));
    if (method === "HEAD") {
      nodeResponse.end();
      return;
    }
    nodeResponse.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    sendJson(nodeResponse, 500, {
      ok: false,
      code: -500,
      message: `VPS 服务异常：${message}`,
    });
  }
});


server.listen(PORT, HOST, () => {
  console.log(`B站直链服务已启动：http://${HOST}:${PORT}`);
  console.log(`健康检查：http://${HOST}:${PORT}/api/health`);
});


function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
}


process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
