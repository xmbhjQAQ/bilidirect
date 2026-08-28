const BILI_API = "https://api.bilibili.com";
const BILI_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/151.0.0.0 Safari/537.36";
const BVID_RE = /^BV[0-9A-Za-z]{10,}$/;
const ALLOWED_QN = new Set([16, 32, 64, 80, 112, 116, 120, 125, 126, 127, 128, 208]);


class ApiError extends Error {
  constructor(message, status = 502, code = -502, details = undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}


function attachDetails(error, details) {
  if (error instanceof ApiError) {
    error.details = { ...(error.details || {}), ...details };
    return error;
  }
  return new ApiError(error.message || "未知错误", 502, -502, details);
}


function isEnabled(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}


function getAllowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  const configured = String(env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!origin || configured.includes("*")) return "*";
  return configured.includes(origin) ? origin : "null";
}


function corsHeaders(request, env) {
  if (!isEnabled(env.CORS_ENABLED, true)) return {};
  const headers = {
    "Access-Control-Allow-Origin": getAllowedOrigin(request, env),
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  return headers;
}


function jsonResponse(request, env, payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders(request, env),
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}


function upstreamHeaders(env, referer, extra = {}, cookie = env.BILIBILI_COOKIE) {
  const headers = new Headers(extra);
  headers.set("User-Agent", env.BILIBILI_USER_AGENT || BILI_UA);
  headers.set("Referer", referer);
  headers.set("Accept", "application/json, text/plain, */*");
  if (cookie) headers.set("Cookie", cookie);
  return headers;
}


async function fetchBiliJson(url, env, referer, cookie = env.BILIBILI_COOKIE) {
  let response;
  try {
    response = await fetch(url, {
      headers: upstreamHeaders(env, referer, {}, cookie),
    });
  } catch (error) {
    throw new ApiError(`请求 B站接口失败：${error.message}`);
  }

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError(`B站接口返回非 JSON（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    const endpoint = new URL(url).pathname;
    const message = response.status === 412
      ? "B站风控拦截了 Worker 出口请求（HTTP 412），请配置 BILIBILI_COOKIE 后重试"
      : `B站接口返回 HTTP ${response.status}`;
    throw new ApiError(
      message,
      502,
      response.status === 412 ? -412 : -502,
      { upstreamStatus: response.status, endpoint, cookieConfigured: Boolean(cookie) },
    );
  }
  if (body.code !== 0) {
    throw new ApiError(
      body.message || `B站接口错误：${body.code}`,
      502,
      body.code,
      { upstreamCode: body.code },
    );
  }
  return body.data || {};
}


async function fetchBiliText(url, env, referer, cookie = env.BILIBILI_COOKIE) {
  let response;
  try {
    response = await fetch(url, {
      headers: upstreamHeaders(
        env,
        referer,
        { Accept: "application/xml, text/xml, text/plain, */*" },
        cookie,
      ),
    });
  } catch (error) {
    throw new ApiError(`请求 B站弹幕接口失败：${error.message}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new ApiError(
      `B站弹幕接口返回 HTTP ${response.status}`,
      502,
      -502,
      { upstreamStatus: response.status, endpoint: new URL(url).pathname },
    );
  }
  if (text.trimStart().startsWith("{")) {
    try {
      const body = JSON.parse(text);
      if (body.code !== 0) {
        throw new ApiError(
          body.message || `B站弹幕接口错误：${body.code}`,
          502,
          body.code,
          { upstreamCode: body.code, endpoint: new URL(url).pathname },
        );
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
    }
  }
  return text;
}


function joinCookies(...cookieValues) {
  return cookieValues
    .flatMap((value) => String(value || "").split(";"))
    .map((item) => item.trim())
    .filter(Boolean)
    .join("; ");
}


async function getAnonymousDeviceCookie(env) {
  const data = await fetchBiliJson(
    `${BILI_API}/x/frontend/finger/spi`,
    env,
    "https://www.bilibili.com/",
  );
  const deviceCookies = [
    data.b_3 && `buvid3=${data.b_3}`,
    data.b_4 && `buvid4=${data.b_4}`,
    `b_nut=${Math.floor(Date.now() / 1000)}`,
  ];
  return joinCookies(env.BILIBILI_COOKIE, deviceCookies.join("; "));
}


function deviceCookieDiagnostic(error, env, requestCookie = "") {
  const upstreamDetails = error instanceof ApiError && error.details
    ? error.details
    : {};
  return {
    attempted: true,
    ok: false,
    endpoint: upstreamDetails.endpoint || "/x/frontend/finger/spi",
    upstreamStatus: upstreamDetails.upstreamStatus ?? null,
    upstreamCode: upstreamDetails.upstreamCode ?? null,
    configuredCookie: Boolean(env.BILIBILI_COOKIE),
    requestCookieAttached: Boolean(requestCookie),
    message: error?.message || "匿名设备 Cookie 初始化失败",
  };
}


function readNumber(value, fallback, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new ApiError(`${name} 参数无效`, 400, -400);
  }
  return number;
}


function normalizeCover(url) {
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("http://")) return `https://${url.slice("http://".length)}`;
  return url;
}


function mediaCandidates(entry) {
  const urls = [];
  const primary = entry.url || entry.baseUrl || entry.base_url;
  if (primary) urls.push(primary);
  const backups = entry.backup_url || entry.backupUrl || entry.backup_url_list || [];
  if (Array.isArray(backups)) urls.push(...backups);
  else if (typeof backups === "string") urls.push(backups);
  return [...new Set(urls.filter(Boolean))];
}


function deadlineFromUrl(url) {
  try {
    const deadline = Number(new URL(url).searchParams.get("deadline"));
    return Number.isFinite(deadline) && deadline > 0 ? deadline : null;
  } catch {
    return null;
  }
}


async function probeDirectUrl(url, env, cookie) {
  // 故意不设置 Referer，模拟浏览器将 video.referrerPolicy 设为 no-referrer 的直连请求。
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "*/*",
        Range: "bytes=0-1",
        "User-Agent": env.BILIBILI_USER_AGENT || BILI_UA,
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    const result = {
      status: response.status,
      ok: response.status === 200 || response.status === 206,
      contentType: response.headers.get("Content-Type"),
      contentRange: response.headers.get("Content-Range"),
    };
    try {
      await response.body?.cancel();
    } catch {
      // 仅为释放探测响应，不影响结果。
    }
    return result;
  } catch (error) {
    return { status: null, ok: false, error: error.message };
  }
}


async function chooseDirectUrl(entries, env, shouldProbe, cookie) {
  const diagnostics = [];
  for (const entry of entries.slice(0, 3)) {
    for (const url of mediaCandidates(entry).slice(0, 4)) {
      const probe = shouldProbe
        ? await probeDirectUrl(url, env, cookie)
        : { status: null, ok: null, skipped: true };
      diagnostics.push({ url, probe });
      if (!shouldProbe || probe.ok) {
        return { url, probe, diagnostics };
      }
    }
  }
  return {
    url: diagnostics[0]?.url || null,
    probe: diagnostics[0]?.probe || null,
    diagnostics,
  };
}


function pageSummary(page) {
  return {
    cid: page.cid,
    page: page.page,
    part: page.part,
    duration: page.duration,
    dimension: page.dimension,
  };
}


function apiUrl(requestUrl, pathname, params) {
  const result = new URL(requestUrl);
  result.pathname = pathname;
  result.search = "";
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      result.searchParams.set(name, String(value));
    }
  }
  return result.toString();
}


function suppliedApiKey(request, input) {
  if (input?.key !== undefined) return String(input.key);
  return request.headers.get("X-API-Key") || "";
}


function makeDanmakuLinks(request, input, bvid, aid, cid, page) {
  const params = { bvid, aid, cid, page };
  if (input?.key !== undefined && String(input.key) !== "") {
    params.key = String(input.key);
  }
  return {
    url: apiUrl(request.url, "/api/danmaku", params),
    sourceUrl: `https://comment.bilibili.com/${encodeURIComponent(cid)}.xml`,
  };
}


async function getDanmakuXml(input, env) {
  const cid = readNumber(input.cid, null, "cid", { min: 1 });
  const sourceUrl = `https://comment.bilibili.com/${encodeURIComponent(cid)}.xml`;
  const referer = input.bvid
    ? `https://www.bilibili.com/video/${String(input.bvid).trim()}`
    : "https://www.bilibili.com/";
  return fetchBiliText(sourceUrl, env, referer);
}


function xmlResponse(request, env, xml, status = 200) {
  return new Response(xml, {
    status,
    headers: {
      ...corsHeaders(request, env),
      "Cache-Control": "no-store",
      "Content-Type": "text/xml; charset=utf-8",
    },
  });
}


async function parseVideo(input, env, request) {
  const bvid = String(input.bvid || "").trim();
  if (!BVID_RE.test(bvid)) throw new ApiError("无效的 bvid", 400, -400);

  const pageNumber = readNumber(input.page ?? input.p, 1, "page", { min: 1 });
  const qn = readNumber(input.qn, 80, "qn", { min: 1 });
  if (!ALLOWED_QN.has(qn)) {
    throw new ApiError(`不支持的 qn：${qn}`, 400, -400);
  }
  const fnval = readNumber(input.fnval, 0, "fnval", { min: 0 });
  if (![0, 4048].includes(fnval)) {
    throw new ApiError("fnval 只能是 0 或 4048", 400, -400);
  }
  const fourk = readNumber(input.fourk, 1, "fourk", { min: 0, max: 1 });
  const shouldProbe = String(input.probe ?? "1") !== "0";
  const referer = `https://www.bilibili.com/video/${bvid}`;

  const configuredCookie = Boolean(env.BILIBILI_COOKIE);
  let requestCookie = env.BILIBILI_COOKIE || "";
  let deviceCookieBootstrap;
  try {
    requestCookie = await getAnonymousDeviceCookie(env);
    deviceCookieBootstrap = {
      attempted: true,
      ok: true,
      endpoint: "/x/frontend/finger/spi",
      configuredCookie,
      requestCookieAttached: Boolean(requestCookie),
      generatedAnonymousCookie: requestCookie !== (env.BILIBILI_COOKIE || ""),
    };
  } catch (error) {
    // 设备 Cookie 接口被拦截时，继续使用已配置的 Secret 或空 Cookie请求主接口。
    deviceCookieBootstrap = deviceCookieDiagnostic(
      error,
      env,
      requestCookie,
    );
  }

  let detail;
  try {
    detail = await fetchBiliJson(
      `${BILI_API}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
      env,
      referer,
      requestCookie,
    );
  } catch (error) {
    throw attachDetails(error, { deviceCookieBootstrap });
  }
  const pages = Array.isArray(detail.pages) ? detail.pages : [];
  const selectedPage = pages.find((item) => item.page === pageNumber);
  if (!selectedPage) {
    throw new ApiError(`找不到第 ${pageNumber} 个分P`, 404, -404, {
      availablePages: pages.map((item) => item.page),
    });
  }

  const playParams = new URLSearchParams({
    avid: String(detail.aid),
    cid: String(selectedPage.cid),
    qn: String(qn),
    fnver: "0",
    fnval: String(fnval),
    fourk: String(fourk),
    platform: "html5",
  });
  let play;
  try {
    play = await fetchBiliJson(
      `${BILI_API}/x/player/playurl?${playParams}`,
      env,
      referer,
      requestCookie,
    );
  } catch (error) {
    throw attachDetails(error, { deviceCookieBootstrap });
  }
  const durl = Array.isArray(play.durl) ? play.durl : [];
  const dash = play.dash || null;
  const selected = await chooseDirectUrl(durl, env, shouldProbe, requestCookie);
  const directUrl = selected.url;
  const danmakuLinks = makeDanmakuLinks(
    request,
    input,
    bvid,
    detail.aid,
    selectedPage.cid,
    pageNumber,
  );

  const stat = detail.stat || {};
  const video = {
    bvid: detail.bvid || bvid,
    aid: detail.aid,
    cid: selectedPage.cid,
    page: pageNumber,
    title: detail.title || "",
    description: detail.desc || "",
    cover: normalizeCover(detail.pic),
    pic: normalizeCover(detail.pic),
    view: stat.view ?? 0,
    playCount: stat.view ?? 0,
    duration: detail.duration ?? selectedPage.duration ?? 0,
    pageDuration: selectedPage.duration ?? 0,
    pages: pages.map(pageSummary),
    owner: detail.owner || {},
    stat,
  };
  const playback = {
    apiMode: "legacy_html5",
    streamType: directUrl ? "durl" : dash ? "dash" : "none",
    directUrl,
    directUrlExpiresAt: deadlineFromUrl(directUrl),
    format: play.format || null,
    quality: play.quality ?? null,
    timelength: play.timelength ?? null,
    acceptQuality: play.accept_quality || [],
    acceptDescription: play.accept_description || [],
    durl,
    dash,
    directProbe: selected.probe,
    candidates: selected.diagnostics,
  };

  return {
    bvid: video.bvid,
    aid: video.aid,
    cid: video.cid,
    page: video.page,
    title: video.title,
    description: video.description,
    cover: video.cover,
    pic: video.pic,
    view: video.view,
    playCount: video.playCount,
    duration: video.duration,
    directUrl: playback.directUrl,
    streamType: playback.streamType,
    format: playback.format,
    quality: playback.quality,
    video,
    playback,
    danmakuUrl: danmakuLinks.url,
    danmukuUrl: danmakuLinks.url,
    danmakuSourceUrl: danmakuLinks.sourceUrl,
    danmaku: {
      url: danmakuLinks.url,
      sourceUrl: danmakuLinks.sourceUrl,
      format: "xml",
      cid: selectedPage.cid,
      aid: detail.aid,
      page: pageNumber,
    },
    diagnostics: {
      deviceCookieBootstrap,
      configuredCookie,
      requestCookieAttached: Boolean(requestCookie),
    },
  };
}


async function readInput(request, url) {
  if (request.method === "GET") return Object.fromEntries(url.searchParams.entries());
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("JSON body 必须是对象");
    }
    return body;
  } catch (error) {
    throw new ApiError(`请求体不是有效 JSON：${error.message}`, 400, -400);
  }
}


function authorizeRequest(request, input, env) {
  const expectedKey = String(env.API_KEY || "");
  if (!expectedKey) return;

  const suppliedKey = suppliedApiKey(request, input);
  if (suppliedKey !== expectedKey) {
    throw new ApiError("API key 缺失或错误", 401, -401);
  }
}


export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    if (url.pathname === "/api/health" && request.method === "GET") {
      return jsonResponse(request, env, {
        ok: true,
        service: "bilibili-direct-parser",
        cookieConfigured: Boolean(env.BILIBILI_COOKIE),
        corsEnabled: isEnabled(env.CORS_ENABLED, true),
        apiKeyConfigured: Boolean(env.API_KEY),
      });
    }
    if (url.pathname === "/api/danmaku" && request.method === "GET") {
      try {
        const input = await readInput(request, url);
        authorizeRequest(request, input, env);
        const xml = await getDanmakuXml(input, env);
        return xmlResponse(request, env, xml);
      } catch (error) {
        const apiError = error instanceof ApiError
          ? error
          : new ApiError(error.message || "未知错误");
        return jsonResponse(request, env, {
          ok: false,
          code: apiError.code,
          message: apiError.message,
          details: apiError.details,
        }, apiError.status);
      }
    }
    if (url.pathname === "/api/parse" && ["GET", "POST"].includes(request.method)) {
      try {
        const input = await readInput(request, url);
        authorizeRequest(request, input, env);
        const data = await parseVideo(input, env, request);
        return jsonResponse(request, env, { ok: true, code: 0, data });
      } catch (error) {
        const apiError = error instanceof ApiError
          ? error
          : new ApiError(error.message || "未知错误");
        return jsonResponse(request, env, {
          ok: false,
          code: apiError.code,
          message: apiError.message,
          details: apiError.details,
        }, apiError.status);
      }
    }
    if (url.pathname === "/") {
      return jsonResponse(request, env, {
        ok: true,
        service: "bilibili-direct-parser",
        usage: "/api/parse?bvid=BV1B7411m7LV&page=1&qn=80&fnval=0",
      });
    }
    return jsonResponse(request, env, { ok: false, code: -404, message: "Not Found" }, 404);
  },
};
