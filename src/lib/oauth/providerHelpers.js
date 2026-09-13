const BASE64_BLOCK_SIZE = 4;

function validateXaiOAuthEndpoint(rawUrl, field) {
  const value = String(rawUrl || "").trim();
  if (!value) throw new Error(`xai discovery ${field} is empty`);
  let parsed;
  try { parsed = new URL(value); } catch (err) {
    throw new Error(`xai discovery ${field} is invalid: ${err.message}`);
  }
  if (parsed.protocol !== "https:") throw new Error(`xai discovery ${field} must use https: ${value}`);
  const host = parsed.hostname.toLowerCase().trim();
  if (host !== "x.ai" && !host.endsWith(".x.ai")) {
    throw new Error(`xai discovery ${field} host ${host} is not on x.ai`);
  }
  return value;
}

function decodeXaiIdTokenEmail(idToken) {
  if (!idToken || typeof idToken !== "string") return undefined;
  const parts = idToken.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = (BASE64_BLOCK_SIZE - (base64.length % BASE64_BLOCK_SIZE)) % BASE64_BLOCK_SIZE;
    const json = Buffer.from(base64 + "=".repeat(padding), "base64").toString("utf8");
    const payload = JSON.parse(json);
    return payload.email || payload.preferred_username || payload.sub || undefined;
  } catch {
    return undefined;
  }
}

function decodeJwtPayload(jwt) {
  try {
    if (!jwt || typeof jwt !== "string") return null;
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const missingPadding = (BASE64_BLOCK_SIZE - (base64.length % BASE64_BLOCK_SIZE)) % BASE64_BLOCK_SIZE;
    const padded = base64 + "=".repeat(missingPadding);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function extractEmailFromAccessToken(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return undefined;
  return payload.email || payload.preferred_username || payload.sub || undefined;
}

// Keep first 4 + last 4 chars, middle → "***" ("clover.yeq@gmail.com" → "clov***.com").
// Values too short to split 4/4 without overlap keep only the first character.
function maskUsername(name) {
  const s = String(name || "").trim();
  if (!s) return null;
  if (s.length <= 8) return `${s.slice(0, 1)}***`;
  return `${s.slice(0, 4)}***${s.slice(-4)}`;
}

// CodeBuddy access tokens are Keycloak JWTs: sub doubles as the billing
// X-User-Id, preferred_username is the login identity (email/phone) and must
// be masked before it lands anywhere user-visible.
function extractCodebuddyIdentity(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return {};
  const rawUsername = typeof payload.preferred_username === "string" ? payload.preferred_username.trim() : "";
  return {
    uid: payload.sub || null,
    rawUsername,
    maskedName: maskUsername(rawUsername),
  };
}

// Patch for a CodeBuddy OAuth connection missing identity fields: uid (billing
// X-User-Id) from the JWT sub, plus masked display name. "Account…"-prefixed
// default names are replaced too; custom names never are. Null = nothing to do.
function buildCodebuddyIdentityPatch(conn) {
  if (!conn || (conn.provider !== "codebuddy-cn" && conn.provider !== "codebuddy-intl")) return null;
  if (conn.authType !== "oauth" || !conn.accessToken) return null;
  const { uid, rawUsername, maskedName } = extractCodebuddyIdentity(conn.accessToken);
  if (!uid && !maskedName) return null;
  const psd = conn.providerSpecificData || {};
  const patch = {};
  if (uid && !psd.uid) patch.providerSpecificData = { ...psd, uid };
  if (maskedName && (!conn.name || /^Account/.test(conn.name) || conn.name === rawUsername)) {
    patch.name = maskedName;
  }
  return Object.keys(patch).length ? patch : null;
}

export async function fetchKiroProfileArn(accessToken) {
  if (!accessToken) return null;
  try {
    const response = await fetch("https://codewhisperer.us-east-1.amazonaws.com/ListAvailableProfiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ maxResults: 10 }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.profiles?.find((p) => p.arn?.trim())?.arn?.trim() || null;
  } catch {
    return null;
  }
}

export function extractCodexAccountInfo(idToken) {
  const payload = decodeJwtPayload(idToken);
  if (!payload) return {};
  const chatgpt = payload["https://api.openai.com/auth"] || {};
  return {
    email: payload.email,
    chatgptAccountId: chatgpt.chatgpt_account_id || payload.account_id,
    chatgptPlanType: chatgpt.chatgpt_plan_type || payload.plan_type,
  };
}

export {
  BASE64_BLOCK_SIZE,
  validateXaiOAuthEndpoint,
  decodeXaiIdTokenEmail,
  decodeJwtPayload,
  extractEmailFromAccessToken,
  maskUsername,
  extractCodebuddyIdentity,
  buildCodebuddyIdentityPatch,
};
