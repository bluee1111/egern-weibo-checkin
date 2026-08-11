// 微博超话自动签到（手动 Cookie 版）
// 在模块设置里填写微博 Cookie，每天定时签到全部关注超话。
// Cookie 仅保存在 Egern 本地。

const STORAGE_KEY = "weibo_super_topic_accounts";
const LAST_RESULT_KEY = "weibo_super_topic_last_result";
const COOKIE_EXPIRED_KEY = "weibo_super_topic_cookie_expired";
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

function getConfiguredCookie(ctx) {
  return String(ctx.env?.WeiboCookie ?? ctx.args?.WeiboCookie ?? "").trim();
}

function getStoredCookies(ctx) {
  try { return ctx.storage.getJSON(STORAGE_KEY) || {}; } catch (_) { return {}; }
}

function cookieHeaders(cookie, referer = "https://m.weibo.cn/") {
  return { ...BASE_HEADERS, Cookie: cookie, Referer: referer };
}

async function notify(ctx, title, body) {
  if (typeof ctx.notify === "function") {
    await ctx.notify({ title, body, sound: true, duration: 8 });
  }
}

async function requestJson(ctx, url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const requestOptions = {
    timeout: options.timeout || 20000,
    policy: DIRECT,
    headers: options.headers || BASE_HEADERS,
  };
  if (options.body !== undefined) requestOptions.body = options.body;
  let response;
  try {
    response = method === "POST"
      ? await ctx.http.post(url, requestOptions)
      : await ctx.http.get(url, requestOptions);
  } catch (error) {
    const message = String(error?.message || error || "");
    if (/JSON Parse|Unexpected identifier|Unexpected token/i.test(message)) {
      throw new Error("微博接口返回了非 JSON 内容（可能是风控页或 Cookie 失效），请重新获取 Cookie");
    }
    throw new Error(`微博接口请求失败：${message.slice(0, 180)}`);
  }
  if (response.status < 200 || response.status >= 300) {
    let detail = "";
    try {
      const raw = await response.text();
      detail = String(raw || "").replace(/\s+/g, " ").slice(0, 240);
    } catch (_) {}
    const path = (() => {
      try { return new URL(url).pathname; } catch (_) { return "request"; }
    })();
    throw new Error(`HTTP ${response.status} ${path}${detail ? `：${detail}` : ""}`);
  }
  const raw = await response.text();
  try {
    return JSON.parse(raw);
  } catch (error) {
    const compact = String(raw || "").replace(/\s+/g, " ").slice(0, 180);
    throw new Error(`微博接口返回非 JSON（HTTP ${response.status}）：${compact || "空响应"}`);
  }
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
    if (data?.ok !== 1) throw new Error(data?.msg || "获取关注超话失败");
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
  const ok = data?.ok === 1 || /成功|已签到|已簽到|已签|已簽/.test(message);
  const stExpired = String(data?.errno || data?.code || "") === "100015" || /验签|驗簽|验证|st.*失效/i.test(`${message} ${JSON.stringify(data || {})}`);
  return { ok, message: message || (ok ? "签到成功" : "未知响应"), stExpired };
}

async function signTopic(ctx, cookie, topic, state) {
  if (topic.done || !topic.scheme) return { ok: true, already: true, message: "今日已签到" };
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
      await notify(ctx, "⚠️ 微博 Cookie 失效", "请重新打开 m.weibo.cn 登录并复制新 Cookie");
    }
    throw new Error("Cookie 已失效，请重新获取微博 Cookie");
  }
  const topics = await getFollowedTopics(ctx, cookie);
  let success = 0;
  let already = 0;
  const failures = [];
  for (let index = 0; index < topics.length; index += 1) {
    const topic = topics[index];
    const result = await signTopic(ctx, cookie, topic, state);
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
  const configured = getConfiguredCookie(ctx);
  const accounts = getStoredCookies(ctx);
  const entries = Object.entries(accounts);
  if (configured) {
    // 手动填写的 Cookie 优先级最高，先验证登录状态再签到。
    const accountId = "manual";
    try {
      const report = await checkinAccount(ctx, accountId, configured);
      const result = {
        day: currentDay(), time: new Date().toISOString(), accounts: 1,
        total: report.total, success: report.success, already: report.already,
        failed: report.failures.length, message: report.failures[0] || "全部签到完成",
      };
      ctx.storage.setJSON(LAST_RESULT_KEY, result);
      const body = [`账号：manual`, `超话：${report.total}`, `成功/已签：${report.success}`, `失败：${report.failures.length}`];
      if (report.failures.length) body.push("", ...report.failures.slice(0, 6));
      await notify(ctx, report.failures.length ? "⚠️ 微博超话签到部分失败" : "✅ 微博超话签到完成", body.join("\n"));
      return result;
    } catch (error) {
      const message = error.message || String(error);
      const result = { day: currentDay(), time: new Date().toISOString(), accounts: 1, total: 0, success: 0, already: 0, failed: 1, message };
      ctx.storage.setJSON(LAST_RESULT_KEY, result);
      await notify(ctx, "❌ 微博超话签到失败", message);
      return result;
    }
  }
  if (!entries.length) {
    const result = { day: currentDay(), time: new Date().toISOString(), accounts: 0, total: 0, success: 0, already: 0, failed: 1, message: "没有 Cookie，请在模块设置里填写微博 Cookie" };
    ctx.storage.setJSON(LAST_RESULT_KEY, result);
    await notify(ctx, "❌ 微博超话签到失败", result.message);
    return result;
  }
  const reports = [];
  for (const [accountId, cookie] of entries) {
    try {
      reports.push(await checkinAccount(ctx, accountId, cookie));
    } catch (error) {
      reports.push({ accountId, total: 0, success: 0, already: 0, failures: [error.message || String(error)] });
    }
  }
  const total = reports.reduce((sum, item) => sum + item.total, 0);
  const success = reports.reduce((sum, item) => sum + item.success, 0);
  const already = reports.reduce((sum, item) => sum + item.already, 0);
  const failures = reports.flatMap((item) => item.failures.map((message) => `${item.accountId}：${message}`));
  const result = { day: currentDay(), time: new Date().toISOString(), accounts: reports.length, total, success, already, failed: failures.length, message: failures[0] || "全部签到完成" };
  ctx.storage.setJSON(LAST_RESULT_KEY, result);
  const body = [`账号：${reports.length}`, `超话：${total}`, `成功/已签：${success}`, `其中已签：${already}`, `失败：${failures.length}`];
  if (failures.length) body.push("", ...failures.slice(0, 6));
  await notify(ctx, failures.length ? "⚠️ 微博超话签到部分失败" : "✅ 微博超话签到完成", body.join("\n"));
  return result;
}

export default async function (ctx) {
  try {
    await runCheckin(ctx);
  } catch (error) {
    const message = error?.message || String(error);
    await notify(ctx, "❌ 微博超话脚本异常", message.slice(0, 180));
  }
}
