const STORAGE_KEY = "weibo_super_topic_accounts";
const LAST_CAPTURE_KEY = "weibo_super_topic_last_capture";
const LAST_RESULT_KEY = "weibo_super_topic_last_result";
const COOKIE_EXPIRED_KEY = "weibo_super_topic_cookie_expired";
const CAPTURE_DIAG_KEY = "weibo_super_topic_capture_diagnostic";
const RUNTIME_DIAG_KEY = "weibo_super_topic_runtime_diagnostic";
const MANUAL_TRIGGER_URL = "http://weibo-checkin.local/run";
const DIRECT = "DIRECT";
const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const BASE_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  Referer: "https://m.weibo.cn/",
  "User-Agent": USER_AGENT,
  "X-Requested-With": "XMLHttpRequest",
  "MWeibo-Pwa": "1",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentDay() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function getHeader(headers, name) {
  if (!headers) return "";
  return (
    headers.get?.(name) ||
    headers.get?.(name.toLowerCase()) ||
    headers[name] ||
    headers[name.toLowerCase()] ||
    ""
  );
}

function captureEnabled(ctx) {
  const value = ctx.env?.ENABLE_CAPTURE ?? ctx.args?.ENABLE_CAPTURE ?? "true";
  return String(value).toLowerCase() !== "false";
}

function cookieHeaders(cookie, referer = "https://m.weibo.cn/") {
  return { ...BASE_HEADERS, Cookie: cookie, Referer: referer };
}

function cookieFingerprint(cookie) {
  const stable = /(?:^|;\s*)SUB=([^;]+)/i.exec(cookie)?.[1] || cookie;
  let hash = 2166136261;
  for (let i = 0; i < stable.length; i += 1) {
    hash ^= stable.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

async function requestJson(ctx, url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const requestOptions = {
    timeout: options.timeout || 20000,
    policy: DIRECT,
    headers: options.headers || BASE_HEADERS,
  };
  if (options.body !== undefined) requestOptions.body = options.body;
  const response = method === "POST"
    ? await ctx.http.post(url, requestOptions)
    : await ctx.http.get(url, requestOptions);
  if (response.status < 200 || response.status >= 300) {
    let detail = "";
    try {
      const raw = await response.text();
      detail = String(raw || "").replace(/\\s+/g, " ").slice(0, 240);
    } catch (_) {}
    const path = (() => {
      try { return new URL(url).pathname; } catch (_) { return "request"; }
    })();
    throw new Error(`HTTP ${response.status} ${path}${detail ? `：${detail}` : ""}`);
  }
  return response.json();
}

async function fetchLoginState(ctx, cookie) {
  const data = await requestJson(ctx, "https://m.weibo.cn/api/config", {
    headers: cookieHeaders(cookie),
  });
  const info = data?.data || {};
  return {
    login: Boolean(info.login),
    st: info.st || "",
    uid: String(info.uid || info.user?.id || "default"),
  };
}

async function notifyCaptureDiagnostic(ctx, body) {
  const now = Date.now();
  const last = Number(ctx.storage.get(CAPTURE_DIAG_KEY) || 0);
  if (now - last < 30 * 1000) return;
  ctx.storage.set(CAPTURE_DIAG_KEY, String(now));
  ctx.notify({
    title: "微博 Cookie 获取诊断",
    body,
    sound: true,
    duration: 6,
  });
}

async function notifyRuntime(ctx) {
  const now = Date.now();
  const last = Number(ctx.storage.get(RUNTIME_DIAG_KEY) || 0);
  if (now - last < 5 * 60 * 1000) return;
  ctx.storage.set(RUNTIME_DIAG_KEY, String(now));
  ctx.notify({
    title: "微博模块已运行",
    body: "请在微博 App 点击“我”后刷新；若无 Cookie 诊断，检查 MITM 证书",
    sound: false,
    duration: 6,
  });
}

async function captureCookie(ctx) {
  await notifyRuntime(ctx);
  if (!captureEnabled(ctx)) {
    await notifyCaptureDiagnostic(ctx, "已检测到微博请求，但“自动获取 Cookie”开关已关闭");
    return;
  }
  const cookie = getHeader(ctx.request?.headers, "cookie").trim();
  if (!cookie || !/(?:^|;\s*)SUB=/i.test(cookie)) {
    await notifyCaptureDiagnostic(ctx, "已检测到微博请求，但请求未带 SUB 登录 Cookie；请在微博 App 点“我”后下拉刷新");
    console.log("微博请求未包含有效 SUB Cookie，跳过保存");
    return;
  }

  let state;
  try {
    state = await fetchLoginState(ctx, cookie);
  } catch (error) {
    console.log(`验证微博 Cookie 失败：${error.message || error}`);
    return;
  }
  if (!state.login) {
    console.log("微博 Cookie 当前未登录，跳过保存");
    return;
  }

  const accounts = ctx.storage.getJSON(STORAGE_KEY) || {};
  const accountId = state.uid || cookieFingerprint(cookie);
  const changed = accounts[accountId] !== cookie;
  accounts[accountId] = cookie;
  ctx.storage.setJSON(STORAGE_KEY, accounts);

  // 按账号记录指纹：首次抓取或 Cookie 变化时都通知。
  const fingerprints = ctx.storage.getJSON(LAST_CAPTURE_KEY) || {};
  const previousFingerprint = fingerprints[accountId] || "";
  const fingerprint = cookieFingerprint(cookie);
  const shouldNotify = previousFingerprint !== fingerprint;
  fingerprints[accountId] = fingerprint;
  ctx.storage.setJSON(LAST_CAPTURE_KEY, fingerprints);
  console.log(`微博账号 ${accountId} Cookie ${changed ? "已保存" : "无变化"}`);

  if (shouldNotify) {
    ctx.notify({
      title: "微博超话签到",
      subtitle: `账号 ${accountId}`,
      body: changed ? "Cookie 已更新，自动签到仍在运行" : "Cookie 获取成功，已开启自动签到",
      sound: true,
      duration: 5,
    });
  }
}

function topicFromCard(item) {
  const buttons = item?.buttons || [];
  if (String(item?.card_type) !== "8" || !buttons.length) return null;
  const name = item.title_sub || item.title || "";
  const scheme = item.scheme || "";
  let containerId = "";
  try {
    const parsed = new URL(scheme, "https://m.weibo.cn");
    containerId = parsed.searchParams.get("containerid") || "";
  } catch (_) {}
  const button = buttons[0] || {};
  const buttonName = String(button.name || "");
  const checkinScheme = button.scheme || "";
  const done = ["已签", "已簽", "已签到", "已簽到"].includes(buttonName) || !checkinScheme;
  return name ? { name, id: containerId, scheme: done ? "" : checkinScheme, done } : null;
}

async function getFollowedTopics(ctx, cookie) {
  const topics = [];
  const seen = new Set();
  let sinceId = "";
  for (let page = 1; page <= 30; page += 1) {
    const params = new URLSearchParams({ containerid: "100803_-_followsuper" });
    if (sinceId) params.set("since_id", sinceId);
    const data = await requestJson(
      ctx,
      `https://m.weibo.cn/api/container/getIndex?${params.toString()}`,
      { headers: cookieHeaders(cookie) },
    );
    if (data?.ok !== 1) {
      throw new Error(data?.msg || "获取关注超话失败");
    }
    const payload = data.data || {};
    for (const card of payload.cards || []) {
      const group = Array.isArray(card.card_group) ? card.card_group : [card];
      for (const item of group) {
        const topic = topicFromCard(item);
        const key = topic ? `${topic.id}|${topic.name}` : "";
        if (topic && !seen.has(key)) {
          seen.add(key);
          topics.push(topic);
        }
      }
    }
    sinceId = String(payload.cardlistInfo?.since_id || "");
    if (!sinceId) break;
    await sleep(800);
  }
  return topics;
}

function buildCheckinUrl(scheme, st) {
  const url = new URL(scheme, "https://m.weibo.cn");
  if (st) url.searchParams.set("st", st);
  return url.toString();
}

function parseCheckinResult(data) {
  const message = String(data?.msg || data?.message || "");
  const ok =
    data?.ok === 1 ||
    /成功|已签到|已簽到|已签|已簽/.test(message);
  const stExpired =
    String(data?.errno || data?.code || "") === "100015" ||
    /验签|驗簽|验证|st.*失效/i.test(`${message} ${JSON.stringify(data || {})}`);
  return { ok, message: message || (ok ? "签到成功" : "未知响应"), stExpired };
}

async function signTopic(ctx, cookie, topic, state) {
  if (topic.done || !topic.scheme) {
    return { ok: true, already: true, message: "今日已签到" };
  }
  let st = state.st;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      let data = await requestJson(ctx, buildCheckinUrl(topic.scheme, st), {
        headers: cookieHeaders(cookie, `https://m.weibo.cn/p/index?containerid=${topic.id}`),
      });
      let parsed = parseCheckinResult(data);
      if (parsed.stExpired && attempt === 1) {
        const refreshed = await fetchLoginState(ctx, cookie);
        st = refreshed.st;
        data = await requestJson(ctx, buildCheckinUrl(topic.scheme, st), {
          headers: cookieHeaders(cookie),
        });
        parsed = parseCheckinResult(data);
      }
      if (parsed.ok || !parsed.stExpired) return parsed;
    } catch (error) {
      if (attempt === 3) return { ok: false, message: error.message || String(error) };
    }
    await sleep(1500 * attempt);
  }
  return { ok: false, message: "重试后仍失败" };
}

async function checkinAccount(ctx, accountId, cookie) {
  const state = await fetchLoginState(ctx, cookie);
  if (!state.login) {
    const expired = ctx.storage.getJSON(COOKIE_EXPIRED_KEY) || {};
    if (!expired[accountId]) {
      expired[accountId] = currentDay();
      ctx.storage.setJSON(COOKIE_EXPIRED_KEY, expired);
      ctx.notify({
        title: "⚠️ 微博 Cookie 失效",
        subtitle: `账号 ${accountId}`,
        body: "请打开微博 App，点击“我”并刷新页面重新获取 Cookie",
        sound: true,
        duration: 8,
      });
    }
    throw new Error("Cookie 已失效，请打开微博 App 点击“我”重新获取");
  }
  const expired = ctx.storage.getJSON(COOKIE_EXPIRED_KEY) || {};
  if (expired[accountId]) {
    delete expired[accountId];
    ctx.storage.setJSON(COOKIE_EXPIRED_KEY, expired);
  }
  const topics = await getFollowedTopics(ctx, cookie);
  let success = 0;
  let already = 0;
  const failures = [];

  console.log(`微博账号 ${accountId} 获取到 ${topics.length} 个关注超话`);
  for (let index = 0; index < topics.length; index += 1) {
    const topic = topics[index];
    const result = await signTopic(ctx, cookie, topic, state);
    console.log(`${topic.name}：${result.message}`);
    if (result.ok) {
      success += 1;
      if (result.already || topic.done) already += 1;
    } else {
      failures.push(`${topic.name}：${result.message}`);
    }
    if (index < topics.length - 1) {
      await sleep(1500 + Math.floor(Math.random() * 2500));
    }
  }
  return { accountId, total: topics.length, success, already, failures };
}

async function runCheckin(ctx) {
  const accounts = ctx.storage.getJSON(STORAGE_KEY) || {};
  const entries = Object.entries(accounts);
  if (!entries.length) {
    const result = {
      day: currentDay(), time: new Date().toISOString(), accounts: 0,
      total: 0, success: 0, already: 0, failed: 1,
      message: "没有 Cookie，请先打开微博 App 或 m.weibo.cn",
    };
    ctx.storage.setJSON(LAST_RESULT_KEY, result);
    ctx.notify({
      title: "❌ 微博超话签到失败",
      body: result.message,
      sound: true,
      duration: 6,
    });
    return result;
  }

  const reports = [];
  for (const [accountId, cookie] of entries) {
    try {
      reports.push(await checkinAccount(ctx, accountId, cookie));
    } catch (error) {
      reports.push({
        accountId, total: 0, success: 0, already: 0,
        failures: [error.message || String(error)],
      });
    }
  }

  const total = reports.reduce((sum, item) => sum + item.total, 0);
  const success = reports.reduce((sum, item) => sum + item.success, 0);
  const already = reports.reduce((sum, item) => sum + item.already, 0);
  const failures = reports.flatMap((item) =>
    item.failures.map((message) => `${item.accountId}：${message}`),
  );
  const result = {
    day: currentDay(), time: new Date().toISOString(), accounts: reports.length,
    total, success, already, failed: failures.length,
    message: failures[0] || "全部签到完成",
  };
  ctx.storage.setJSON(LAST_RESULT_KEY, result);

  const body = [
    `账号：${reports.length}`,
    `超话：${total}`,
    `成功/已签：${success}`,
    `其中已签：${already}`,
    `失败：${failures.length}`,
  ];
  if (failures.length) body.push("", ...failures.slice(0, 6));
  ctx.notify({
    title: failures.length ? "⚠️ 微博超话签到部分失败" : "✅ 微博超话签到完成",
    body: body.join("\n"),
    sound: true,
    duration: 8,
  });
  await sleep(1000);
  return result;
}

function renderWidget(ctx) {
  const result = ctx.storage.getJSON(LAST_RESULT_KEY);
  const signedToday = result && result.day === currentDay();
  const color = !signedToday ? "#FDE68A" : result.failed ? "#FCA5A5" : "#86EFAC";
  return {
    type: "widget",
    refreshAfter: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    padding: 16,
    gap: 9,
    backgroundGradient: {
      type: "linear",
      colors: ["#FF8200", "#B72A12"],
      startPoint: { x: 0, y: 0 },
      endPoint: { x: 1, y: 1 },
    },
    children: [
      { type: "text", text: "微博超话", font: { size: "headline", weight: "bold" }, textColor: "#FFFFFF" },
      {
        type: "text",
        text: signedToday ? (result.failed ? "今日部分失败" : "今日已签到") : "今日尚未签到",
        font: { size: "title3", weight: "semibold" },
        textColor: color,
      },
      {
        type: "text",
        text: signedToday
          ? `超话 ${result.total} · 成功 ${result.success} · 失败 ${result.failed}`
          : "打开微博抓取 Cookie，或点击立即签到",
        font: { size: "caption1" }, textColor: "#FFF3E8",
      },
      { type: "spacer" },
      {
        type: "stack", url: MANUAL_TRIGGER_URL, direction: "row",
        alignItems: "center", padding: [9, 14], borderRadius: 10,
        backgroundColor: signedToday ? "#FFFFFF24" : "#FFFFFF",
        children: [
          { type: "image", src: signedToday ? "sf-symbol:arrow.clockwise" : "sf-symbol:checkmark.circle.fill", color: signedToday ? "#FFFFFF" : "#E64A19", width: 16, height: 16 },
          { type: "spacer", length: 7 },
          { type: "text", text: signedToday ? "重新签到" : "立即签到", font: { size: "subheadline", weight: "bold" }, textColor: signedToday ? "#FFFFFF" : "#E64A19" },
        ],
      },
    ],
  };
}

function manualResponse(ctx, result) {
  const title = result.failed ? "微博超话签到部分失败" : "微博超话签到完成";
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#fff5ee;color:#2a1b17;margin:0;padding:48px 22px}.card{max-width:520px;margin:auto;background:#fff;border-radius:22px;padding:28px;box-shadow:0 10px 40px #8f30151c}h1{font-size:25px;margin:0 0 22px;color:#e64a19}.row{font-size:18px;line-height:1.9}.hint{margin-top:22px;color:#7a625a;font-size:14px}</style><div class="card"><h1>${title}</h1><div class="row">账号：${result.accounts}<br>超话：${result.total}<br>成功/已签：${result.success}<br>失败：${result.failed}</div><div class="hint">${result.message}</div></div>`;
  return ctx.respond({
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: html,
  });
}

export default async function (ctx) {
  try {
    if (ctx.request?.url === MANUAL_TRIGGER_URL) {
      return manualResponse(ctx, await runCheckin(ctx));
    }
    if (ctx.request?.url) return await captureCookie(ctx);
    if (ctx.widgetFamily) return renderWidget(ctx);
    await runCheckin(ctx);
  } catch (error) {
    console.log(`微博超话脚本异常：${error.stack || error.message || error}`);
    ctx.notify({
      title: "❌ 微博超话脚本异常",
      body: error.message || String(error),
      sound: true,
      duration: 6,
    });
    if (ctx.widgetFamily) return renderWidget(ctx);
    if (ctx.request?.url === MANUAL_TRIGGER_URL) {
      return ctx.respond({
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: `微博超话签到失败：${error.message || String(error)}`,
      });
    }
  }
}
