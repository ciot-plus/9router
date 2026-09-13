import crypto from "crypto";
import os from "os";
import { TRAEWORK_CONFIG } from "../constants/oauth.js";
import { extractJsonPath } from "./_shared.js";

/**
 * Generate PKCE code_verifier and code_challenge (S256)
 */
function genPKCE() {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * Generate 64-char hex string for machine_id
 */
function genMachineId() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Generate 15-digit numeric string for device_id
 */
function genNumericDeviceId() {
  const n = Math.floor(100000000000000 + Math.random() * 900000000000000);
  return String(n);
}

/**
 * Generate one-time ECDSA P-256 public key PEM for DeviceInfo
 */
function genDevicePublicKeyPEM() {
  try {
    const { publicKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      publicKeyEncoding: {
        type: "spki",
        format: "pem",
      },
    });
    return publicKey;
  } catch (err) {
    console.warn("[TraeWork] Failed to generate EC key:", err.message);
    return "";
  }
}

/**
 * Parse callback parameters from query string or body
 */
function parseCallbackInfo(raw) {
  const text = String(raw || "").trim();

  // Direct token support (JWT or raw token without URL params)
  const clean = text.replace(/^(Cloud-IDE-JWT|Bearer)\s+/i, "").trim();
  if (clean && !clean.includes("?") && !clean.includes("&") && !clean.includes("=") && clean.length > 20) {
    return {
      refreshToken: null,
      authCode: null,
      accessToken: clean,
      host: "https://api.trae.cn",
      loginTraceId: null,
      userInfo: null,
    };
  }

  let queryStr = text;
  if (text.includes("?")) queryStr = text.slice(text.indexOf("?") + 1);
  if (text.startsWith("#")) queryStr = text.slice(1);

  const params = Object.fromEntries(new URLSearchParams(queryStr));
  const pick = (keys) => {
    for (const k of keys) {
      const v = params[k];
      if (v && String(v).trim()) return String(v).trim();
    }
    return null;
  };

  const err = pick(["error", "error_code", "errorCode"]);
  if (err) {
    const desc = pick(["error_description", "error_desc", "message"]);
    throw new Error(desc ? `TraeWork auth failed: ${err} (${desc})` : `TraeWork auth failed: ${err}`);
  }

  let refreshToken = pick(["refreshToken", "refresh_token", "RefreshToken"]);
  let authCode = pick(["authCode", "auth_code", "AuthCode"]);
  let accessToken = pick(["accessToken", "access_token", "Token", "token", "x-cloudide-token"]);
  const host = pick(["host", "loginHost", "login_host", "apiHost", "ApiHost"]) || "https://api.trae.cn";

  // Check authCodeInfo param
  const rawAuthCodeInfo = pick(["authCodeInfo", "auth_code_info"]);
  if (rawAuthCodeInfo && !authCode) {
    try {
      const parsed = JSON.parse(rawAuthCodeInfo);
      authCode = parsed?.AuthCode || parsed?.authCode || parsed?.Result?.AuthCode || rawAuthCodeInfo;
    } catch {
      authCode = rawAuthCodeInfo;
    }
  }

  // Check userJwt param
  const rawUserJwt = pick(["userJwt", "user_jwt"]);
  if (rawUserJwt) {
    try {
      const parsed = JSON.parse(rawUserJwt);
      if (!refreshToken && parsed.RefreshToken) {
        refreshToken = parsed.RefreshToken;
      }
      if (!accessToken && parsed.Token) {
        accessToken = parsed.Token;
      }
    } catch {
      // Ignore parse failure
    }
  }

  const loginTraceId = pick(["loginTraceID", "login_trace_id", "loginTraceId", "state"]);
  let userInfo = null;
  const rawUserInfo = pick(["userInfo", "user_info"]);
  if (rawUserInfo) {
    try {
      userInfo = JSON.parse(rawUserInfo);
    } catch {}
  }

  return { refreshToken, authCode, accessToken, host, loginTraceId, userInfo };
}

/**
 * Exchange AuthCode + CodeVerifier for token (PKCE new flow)
 */
async function exchangeAuthCode({ authCode, codeVerifier, machineId, deviceId, apiHost }) {
  const pubPEM = genDevicePublicKeyPEM();
  const ideVersion = TRAEWORK_CONFIG.ideVersion || "0.1.52";
  const deviceBrand = TRAEWORK_CONFIG.deviceBrand || "20Y5A002XX";
  const osVersion = TRAEWORK_CONFIG.osVersion || "Windows 10 Pro";

  let cpuModel = "";
  try {
    cpuModel = (os.cpus()?.[0]?.model || "").trim();
  } catch {}
  let hostname = "PC";
  try {
    hostname = os.hostname() || "PC";
  } catch {}

  const di = {
    DeviceID: deviceId,
    MachineID: machineId,
    PlatformCode: "SOLO_PC",
    DeviceType: "PC",
    DeviceName: hostname,
    DeviceModel: deviceBrand,
    ClientVersion: ideVersion,
    DevicePublicKey: pubPEM,
    DeviceBrand: deviceBrand,
    DeviceCPU: cpuModel,
    OSInfo: "windows",
    OSVersion: osVersion,
  };

  const body = JSON.stringify({
    ClientID: TRAEWORK_CONFIG.clientId,
    AuthCode: authCode,
    CodeVerifier: codeVerifier,
    DeviceInfo: di,
    IDEVersion: ideVersion,
  });

  const origins = Array.from(
    new Set(
      [
        "https://api.trae.cn",
        apiHost ? apiHost.replace(/\/+$/, "") : null,
        "https://api.trae.com.cn",
      ].filter(Boolean)
    )
  );

  const errors = [];
  for (const origin of origins) {
    const url = `${origin}/trae/api/v3/oauth/ExchangeToken`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": `Trae/${ideVersion}`,
        },
        body,
      });

      const text = await res.text();
      if (!res.ok) {
        errors.push(`${origin} HTTP ${res.status}: ${text.slice(0, 160)}`);
        continue;
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        errors.push(`${origin} invalid JSON`);
        continue;
      }

      const resObj = data?.Result || data?.result || data?.data || data;
      const accessToken =
        resObj?.AccessToken || resObj?.accessToken || resObj?.Token || resObj?.token;
      const refreshToken =
        resObj?.RefreshToken || resObj?.refreshToken || resObj?.refresh_token || "";
      const expiresAt =
        resObj?.TokenExpireAt || resObj?.ExpiresAt || resObj?.expiresAt || 0;

      if (accessToken) {
        return {
          accessToken,
          refreshToken,
          expiresAt: expiresAt > 1e12 ? Math.floor(expiresAt / 1000) : expiresAt,
          host: origin,
        };
      }
      errors.push(`${origin} missing token in response: ${text.slice(0, 160)}`);
    } catch (e) {
      errors.push(`${origin} ${e.message}`);
    }
  }

  throw new Error(`TraeWork AuthCode exchange failed: ${errors.join("; ") || "no response"}`);
}

/**
 * Exchange RefreshToken for AccessToken (Standard Refresh Flow)
 */
async function exchangeRefreshToken(refreshToken, apiHost) {
  const body = JSON.stringify({
    ClientID: TRAEWORK_CONFIG.clientId,
    RefreshToken: refreshToken,
    ClientSecret: "-",
    UserID: "",
  });

  const origins = [
    "https://api.trae.com.cn",
    apiHost ? apiHost.replace(/\/+$/, "") : null,
    "https://api.trae.cn",
  ].filter(Boolean);

  let lastErr = "no response";
  for (const origin of origins) {
    const url = `${origin}/cloudide/api/v3/trae/oauth/ExchangeToken`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": `Trae/${TRAEWORK_CONFIG.ideVersion || "0.1.52"}`,
        },
        body,
      });

      const text = await res.text();
      if (!res.ok) {
        lastErr = `${origin} HTTP ${res.status}`;
        continue;
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        lastErr = `${origin} invalid JSON`;
        continue;
      }

      const resObj = data?.Result || data?.result || data;
      const accessToken = resObj?.Token || resObj?.AccessToken || resObj?.accessToken;
      const newRefreshToken = resObj?.RefreshToken || resObj?.refreshToken || refreshToken;
      const tokenExpireAt = resObj?.TokenExpireAt || resObj?.ExpiresAt || 0;
      const tokenExpireDuration = resObj?.TokenExpireDuration || 0;

      let expiresAt = 0;
      if (tokenExpireAt > 0) {
        expiresAt = tokenExpireAt > 1e12 ? Math.floor(tokenExpireAt / 1000) : tokenExpireAt;
      } else if (tokenExpireDuration > 0) {
        const sec = tokenExpireDuration > 1e9 ? Math.floor(tokenExpireDuration / 1000) : tokenExpireDuration;
        expiresAt = Math.floor(Date.now() / 1000) + sec;
      }

      if (accessToken) {
        return {
          accessToken,
          refreshToken: newRefreshToken,
          expiresAt,
          host: origin,
        };
      }
      lastErr = `${origin} missing Token in response: ${text.slice(0, 160)}`;
    } catch (e) {
      lastErr = `${origin} ${e.message}`;
    }
  }

  throw new Error(`TraeWork refresh exchange failed: ${lastErr}`);
}

/**
 * Fetch User Info (UserID, ScreenName, EnterpriseID)
 */
async function fetchTraeWorkUserInfo(accessToken, apiHost) {
  const origins = [
    "https://api.trae.com.cn",
    apiHost ? apiHost.replace(/\/+$/, "") : null,
    "https://api.trae.cn",
  ].filter(Boolean);

  const body = JSON.stringify({
    ReqSource: "IDE",
    IDEVersion: TRAEWORK_CONFIG.ideVersion || "0.1.52",
  });

  for (const origin of origins) {
    const url = `${origin}/cloudide/api/v3/trae/GetUserInfo`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": `Trae/${TRAEWORK_CONFIG.ideVersion || "0.1.52"}`,
          "X-Cloudide-Token": accessToken,
        },
        body,
      });

      if (!res.ok) continue;
      const data = await res.json();
      const resObj = data?.Result || data?.result || data;
      return {
        uid: resObj?.UserID || resObj?.userId || "",
        nickname: resObj?.ScreenName || resObj?.screenName || resObj?.Nickname || "",
        enterpriseId: resObj?.EnterpriseID || resObj?.enterpriseId || "",
      };
    } catch {
      // Continue to next origin
    }
  }

  return { uid: "", nickname: "", enterpriseId: "" };
}

// Session store for in-flight login flows
const inFlightSessions = new Map();

export function setTraeWorkSession(state, data) {
  if (!state) return;
  const now = Date.now();
  for (const [k, v] of inFlightSessions.entries()) {
    if (now - (v.createdAt || 0) > 600000) {
      inFlightSessions.delete(k);
    }
  }
  inFlightSessions.set(state, {
    ...data,
    createdAt: now,
  });
}

export function getTraeWorkSession(state) {
  if (!state) return null;
  const session = inFlightSessions.get(state);
  if (!session) return null;
  if (Date.now() - (session.createdAt || 0) > 600000) {
    inFlightSessions.delete(state);
    return null;
  }
  return session;
}

export function removeTraeWorkSession(state) {
  inFlightSessions.delete(state);
}

/**
 * TraeWork Provider OAuth implementation for 9router
 */
const traework = {
  config: TRAEWORK_CONFIG,
  flowType: "authorization_code_pkce",
  callbackPath: TRAEWORK_CONFIG.callbackPath || "/authorize",

  prepareConfig: async (config, meta = {}) => {
    const machineId = meta.machineId || config.machineId || genMachineId();
    const deviceId = meta.deviceId || config.deviceId || genNumericDeviceId();
    const { verifier, challenge } = meta.codeVerifier
      ? { verifier: meta.codeVerifier, challenge: meta.codeChallenge || "" }
      : genPKCE();
    const loginTraceId = meta.loginTraceId || meta.loginTraceID || meta.state || config.loginTraceId || crypto.randomUUID();

    return {
      ...config,
      machineId,
      deviceId,
      codeVerifier: verifier,
      codeChallenge: challenge,
      loginTraceId,
      loginTraceID: loginTraceId,
    };
  },

  buildAuthUrl: (config, redirectUri, state, codeChallenge) => {
    const machineId = config.machineId || genMachineId();
    const deviceId = config.deviceId || genNumericDeviceId();
    const effectiveChallenge = codeChallenge || config.codeChallenge || "";
    const codeVerifier = config.codeVerifier || "";
    const loginTraceId = config.loginTraceID || config.loginTraceId || state || crypto.randomUUID();

    // Cache state session for PKCE verification when callback arrives (keyed by both state and loginTraceId)
    const sessionData = {
      machineId,
      deviceId,
      codeVerifier,
      redirectUri,
    };
    if (state) setTraeWorkSession(state, sessionData);
    if (loginTraceId) setTraeWorkSession(loginTraceId, sessionData);

    const url = new URL(config.authorizationUrl || "https://www.trae.cn/authorization");
    const p = url.searchParams;
    p.set("login_version", "1");
    p.set("auth_from", "solo");
    p.set("login_channel", "native_ide");
    p.set("plugin_version", config.pluginVersion || "2.3.73734");
    p.set("auth_type", "local");
    p.set("client_id", config.clientId || "en1oxy7wnw8j9n");
    p.set("redirect", "0");
    p.set("login_trace_id", loginTraceId);
    p.set("auth_callback_url", redirectUri);
    p.set("machine_id", machineId);
    p.set("device_id", deviceId);
    p.set("x_device_id", deviceId);
    p.set("x_machine_id", machineId);
    p.set("x_device_brand", config.deviceBrand || "20Y5A002XX");
    p.set("x_device_type", "windows");
    p.set("x_os_version", config.osVersion || "Windows 10 Pro");
    p.set("x_env", "");
    p.set("x_app_version", config.ideVersion || "0.1.52");
    p.set("x_app_type", "stable");
    p.set("code_challenge", effectiveChallenge);
    p.set("code_challenge_method", "S256");
    p.set("hide_saas_login", "true");
    p.set("channel_name", "common");
    p.set("click_id", `TRAE SOLOSetup-stable-${config.pluginVersion || "2.3.73734"}`);

    return url.toString();
  },

  exchangeToken: async (config, code, redirectUri, codeVerifier, state, meta) => {
    const raw = String(code || "").trim();
    const info = parseCallbackInfo(raw);

    const session =
      (state && getTraeWorkSession(state)) ||
      (info.loginTraceId && getTraeWorkSession(info.loginTraceId)) ||
      null;
    const effectiveMachineId =
      session?.machineId || meta?.machineId || config.machineId || genMachineId();
    const effectiveDeviceId =
      session?.deviceId || meta?.deviceId || config.deviceId || genNumericDeviceId();
    // Prefer the authoritative session verifier that was matched with code_challenge when building auth URL
    const effectiveVerifier =
      session?.codeVerifier || codeVerifier || meta?.codeVerifier || config.codeVerifier || "";

    let tokens = null;

    if (info.authCode && effectiveVerifier) {
      // PKCE Exchange
      tokens = await exchangeAuthCode({
        authCode: info.authCode,
        codeVerifier: effectiveVerifier,
        machineId: effectiveMachineId,
        deviceId: effectiveDeviceId,
        apiHost: info.host,
      });
    } else if (info.refreshToken) {
      // RefreshToken Exchange
      tokens = await exchangeRefreshToken(info.refreshToken, info.host);
    } else if (info.accessToken) {
      // Fallback: direct token
      tokens = {
        accessToken: info.accessToken,
        refreshToken: "",
        expiresAt: Math.floor(Date.now() / 1000) + 86400 * 14,
        host: info.host,
      };
    } else {
      if (info.authCode && !effectiveVerifier) {
        throw new Error("TraeWork authorization code requires codeVerifier. Please retry login via browser.");
      }
      throw new Error("TraeWork callback missing both authCode and refreshToken");
    }

    if (state) removeTraeWorkSession(state);
    if (info.loginTraceId) removeTraeWorkSession(info.loginTraceId);

    return {
      ...tokens,
      machineId: effectiveMachineId,
      deviceId: effectiveDeviceId,
      apiHost: tokens.host || info.host || "https://api.trae.cn",
      callbackUserInfo: info.userInfo,
    };
  },

  postExchange: async (tokens) => {
    let userInfo = await fetchTraeWorkUserInfo(tokens.accessToken, tokens.apiHost);
    if (!userInfo?.uid && tokens.callbackUserInfo) {
      const cbUi = tokens.callbackUserInfo;
      userInfo = {
        uid: cbUi.UserID || cbUi.userId || cbUi.uid || "",
        nickname: cbUi.ScreenName || cbUi.screenName || cbUi.nickname || "",
        enterpriseId: cbUi.TenantID || cbUi.tenantId || cbUi.enterpriseId || "",
      };
    }
    return { userInfo };
  },

  mapTokens: (tokens, extra) => {
    const ui = extra?.userInfo || {};
    const expiresIn = tokens.expiresAt
      ? Math.max(60, Number(tokens.expiresAt) - Math.floor(Date.now() / 1000))
      : 86400 * 14;

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn,
      displayName: ui.nickname || ui.uid || "TraeWork User",
      email: ui.uid ? `${ui.uid}@trae.cn` : undefined,
      providerSpecificData: {
        uid: ui.uid || "",
        nickname: ui.nickname || "",
        enterpriseId: ui.enterpriseId || "",
        machineId: tokens.machineId || "",
        deviceId: tokens.deviceId || "",
        apiHost: tokens.apiHost || "https://api.trae.cn",
        authMethod: "oauth",
      },
    };
  },
};

export default traework;
