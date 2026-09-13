import { getSettings, updateSettings, getProviderConnections } from "@/lib/localDb";
import { executeCheckinForConnection } from "./checkinRunner.js";
import { CHECKIN_SUPPORTED_PROVIDERS } from "@/shared/constants/providers.js";

const TICK_INTERVAL_MS = 15_000; // Check clock every 15 seconds

export function parseTargetHour(timeStr, defaultHour = 21) {
  if (typeof timeStr === "number" && timeStr >= 0 && timeStr <= 23) {
    return Math.floor(timeStr);
  }
  if (typeof timeStr === "string") {
    const match = timeStr.match(/^(\d{1,2})/);
    if (match) {
      const h = parseInt(match[1], 10);
      if (h >= 0 && h <= 23) return h;
    }
  }
  return defaultHour;
}

export function getRandomCheckinDelayMs(minMs = 5000, maxMs = 10000) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

export function getLocalDateStr(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const g = (global.__autoCheckin ??= {
  interval: null,
  running: false,
  lastRunDate: null,
  providerLastRunDate: {},
  lastLogTime: 0,
});

/**
 * Execute auto check-in pass for specified provider or all opted-in checkin providers
 * @param {{ force?: boolean, providerId?: string }} options
 */
export async function runAutoCheckinNow(options = {}) {
  const { force = false, providerId = null } = options;
  if (g.running) {
    console.log("[AutoCheckin] Run already in progress, skipping.");
    return { success: false, message: "Already running" };
  }

  const now = new Date();
  const todayStr = getLocalDateStr(now);

  const settings = await getSettings();
  const autoCheckin = settings.autoCheckin || {};

  const enabledProviders = [];
  if (providerId) {
    enabledProviders.push(providerId);
  } else {
    // Check which providers are enabled for auto check-in.
    // Defaults to enabled for codebuddy-cn and traework if autoCheckin was not yet configured.
    const providerConfig = autoCheckin.providers || {};
    const isCodebuddyEnabled = providerConfig["codebuddy-cn"] !== false;
    const isTraeworkEnabled = providerConfig.traework !== false;

    if (isCodebuddyEnabled) enabledProviders.push("codebuddy-cn");
    if (isTraeworkEnabled) enabledProviders.push("traework");

    for (const [pId, enabled] of Object.entries(providerConfig)) {
      if (enabled === true && !enabledProviders.includes(pId)) {
        if (CHECKIN_SUPPORTED_PROVIDERS.includes(pId) || pId === "codebuddy-cn") {
          enabledProviders.push(pId);
        }
      }
    }
  }

  if (enabledProviders.length === 0) {
    console.log("[AutoCheckin] No providers enabled for auto check-in.");
    return { success: true, count: 0, message: "No enabled providers" };
  }

  g.running = true;
  g.lastRunDate = todayStr;
  g.providerLastRunDate ??= {};
  for (const p of enabledProviders) {
    g.providerLastRunDate[p] = todayStr;
  }

  console.log(`[AutoCheckin] Starting auto check-in at ${now.toLocaleTimeString()} (${todayStr}) for providers: [${enabledProviders.join(", ")}]...`);

  let allConnections = [];
  try {
    allConnections = await getProviderConnections();
  } catch (err) {
    console.error("[AutoCheckin] Failed to load provider connections:", err);
    g.running = false;
    return { success: false, error: err.message };
  }

  // Requirement: Even disabled connections (isActive === false) should be checked in!
  const targetConnections = allConnections.filter(
    (c) => enabledProviders.includes(c.provider)
  );

  const updatedProviderLastRun = {
    ...(autoCheckin.providerLastRunDate || {}),
    ...g.providerLastRunDate,
  };

  if (targetConnections.length === 0) {
    console.log("[AutoCheckin] No connections found for enabled providers.");
    g.running = false;
    await updateSettings({
      autoCheckin: {
        ...autoCheckin,
        lastRunDate: todayStr,
        lastRunAt: now.toISOString(),
        providerLastRunDate: updatedProviderLastRun,
      },
    });
    return { success: true, count: 0, message: "No connections" };
  }

  console.log(`[AutoCheckin] Found ${targetConnections.length} accounts to check in. Processing one by one with random 5-10s delay...`);

  const results = [];

  for (let i = 0; i < targetConnections.length; i++) {
    const conn = targetConnections[i];

    // Wait random 5-10 seconds between accounts (starting from second account)
    if (i > 0) {
      const delayMs = getRandomCheckinDelayMs(5000, 10000);
      console.log(`[AutoCheckin] Waiting ${(delayMs / 1000).toFixed(1)}s before checking in account ${i + 1}/${targetConnections.length} (${conn.provider}:${conn.id})...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    console.log(`[AutoCheckin] [${i + 1}/${targetConnections.length}] Checking in ${conn.provider} (${conn.email || conn.displayName || conn.id})...`);

    try {
      const res = await executeCheckinForConnection(conn);
      results.push({
        id: conn.id,
        provider: conn.provider,
        email: conn.email || conn.displayName,
        result: res,
      });

      if (res.success) {
        if (res.alreadyCheckedIn) {
          console.log(`[AutoCheckin] Account ${conn.id}: Already checked in today.`);
        } else {
          console.log(`[AutoCheckin] Account ${conn.id}: Check-in successful!`);
        }
      } else {
        console.warn(`[AutoCheckin] Account ${conn.id}: Check-in failed - ${res.error}`);
      }
    } catch (e) {
      console.error(`[AutoCheckin] Account ${conn.id} error:`, e.message);
      results.push({
        id: conn.id,
        provider: conn.provider,
        error: e.message,
      });
    }
  }

  const finishedAt = new Date().toISOString();
  await updateSettings({
    autoCheckin: {
      ...autoCheckin,
      lastRunDate: todayStr,
      lastRunAt: finishedAt,
      providerLastRunDate: updatedProviderLastRun,
    },
  });

  g.running = false;
  console.log(`[AutoCheckin] Daily auto check-in completed for ${targetConnections.length} accounts.`);

  return {
    success: true,
    count: targetConnections.length,
    results,
    finishedAt,
  };
}

/**
 * Scheduler tick checking local wall clock for each provider's target hour
 */
async function autoCheckinTick() {
  if (g.running) return;

  const now = new Date();
  const currentHour = now.getHours();
  const todayStr = getLocalDateStr(now);

  try {
    const settings = await getSettings();
    const autoCheckin = settings?.autoCheckin || {};
    if (autoCheckin.enabled === false) return;

    const providerConfig = autoCheckin.providers || {};
    const providerTimes = autoCheckin.providerTimes || {};
    const savedProviderLastRun = autoCheckin.providerLastRunDate || {};

    const activeProviders = [];
    if (providerConfig["codebuddy-cn"] !== false) activeProviders.push("codebuddy-cn");
    if (providerConfig.traework !== false) activeProviders.push("traework");

    for (const [pId, enabled] of Object.entries(providerConfig)) {
      if (enabled === true && !activeProviders.includes(pId)) {
        if (CHECKIN_SUPPORTED_PROVIDERS.includes(pId) || pId === "codebuddy-cn") {
          activeProviders.push(pId);
        }
      }
    }

    // Determine which providers are due for auto check-in right now
    const dueProviders = [];
    for (const pId of activeProviders) {
      const timeSetting = providerTimes[pId] || autoCheckin.time || "21:00:00";
      const targetHour = parseTargetHour(timeSetting, 21);

      const memRun = g.providerLastRunDate?.[pId];
      const dbRun = savedProviderLastRun[pId];
      const hasRunToday = memRun === todayStr || dbRun === todayStr;

      if (currentHour >= targetHour && !hasRunToday) {
        dueProviders.push(pId);
      }
    }

    if (dueProviders.length > 0) {
      console.log(`[AutoCheckin] Trigger reached for providers [${dueProviders.join(", ")}] at local hour ${currentHour}. Starting scheduled check-in...`);
      for (const pId of dueProviders) {
        await runAutoCheckinNow({ providerId: pId });
      }
    }
  } catch (err) {
    console.error("[AutoCheckin] Error in tick:", err);
  }
}

/**
 * Start the background scheduler
 */
export function startAutoCheckinScheduler() {
  if (g.interval) return;

  console.log("[AutoCheckin] Auto check-in scheduler started (evaluating hourly triggers, random 5-10s delay).");
  g.interval = setInterval(() => {
    autoCheckinTick().catch((e) => console.error("[AutoCheckin] Tick failed:", e.message));
  }, TICK_INTERVAL_MS);

  // Run initial check on startup
  setTimeout(() => {
    autoCheckinTick().catch(() => {});
  }, 3000);
}

export function stopAutoCheckinScheduler() {
  if (g.interval) {
    clearInterval(g.interval);
    g.interval = null;
  }
}

export function configureAutoCheckin(settings) {
  if (settings?.autoCheckin?.enabled !== false) {
    startAutoCheckinScheduler();
  }
}

export function getAutoCheckinStatus() {
  return {
    running: g.running,
    lastRunDate: g.lastRunDate,
    providerLastRunDate: g.providerLastRunDate,
  };
}
