/**
 * WorkBuddy / CodeBuddy CN Daily Check-in & Status Service
 *
 * Modeled after workbuddy_checkin.py:
 *   POST https://copilot.tencent.com/v2/billing/meter/daily-checkin
 *   POST https://copilot.tencent.com/v2/billing/meter/checkin-activity-status
 *   Headers:
 *     Authorization: Bearer <accessToken>
 *     X-Domain: copilot.tencent.com
 *     X-User-Id: <uid> (optional)
 *     Content-Type: application/json
 *     Accept: application/json
 *   Body: {}
 *   Response: { code, data, msg, requestId }
 */

import { PROVIDERS } from "../providers/index.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const DEFAULT_BASE = "https://copilot.tencent.com";
const CHECKIN_EP = "/v2/billing/meter/daily-checkin";
const STATUS_EP = "/v2/billing/meter/checkin-activity-status";

/**
 * Extract user ID (UID) from connection data or JWT token payload
 */
export function extractUid(token, connection = null) {
  if (connection?.providerSpecificData?.uid) {
    return connection.providerSpecificData.uid;
  }
  if (connection?.providerSpecificData?.userId) {
    return connection.providerSpecificData.userId;
  }
  if (token && typeof token === "string" && token.includes(".")) {
    try {
      const parts = token.split(".");
      if (parts.length >= 2) {
        const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf-8"));
        return payload.uid || payload.userId || payload.sub || null;
      }
    } catch {
      // Ignore JWT parse error
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute request to CodeBuddy check-in or status endpoint with retry on 500
 */
export async function doCodeBuddyRequest({
  token,
  uid = null,
  domain = "copilot.tencent.com",
  base = DEFAULT_BASE,
  status = false,
  timeout = 15000,
  maxRetries = 3,
  proxyOptions = null,
}) {
  if (!token) {
    return {
      ok: false,
      http: null,
      biz_code: null,
      msg: "CodeBuddy CN credential not available.",
      data: null,
      raw: null,
      authExpired: false,
      alreadyCheckedIn: false,
    };
  }

  const endpoint = status ? STATUS_EP : CHECKIN_EP;
  const configuredBase = (PROVIDERS["codebuddy-cn"]?.checkin?.baseUrl || base).replace(/\/+$/, "");
  const url = `${configuredBase}${endpoint}`;

  const headers = {
    Authorization: `Bearer ${token}`,
    "X-Domain": domain,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "CLI/2.150.0 CodeBuddy/2.150.0",
    "X-Product": "SaaS",
    "X-IDE-Type": "CLI",
    "X-IDE-Name": "CLI",
    "x-requested-with": "XMLHttpRequest",
    "x-codebuddy-request": "1",
    ...(uid ? { "X-User-Id": String(uid) } : {}),
  };

  let lastResult = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let response = null;
    let bodyText = "";
    let httpCode = null;

    try {
      response = await proxyAwareFetch(
        url,
        {
          method: "POST",
          headers,
          body: "{}",
          signal: AbortSignal.timeout(timeout),
        },
        proxyOptions
      );
      httpCode = response.status;
      bodyText = await response.text();
    } catch (err) {
      lastResult = {
        ok: false,
        http: null,
        biz_code: null,
        msg: `网络/请求异常: ${err.message}`,
        data: null,
        raw: null,
        authExpired: false,
        alreadyCheckedIn: false,
      };
      if (attempt < maxRetries) {
        await sleep(1000 * attempt);
        continue;
      }
      return lastResult;
    }

    let payload = null;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      payload = null;
    }

    const isObject = payload && typeof payload === "object";
    const bizCode = isObject ? payload.code : null;
    const msg = isObject ? payload.msg : null;
    const data = isObject ? payload.data : null;

    const ok = httpCode === 200 && bizCode === 0 && data !== null;
    const authExpired = httpCode === 401 || httpCode === 403;
    const alreadyCheckedIn =
      bizCode === 10001 || (typeof msg === "string" && msg.includes("已签到"));

    const result = {
      ok,
      http: httpCode,
      biz_code: bizCode,
      msg: msg || (ok ? "OK" : `HTTP ${httpCode}`),
      data: data || null,
      raw: payload ? null : bodyText,
      authExpired,
      alreadyCheckedIn,
    };

    if (ok) {
      return result;
    }

    // 仅对 500 等服务端错误重试，400/401/403 等客户端错误直接返回
    if (httpCode >= 500) {
      lastResult = result;
      if (attempt < maxRetries) {
        await sleep(1000 * attempt);
        continue;
      }
    }

    return result;
  }

  return lastResult;
}

/**
 * Daily check-in for CodeBuddy CN
 */
export async function checkinCodeBuddyCn(token, options = {}) {
  return doCodeBuddyRequest({
    token,
    uid: options.uid || null,
    status: false,
    proxyOptions: options.proxyOptions || null,
    domain: options.domain || "copilot.tencent.com",
    base: options.base || DEFAULT_BASE,
  });
}

/**
 * Query check-in activity status for CodeBuddy CN
 */
export async function getCodeBuddyCheckinStatus(token, options = {}) {
  return doCodeBuddyRequest({
    token,
    uid: options.uid || null,
    status: true,
    proxyOptions: options.proxyOptions || null,
    domain: options.domain || "copilot.tencent.com",
    base: options.base || DEFAULT_BASE,
  });
}

/**
 * Daily check-in for TraeWork (Trae SOLO)
 */
export async function checkinTraeWork(token, options = {}) {
  if (!token) return { ok: false, msg: "TraeWork token not available" };

  const psd = options.providerSpecificData || {};
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": `Trae/${psd.ideVersion || "0.1.52"}`,
    Authorization: `Cloud-IDE-JWT ${token}`,
    "X-User-Region": "CN",
    "x-device-brand": psd.deviceBrand || "20Y5A002XX",
    "x-device-type": "windows",
    "x-os-version": psd.osVersion || "Windows 10 Pro",
    "x-app-version": psd.ideVersion || "0.1.52",
    ...(psd.deviceId ? { "x-device-id": psd.deviceId } : {}),
  };

  // 1. Check status first
  const statusRes = await getTraeWorkCheckinStatus(token, options);
  if (statusRes.alreadyCheckedIn) {
    return {
      ok: true,
      http: 200,
      biz_code: 0,
      alreadyCheckedIn: true,
      msg: "今天已签到，请明天再来",
      data: statusRes.data,
    };
  }

  // 2. Perform claim
  const claimUrl = "https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim";
  try {
    const res = await proxyAwareFetch(
      claimUrl,
      { method: "POST", headers, body: "{}" },
      options.proxyOptions
    );
    const json = await res.json().catch(() => null);
    const code = json?.code ?? res.status;
    const msg = json?.message || json?.msg || (res.ok ? "OK" : `HTTP ${res.status}`);

    if (code === 0 || json?.success === true) {
      const updatedStatus = await getTraeWorkCheckinStatus(token, options);
      return {
        ok: true,
        http: 200,
        biz_code: 0,
        alreadyCheckedIn: false,
        msg: "签到成功",
        data: updatedStatus.data || { credit: json?.credits || 10 },
      };
    }

    if (code === 9095 || (typeof msg === "string" && msg.includes("已签到"))) {
      return {
        ok: true,
        http: 200,
        biz_code: code,
        alreadyCheckedIn: true,
        msg: msg || "今天已签到，请明天再来",
        data: json,
      };
    }

    return {
      ok: false,
      http: res.status,
      biz_code: code,
      msg,
      data: json,
      authExpired: res.status === 401 || res.status === 403,
    };
  } catch (err) {
    return { ok: false, msg: err.message };
  }
}

/**
 * Query check-in activity status for TraeWork
 */
export async function getTraeWorkCheckinStatus(token, options = {}) {
  if (!token) return { ok: false, msg: "TraeWork token not available" };

  const psd = options.providerSpecificData || {};
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": `Trae/${psd.ideVersion || "0.1.52"}`,
    Authorization: `Cloud-IDE-JWT ${token}`,
    "X-User-Region": "CN",
    "x-device-brand": psd.deviceBrand || "20Y5A002XX",
    "x-device-type": "windows",
    "x-os-version": psd.osVersion || "Windows 10 Pro",
    "x-app-version": psd.ideVersion || "0.1.52",
    ...(psd.deviceId ? { "x-device-id": psd.deviceId } : {}),
  };

  const statusUrl = "https://api.trae.cn/trae/api/v2/ug/checkin_credits/status";
  try {
    const res = await proxyAwareFetch(
      statusUrl,
      { method: "POST", headers, body: "{}" },
      options.proxyOptions
    );
    const json = await res.json().catch(() => null);
    if (!res.ok && !json) {
      return { ok: false, http: res.status, msg: `HTTP ${res.status}` };
    }

    const checkedIn = json?.checked_in === true;
    const credits = json?.credits || 0;
    const enable = json?.enable !== false;

    return {
      ok: json?.code === 0,
      http: res.status,
      biz_code: json?.code,
      alreadyCheckedIn: checkedIn,
      msg: json?.message || json?.msg || "OK",
      data: {
        today_checked_in: checkedIn,
        credits,
        enable,
        raw: json,
      },
      authExpired: res.status === 401 || res.status === 403,
    };
  } catch (err) {
    return { ok: false, msg: err.message };
  }
}

const CHECKIN_HANDLERS = {
  "codebuddy-cn": (c) =>
    checkinCodeBuddyCn(c.accessToken || c.apiKey, {
      uid: extractUid(c.accessToken || c.apiKey, c),
      proxyOptions: c.proxyOptions,
    }),
  traework: (c) =>
    checkinTraeWork(c.accessToken, {
      providerSpecificData: c.providerSpecificData,
      proxyOptions: c.proxyOptions,
    }),
};

const STATUS_HANDLERS = {
  "codebuddy-cn": (c) =>
    getCodeBuddyCheckinStatus(c.accessToken || c.apiKey, {
      uid: extractUid(c.accessToken || c.apiKey, c),
      proxyOptions: c.proxyOptions,
    }),
  traework: (c) =>
    getTraeWorkCheckinStatus(c.accessToken, {
      providerSpecificData: c.providerSpecificData,
      proxyOptions: c.proxyOptions,
    }),
};

/**
 * Perform check-in for a provider connection
 */
export async function performCheckinForProvider(connection, proxyOptions = null) {
  const handler = CHECKIN_HANDLERS[connection.provider];
  if (!handler) {
    return {
      ok: false,
      http: 400,
      biz_code: null,
      msg: `Check-in not supported for provider: ${connection.provider}`,
      data: null,
      raw: null,
      authExpired: false,
      alreadyCheckedIn: false,
    };
  }
  return handler({ ...connection, proxyOptions });
}

/**
 * Query check-in activity status for a provider connection
 */
export async function getCheckinStatusForProvider(connection, proxyOptions = null) {
  const handler = STATUS_HANDLERS[connection.provider];
  if (!handler) {
    return {
      ok: false,
      http: 400,
      biz_code: null,
      msg: `Check-in status not supported for provider: ${connection.provider}`,
      data: null,
      raw: null,
      authExpired: false,
      alreadyCheckedIn: false,
    };
  }
  return handler({ ...connection, proxyOptions });
}
