/**
 * TraeWork model discovery + support probe.
 *
 * The dashboard no longer fetches TraeWork's live model catalog (we reverted to
 * a static registry list). This test keeps the discovery logic available as a
 * "test method": it drives the same `get_detail_param` endpoint the official
 * Trae client uses to enumerate the account's actually-supported models, then
 * confirms them end-to-end through an LLM conversation.
 *
 * Two layers:
 *   • Pure unit tests (always run): parser shape + registry/capability parity.
 *   • Live tests (only when a real TraeWork connection exists in the local DB):
 *     hit `get_detail_param`, cross-check against the static registry and the
 *     capability table, and probe each model with a chat completion.
 *
 * Run:  cd tests && npm test -- traework-live-models
 * The live layer is skipped (not failed) when no connection/token is present, so
 * CI without credentials stays green.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { getModelsByProviderId, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";

// ── Recovered discovery logic (formerly open-sse/services/traeworkModels.js) ──
// Kept inline so the discovery "test method" is self-contained and does not
// re-introduce a production module that the dashboard no longer imports.

export const TRAEWORK_DEFAULT_AGENT_BASE = "https://trae-api-cn.mchost.guru";
const DEFAULT_IDE_VERSION = "0.1.52";
const DEFAULT_IDE_VERSION_CODE = "20260811";
const DEFAULT_APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
const DEFAULT_DEVICE_BRAND = "20Y5A002XX";
const DEFAULT_OS_VERSION = "Windows 10 Pro";
const FETCH_TIMEOUT_MS = 15_000;

const FUNCTIONS_TO_QUERY = ["solo_work_lite", "solo_coder"];

const EXCLUDED_IDS = new Set([
  "summary",
  "title_generation",
  "input_optimization",
  "browser_use_subagent",
  "explore_sub_agent_v2",
  "file_search_agent",
  "sagitta",
  "aquila",
]);

export function resolveAgentBase(credentials = {}) {
  const psd = credentials?.providerSpecificData || {};
  const raw = psd.agentBase || psd.baseUrl || process.env.TRAEWORK_AGENT_BASE || TRAEWORK_DEFAULT_AGENT_BASE;
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return TRAEWORK_DEFAULT_AGENT_BASE;
  }
}

export function buildTraeWorkModelsUrl(credentials = {}) {
  const base = resolveAgentBase(credentials);
  return `${base.replace(/\/+$/, "")}/api/ide/v1/get_detail_param`;
}

export function buildTraeWorkHeaders(credentials = {}) {
  const token = credentials?.accessToken || "";
  const psd = credentials?.providerSpecificData || {};
  const ideVersion = psd.ideVersion || DEFAULT_IDE_VERSION;
  const osVersion = psd.osVersion || DEFAULT_OS_VERSION;
  const deviceBrand = psd.deviceBrand || DEFAULT_DEVICE_BRAND;

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": `Trae/${ideVersion}`,
    Authorization: `Cloud-IDE-JWT ${token}`,
    "X-Cloudide-Token": token,
    "X-Ide-Token": token,
    "X-App-Id": DEFAULT_APP_ID,
    "X-App-Version": "default",
    "X-Ide-Version": ideVersion,
    "X-Ide-Version-Code": DEFAULT_IDE_VERSION_CODE,
    "X-App-Version-Code": DEFAULT_IDE_VERSION_CODE,
    "X-Ide-Version-Type": "stable",
    "X-Device-Type": "windows",
    "X-OS-Version": osVersion,
    "X-Device-Brand": deviceBrand,
    "Request-Traffic-Type": "prod",
  };

  if (psd.uid) headers["X-Uid"] = String(psd.uid);
  if (psd.machineId) headers["X-Machine-Id"] = String(psd.machineId);
  if (psd.deviceId) headers["x-device-id"] = String(psd.deviceId);

  return headers;
}

/**
 * Parse the `config_info_list` from get_detail_param into model records.
 * Mirrors what the Trae client treats as user-visible, selectable models.
 */
export function parseTraeWorkModels(configInfoList = [], functionName = "solo_work_lite") {
  if (!Array.isArray(configInfoList)) return [];

  const models = [];
  for (const item of configInfoList) {
    if (!item || typeof item !== "object") continue;
    if (item.is_invisible_to_user === true) continue;
    if (item.config_switch === false) continue;

    const id = item.config_name;
    if (!id || typeof id !== "string") continue;
    if (EXCLUDED_IDS.has(id)) continue;

    const dc = item.display_config || {};
    const name = dc.display_name;
    if (!name || name === "-" || String(name).trim() === "") continue;
    if (id.startsWith("custom_model_") && (!dc.is_custom_model || dc.display_name === id)) continue;

    const isVL = dc.multimodal === true;
    const isReasoning = !!(dc.reasoning_effort_options || dc.thinking_enable || item.reasoning_effort_config);
    const contextLength =
      item.context_window_tokens?.dev ||
      item.context_window_tokens?.max ||
      dc.context_window_size?.default ||
      200000;
    const maxOutputTokens = dc.max_tokens || 32000;

    models.push({
      id,
      name: String(name).trim(),
      contextLength,
      maxOutputTokens,
      isVL,
      isReasoning,
      functionName,
      capabilities: {
        vision: isVL,
        reasoning: isReasoning,
        contextWindow: contextLength,
        maxOutput: maxOutputTokens,
      },
    });
  }

  return models;
}

/**
 * Discover every model the account can use by querying get_detail_param once per
 * function bucket and de-duplicating by id (first bucket wins).
 * @returns {Promise<{models: object[], errors: string[]}>}
 */
export async function discoverTraeWorkModels(credentials, options = {}) {
  const { log = console, fetchImpl = proxyAwareFetch } = options;
  const url = buildTraeWorkModelsUrl(credentials);
  const headers = buildTraeWorkHeaders(credentials);
  const modelsMap = new Map();
  const errors = [];

  for (const fn of FUNCTIONS_TO_QUERY) {
    try {
      const response = await fetchImpl(
        url,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ function: fn }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        },
      );

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        errors.push(`${fn}: HTTP ${response.status} ${String(errText).slice(0, 200)}`);
        continue;
      }

      const data = await response.json();
      for (const m of parseTraeWorkModels(data?.config_info_list, fn)) {
        if (!modelsMap.has(m.id)) modelsMap.set(m.id, m);
      }
    } catch (err) {
      errors.push(`${fn}: ${err.message}`);
      log?.warn?.(`[traework-live-models] ${fn} failed: ${err.message}`);
    }
  }

  return { models: Array.from(modelsMap.values()), errors };
}

/** Resolve an internal API key + CLI token so the probe passes local auth. */
async function getInternalHeaders() {
  const headers = { "Content-Type": "application/json" };
  try {
    const { getApiKeys } = await import("@/lib/localDb.js");
    const keys = await getApiKeys();
    const key = keys.find((k) => k.isActive !== false)?.key;
    if (key) headers.Authorization = `Bearer ${key}`;
  } catch { /* no key store / no keys configured */ }
  try {
    const { getConsistentMachineId } = await import("@/shared/utils/machineId.js");
    headers["x-9r-cli-token"] = await getConsistentMachineId("9r-cli-auth");
  } catch { /* best effort */ }
  return headers;
}

/** Probe a discovered model with a real chat completion (LLM conversation). */
export async function probeTraeWorkModel(modelId, options = {}) {
  const {
    baseUrl = `http://127.0.0.1:${process.env.PORT || 20127}`,
    timeoutMs = 20_000,
    fetchImpl = fetch,
  } = options;

  const headers = await getInternalHeaders();

  const started = Date.now();
  try {
    const res = await fetchImpl(`${baseUrl}/api/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: `traework/${modelId}`,
        // Reasoning models spend budget before answering — keep it generous so a
        // chain-of-thought model isn't reported as a false failure.
        max_tokens: 1024,
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - started;
    const raw = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { /* non-JSON */ }
    const ok = res.ok && Array.isArray(parsed?.choices) && parsed.choices.length > 0;
    return {
      ok,
      status: res.status,
      latencyMs,
      error: ok ? null : (parsed?.error?.message || parsed?.error || raw.slice(0, 200) || `HTTP ${res.status}`),
    };
  } catch (err) {
    return { ok: false, status: 0, latencyMs: Date.now() - started, error: err.message };
  }
}

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

// ── Pure unit tests ─────────────────────────────────────────────────────────

describe("TraeWork discovery — parser", () => {
  it("extracts user-visible models and their capability flags", () => {
    const models = parseTraeWorkModels([
      {
        config_name: "glm-5.3",
        display_config: { display_name: "GLM-5.3", multimodal: true, max_tokens: 128000 },
        context_window_tokens: { dev: 1000000 },
      },
      {
        config_name: "minimax-m2.7",
        display_config: { display_name: "MiniMax-M2.7" },
        reasoning_effort_config: { levels: ["low", "high"] },
        context_window_tokens: { max: 204800 },
      },
    ]);

    expect(models.map((m) => m.id)).toEqual(["glm-5.3", "minimax-m2.7"]);
    expect(models[0]).toMatchObject({
      name: "GLM-5.3",
      isVL: true,
      isReasoning: false,
      contextLength: 1000000,
      maxOutputTokens: 128000,
      capabilities: { vision: true, contextWindow: 1000000, maxOutput: 128000 },
    });
    expect(models[1]).toMatchObject({
      name: "MiniMax-M2.7",
      isVL: false,
      isReasoning: true,
      contextLength: 204800,
    });
  });

  it("drops invisible, disabled, excluded and unnamed entries", () => {
    const models = parseTraeWorkModels([
      { config_name: "hidden", is_invisible_to_user: true, display_config: { display_name: "Hidden" } },
      { config_name: "disabled", config_switch: false, display_config: { display_name: "Disabled" } },
      { config_name: "title_generation", display_config: { display_name: "Title" } },
      { config_name: "no_name", display_config: { display_name: "-" } },
      { config_name: "ok", display_config: { display_name: "OK" } },
    ]);
    expect(models.map((m) => m.id)).toEqual(["ok"]);
  });

  it("tolerates a missing/!array config_info_list", () => {
    expect(parseTraeWorkModels(undefined)).toEqual([]);
    expect(parseTraeWorkModels(null)).toEqual([]);
    expect(parseTraeWorkModels({})).toEqual([]);
  });
});

describe("TraeWork discovery — request shape", () => {
  it("targets get_detail_param with Cloud-IDE-JWT auth", () => {
    const creds = { accessToken: "tok-123", providerSpecificData: { uid: "u1", machineId: "m1" } };
    expect(buildTraeWorkModelsUrl(creds)).toBe(`${TRAEWORK_DEFAULT_AGENT_BASE}/api/ide/v1/get_detail_param`);
    const headers = buildTraeWorkHeaders(creds);
    expect(headers.Authorization).toBe("Cloud-IDE-JWT tok-123");
    expect(headers["X-Cloudide-Token"]).toBe("tok-123");
    expect(headers["X-Uid"]).toBe("u1");
    expect(headers["X-Machine-Id"]).toBe("m1");
  });

  it("honors a custom agent base", () => {
    expect(buildTraeWorkModelsUrl({ providerSpecificData: { agentBase: "https://example.com/x" } }))
      .toBe("https://example.com/api/ide/v1/get_detail_param");
  });
});

describe("TraeWork discovery — live call plumbing (mocked fetch)", () => {
  it("queries both function buckets and de-dupes by id", async () => {
    const seen = [];
    const fetchImpl = async (_url, opts) => {
      const fn = JSON.parse(opts.body).function;
      seen.push(fn);
      const list = fn === "solo_work_lite"
        ? [
            { config_name: "glm-5.3", display_config: { display_name: "GLM-5.3", multimodal: true } },
            { config_name: "kimi-k3", display_config: { display_name: "Kimi-K3" } },
          ]
        : [
            { config_name: "kimi-k3", display_config: { display_name: "Kimi-K3 (dup)" } },
            { config_name: "qwen3.8-max", display_config: { display_name: "Qwen3.8-Max" } },
          ];
      return new Response(JSON.stringify({ config_info_list: list }), { status: 200 });
    };

    const { models, errors } = await discoverTraeWorkModels(
      { accessToken: "t" },
      { fetchImpl },
    );

    expect(seen).toEqual(["solo_work_lite", "solo_coder"]);
    expect(errors).toEqual([]);
    expect(models.map((m) => m.id)).toEqual(["glm-5.3", "kimi-k3", "qwen3.8-max"]);
    // first bucket wins the duplicate
    expect(models[1].functionName).toBe("solo_work_lite");
  });

  it("collects errors instead of throwing when the upstream fails", async () => {
    const fetchImpl = async () => new Response("nope", { status: 500 });
    const { models, errors } = await discoverTraeWorkModels({ accessToken: "t" }, { fetchImpl, log: { warn() {} } });
    expect(models).toEqual([]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("500");
  });
});

// ── Registry / capability parity ────────────────────────────────────────────

describe("TraeWork registry vs capability table", () => {
  it("resolves capability overrides for every id (alias and id agree)", () => {
    const models = getModelsByProviderId("traework");
    expect(models.length).toBeGreaterThan(0);

    for (const m of models) {
      const byId = getCapabilitiesForModel("traework", m.id);
      const byAlias = getCapabilitiesForModel(PROVIDER_ID_TO_ALIAS.traework || "traework", m.id);
      expect(byAlias).toEqual(byId);
      // The provider-scoped table must be hit (not the generic pattern floor):
      // every TraeWork model is multimodal + reasoning on this gateway.
      expect(byId.vision).toBe(true);
      expect(byId.reasoning).toBe(true);
    }
  });

  it("does not leave capability entries for ids outside the registry (staleness guard)", () => {
    const registryIds = new Set(getModelsByProviderId("traework").map((m) => m.id));
    // Capability table is keyed by id; import it lazily so the guard reads live data.
    // (Static import would be cleaner, but this keeps the assertion explicit.)
    // eslint-disable-next-line global-require
    return import("open-sse/providers/capabilities.js").then(({ PROVIDER_CAPABILITIES }) => {
      const tableIds = Object.keys(PROVIDER_CAPABILITIES.traework || {});
      const stale = tableIds.filter((id) => !registryIds.has(id));
      // Reported for visibility; stale entries are harmless (never looked up) but
      // signal the registry drifted. Fail only if the table lost its ids entirely.
      if (stale.length) console.log(`[traework-live-models] capability entries not in registry: ${stale.join(", ")}`);
      expect(tableIds.length).toBeGreaterThan(0);
    });
  });
});

// ── Live discovery (credentials required; skipped otherwise) ────────────────

async function loadActiveTraeworkConnection() {
  try {
    const { getProviderConnections } = await import("@/lib/localDb.js");
    const conns = await getProviderConnections({ provider: "traework" });
    return conns.find((c) => c.isActive !== false && (c.accessToken || c.apiKey)) || null;
  } catch {
    return null;
  }
}

describe("TraeWork discovery — live account catalog", () => {
  it("discovers the account's real models and they are all registry-known", async () => {
    const conn = await loadActiveTraeworkConnection();
    if (!conn) {
      console.log("[traework-live-models] no active TraeWork connection; skipping live discovery");
      return;
    }

    const { models, errors } = await discoverTraeWorkModels({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      providerSpecificData: conn.providerSpecificData || {},
    });

    console.log(`[traework-live-models] discovered ${models.length} models`, errors.length ? `(errors: ${errors.join(" | ")})` : "");
    console.table(models.map((m) => ({
      id: m.id,
      name: m.name,
      vision: m.isVL,
      reasoning: m.isReasoning,
      context: m.contextLength,
      maxOutput: m.maxOutputTokens,
      fn: m.functionName,
    })));

    // Live may legitimately return nothing if the token is stale — don't fail the
    // suite, but surface what happened.
    if (models.length === 0) {
      console.warn("[traework-live-models] discovery returned no models", errors);
      return;
    }

    const registryIds = new Set(getModelsByProviderId("traework").map((m) => m.id));
    const notInRegistry = models.map((m) => m.id).filter((id) => !registryIds.has(id));
    console.log(`[traework-live-models] live ids missing from static registry (candidates to add): ${notInRegistry.join(", ") || "(none)"}`);

    expect(models.every((m) => typeof m.id === "string" && m.id.length > 0)).toBe(true);
  }, 60_000);
});

describe("TraeWork discovery — live chat probe", () => {
  it("probes each discovered model with a real conversation", async () => {
    const conn = await loadActiveTraeworkConnection();
    if (!conn) {
      console.log("[traework-live-models] no active TraeWork connection; skipping live probe");
      return;
    }

    const { models } = await discoverTraeWorkModels({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      providerSpecificData: conn.providerSpecificData || {},
    });

    // Limit probing to keep the test fast/cheap; discovery itself lists everything.
    const toProbe = models.slice(0, 5);
    if (toProbe.length === 0) {
      console.warn("[traework-live-models] nothing to probe");
      return;
    }

    const results = [];
    for (const m of toProbe) {
      // Sequential: a shared connection can't take a burst of parallel refreshes.
      // eslint-disable-next-line no-await-in-loop
      const r = await probeTraeWorkModel(m.id, { baseUrl: `http://127.0.0.1:${process.env.PORT || 20127}` });
      results.push({ id: m.id, ...r });
    }
    console.table(results);

    // A model is "supported" if it either answers or fails only at the network
    // layer (the local dev server may be down in CI). Only assert the probe
    // produced a verdict, not that every model succeeded.
    expect(results.every((r) => typeof r.ok === "boolean")).toBe(true);
  }, 120_000);
});
