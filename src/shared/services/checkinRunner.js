import { updateProviderConnection } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import {
  performCheckinForProvider,
  getCheckinStatusForProvider,
} from "open-sse/services/checkin.js";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import { CHECKIN_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";

/**
 * Execute check-in for a connection:
 * Handles token refresh, check-in execution, retry, and updates DB.
 */
export async function executeCheckinForConnection(connection) {
  if (!connection) {
    return { success: false, error: "Connection is null" };
  }

  const providerId = connection.provider;
  if (!CHECKIN_SUPPORTED_PROVIDERS.includes(providerId) && providerId !== "codebuddy-cn") {
    return {
      success: false,
      error: `Check-in is not supported for ${providerId}`,
    };
  }

  const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
  const proxyOptions = {
    connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
    connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
    connectionNoProxy: proxyConfig.connectionNoProxy || "",
    vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
    strictProxy: false,
  };

  let activeConnection = connection;

  // If OAuth connection has refreshToken, proactively refresh if needed
  if (activeConnection.authType === "oauth" && activeConnection.refreshToken) {
    try {
      const refreshRes = await refreshAndUpdateCredentials(activeConnection, false, proxyOptions);
      if (refreshRes?.connection) {
        activeConnection = refreshRes.connection;
      }
    } catch (e) {
      console.warn("[Check-in] Proactive refresh warning:", e.message);
    }
  }

  // Attempt check-in
  let result = await performCheckinForProvider(activeConnection, proxyOptions);

  // If token expired and it's an OAuth connection with refreshToken, force refresh and retry
  if (result?.authExpired && activeConnection.authType === "oauth" && activeConnection.refreshToken) {
    try {
      const refreshRes = await refreshAndUpdateCredentials(activeConnection, true, proxyOptions);
      if (refreshRes?.connection) {
        activeConnection = refreshRes.connection;
        result = await performCheckinForProvider(activeConnection, proxyOptions);
      }
    } catch (retryErr) {
      console.warn("[Check-in] Forced refresh retry failed:", retryErr.message);
    }
  }

  const isSuccessOrAlready = result.ok || result.alreadyCheckedIn;
  if (!isSuccessOrAlready) {
    return {
      success: false,
      http: result.http,
      biz_code: result.biz_code,
      error: result.msg || "Check-in failed",
      raw: result.raw,
    };
  }

  // On success or alreadyCheckedIn, save check-in info to providerSpecificData
  const nowIso = new Date().toISOString();
  const existingPsd = activeConnection.providerSpecificData || {};
  const creditValue =
    result.data?.total_credits !== undefined
      ? result.data.total_credits
      : result.data?.credits !== undefined
      ? result.data.credits
      : result.data?.credit !== undefined
      ? result.data.credit
      : undefined;

  const updatedPsd = {
    ...existingPsd,
    lastCheckinAt: nowIso,
    todayCheckedIn: true,
    ...(result.data?.streak_days !== undefined ? { streakDays: result.data.streak_days } : {}),
    ...(result.data?.credit !== undefined ? { lastCheckinCredit: result.data.credit } : {}),
    ...(creditValue !== undefined ? { totalCredits: creditValue } : {}),
  };

  await updateProviderConnection(activeConnection.id, {
    providerSpecificData: updatedPsd,
    updatedAt: nowIso,
  });

  return {
    success: true,
    ok: result.ok,
    http: result.http,
    biz_code: result.biz_code,
    alreadyCheckedIn: result.alreadyCheckedIn === true,
    message: result.msg,
    data: result.data || null,
    lastCheckinAt: nowIso,
  };
}

/**
 * Query check-in status for a connection
 */
export async function executeCheckinStatusForConnection(connection) {
  if (!connection) {
    return { success: false, error: "Connection is null" };
  }

  const providerId = connection.provider;
  if (!CHECKIN_SUPPORTED_PROVIDERS.includes(providerId) && providerId !== "codebuddy-cn") {
    return {
      success: false,
      error: `Check-in is not supported for ${providerId}`,
    };
  }

  const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
  const proxyOptions = {
    connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
    connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
    connectionNoProxy: proxyConfig.connectionNoProxy || "",
    vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
    strictProxy: false,
  };

  let activeConnection = connection;

  if (activeConnection.authType === "oauth" && activeConnection.refreshToken) {
    try {
      const refreshRes = await refreshAndUpdateCredentials(activeConnection, false, proxyOptions);
      if (refreshRes?.connection) {
        activeConnection = refreshRes.connection;
      }
    } catch (e) {
      console.warn("[Check-in status] Proactive refresh warning:", e.message);
    }
  }

  let result = await getCheckinStatusForProvider(activeConnection, proxyOptions);

  if (result?.authExpired && activeConnection.authType === "oauth" && activeConnection.refreshToken) {
    try {
      const refreshRes = await refreshAndUpdateCredentials(activeConnection, true, proxyOptions);
      if (refreshRes?.connection) {
        activeConnection = refreshRes.connection;
        result = await getCheckinStatusForProvider(activeConnection, proxyOptions);
      }
    } catch (retryErr) {
      console.warn("[Check-in status] Force refresh retry failed:", retryErr.message);
    }
  }

  if (!result.ok) {
    return {
      success: false,
      http: result.http,
      biz_code: result.biz_code,
      error: result.msg || "Failed to fetch check-in status",
      raw: result.raw,
    };
  }

  const nowIso = new Date().toISOString();
  const existingPsd = activeConnection.providerSpecificData || {};
  const statusCreditValue =
    result.data?.total_credits !== undefined
      ? result.data.total_credits
      : result.data?.credits !== undefined
      ? result.data.credits
      : result.data?.credit !== undefined
      ? result.data.credit
      : undefined;

  const updatedPsd = {
    ...existingPsd,
    todayCheckedIn: result.data?.today_checked_in === true,
    ...(result.data?.streak_days !== undefined ? { streakDays: result.data.streak_days } : {}),
    ...(statusCreditValue !== undefined ? { totalCredits: statusCreditValue } : {}),
    statusCheckedAt: nowIso,
  };

  await updateProviderConnection(activeConnection.id, {
    providerSpecificData: updatedPsd,
    updatedAt: nowIso,
  });

  return {
    success: true,
    http: result.http,
    biz_code: result.biz_code,
    message: result.msg,
    data: result.data,
    todayCheckedIn: result.data?.today_checked_in === true,
    streakDays: result.data?.streak_days ?? null,
    totalCredits: statusCreditValue ?? null,
  };
}
