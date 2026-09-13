/**
 * TraeWork (Trae SOLO) usage handler
 *
 * Fetches user credit quotas from web_user_ent_usage endpoint
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";

const DEFAULT_USAGE_URL = "https://api.trae.cn/trae/api/v2/pay/web_user_ent_usage";

export async function getTraeWorkUsage(accessToken, providerSpecificData = null, proxyOptions = null) {
  if (!accessToken) {
    return { message: "TraeWork credential not available." };
  }

  const psd = providerSpecificData || {};
  const ideVersion = psd.ideVersion || "0.1.52";
  const deviceBrand = psd.deviceBrand || "20Y5A002XX";
  const osVersion = psd.osVersion || "Windows 10 Pro";
  const deviceId = psd.deviceId || "";

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": `Trae/${ideVersion}`,
    Authorization: `Cloud-IDE-JWT ${accessToken}`,
    "X-User-Region": "CN",
    "x-device-brand": deviceBrand,
    "x-device-type": "windows",
    "x-os-version": osVersion,
    "x-app-version": ideVersion,
    ...(deviceId ? { "x-device-id": deviceId } : {}),
  };

  try {
    const response = await proxyAwareFetch(
      DEFAULT_USAGE_URL,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ require_usage: true }),
      },
      proxyOptions
    );

    if (response.status === 401 || response.status === 403) {
      return { message: "TraeWork credential invalid or expired." };
    }

    if (!response.ok) {
      return { message: `TraeWork quota API error (${response.status}).` };
    }

    const data = await response.json();
    const packList = Array.isArray(data?.user_entitlement_pack_list)
      ? data.user_entitlement_pack_list
      : [];

    if (packList.length === 0) {
      return {
        plan: "Trae SOLO",
        message: "TraeWork connected. No credit package found.",
        quotas: {},
      };
    }

    const quotas = {};
    const seenNames = {};

    for (const p of packList) {
      const limit = Number(p?.entitlement_base_info?.quota?.credits_limit) || 0;
      const used = Number(p?.usage?.credits_amount) || 0;

      let baseName =
        p.group_name ||
        p.display_desc ||
        p.entitlement_base_info?.package_name ||
        p.entitlement_base_info?.package_type ||
        "Credits";

      seenNames[baseName] = (seenNames[baseName] || 0) + 1;
      const name = seenNames[baseName] > 1 ? `${baseName} ${seenNames[baseName]}` : baseName;

      quotas[name] = {
        used,
        total: limit,
        remaining: Math.max(0, limit - used),
        unlimited: false,
      };
    }

    return {
      plan: "Trae SOLO",
      quotas,
    };
  } catch (error) {
    return { message: `TraeWork quota error: ${error.message}` };
  }
}
