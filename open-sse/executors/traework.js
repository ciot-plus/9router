import { BaseExecutor } from "./base.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { PROVIDERS } from "../config/providers.js";
import { FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";

const DEFAULT_FUNCTION = "solo_work_lite";
const DEFAULT_IDE_VERSION = "0.1.52";
const DEFAULT_IDE_VERSION_CODE = "20260811";
const DEFAULT_DEVICE_BRAND = "20Y5A002XX";
const DEFAULT_OS_VERSION = "Windows 10 Pro";
const DEFAULT_APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";

const SSE_DONE = "data: [DONE]\n\n";

// Cap for the pre-flight SSE head peek. The decision (first output vs. error)
// normally arrives within a few KB; the cap only guards a stalled upstream.
const SSE_PEEK_MAX_BYTES = 65536;
// Upper bound on the peek. Upstream sends its metadata frame immediately, so a
// valid model decides within milliseconds; this only stops a wedged connection
// from hanging execute() before the stream handler takes over. Timing out is
// fail-open: whatever was read is replayed and streaming proceeds normally.
const SSE_PEEK_TIMEOUT_MS = 15000;

const PEEK_TIMEOUT = Symbol("traework-peek-timeout");

/**
 * Classify the decoded SSE head.
 * Returns { type: "output" } once the model has started producing, or
 * { type: "error", message, code } for an upstream `error` event, else null.
 * Metadata/timing/extra_info frames carry no decision and are skipped.
 * Upstream ordering: error is always first on failure; a healthy stream is
 * metadata → timing_cost → output.
 */
function classifyTraeWorkHead(text) {
  let currentEvent = "";
  let idx = 0;
  while (true) {
    const nl = text.indexOf("\n", idx);
    if (nl === -1) return null;
    const line = text.slice(idx, nl).replace(/\r$/, "");
    idx = nl + 1;

    if (line.startsWith("event:")) {
      currentEvent = line.slice(6).trim();
      continue;
    }
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw) continue;

    if (currentEvent === "output" || currentEvent === "token_usage" || currentEvent === "done") {
      return { type: "output" };
    }
    if (currentEvent === "error") {
      let message = "TraeWork upstream error";
      let code;
      try {
        const payload = JSON.parse(raw);
        if (payload.message) message = payload.message;
        code = payload.code;
      } catch {
        // Non-JSON error payload — keep the fallback message.
      }
      return { type: "error", message, code };
    }
  }
}

/**
 * Peek the SSE head before piping.
 *
 * Upstream reports failures as HTTP 200 + `event:error`, which clients would
 * otherwise see as an empty successful stream (format translators drop
 * choices-less error frames). A leading error is converted into a real JSON
 * error Response so every client format fails the same way and chatCore's
 * account-fallback logic can react. On success the consumed bytes are replayed
 * so nothing is lost.
 *
 * Returns { error } on a leading upstream error, otherwise { response }.
 */
async function peekTraeWorkHead(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let text = "";
  let bytes = 0;
  let decision = null;
  let pendingRead = null;

  const deadline = Date.now() + SSE_PEEK_TIMEOUT_MS;
  try {
    while (bytes < SSE_PEEK_MAX_BYTES) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      let timer;
      const readPromise = reader.read();
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(PEEK_TIMEOUT), remaining);
      });
      const result = await Promise.race([readPromise, timeout]);
      clearTimeout(timer);

      if (result === PEEK_TIMEOUT) {
        // Keep the in-flight read so replay can deliver its bytes — abandoning
        // it would silently drop a chunk.
        pendingRead = readPromise;
        break;
      }

      const { done, value } = result;
      if (done) break;
      if (value?.byteLength) {
        chunks.push(value);
        bytes += value.byteLength;
      }
      text += decoder.decode(value, { stream: true });
      decision = classifyTraeWorkHead(text);
      if (decision) break;
    }
  } catch {
    // Read failure: fall through and replay whatever was captured.
  }

  if (decision?.type === "error") {
    try { await reader.cancel(); } catch { /* noop */ }
    try { reader.releaseLock(); } catch { /* noop */ }
    return { error: decision };
  }

  const replay = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    async pull(controller) {
      try {
        if (pendingRead) {
          const first = pendingRead;
          pendingRead = null;
          const { done, value } = await first;
          if (done) { controller.close(); return; }
          controller.enqueue(value);
          return;
        }
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });

  return {
    response: new Response(replay, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  };
}

/**
 * Build a JSON error Response for a leading upstream SOLO `event:error`.
 * The TraeWork SOLO gateway uses 4xxx codes for invalid-request failures
 * (e.g. 4001 "param is invalid" for an unsupported model); anything else is
 * treated as an upstream failure so account fallback can engage.
 */
function traeWorkErrorResponse(message, code) {
  const numeric = Number(code);
  const isClientError = Number.isFinite(numeric) && numeric >= 4000 && numeric < 5000;
  const status = isClientError ? 400 : 502;
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: isClientError ? "invalid_request_error" : "api_error",
        code: code ?? "",
      },
    }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

const CANONICAL_MODELS = {
  "deepseek-v4-flash-official": { configName: "DeepSeek-V4-Flash-Official", fn: "solo_work_lite" },
};

/**
 * TraeWork (Trae SOLO) Request Payload Transformer
 * Adapts standard OpenAI chat/completions body to Trae SOLO format
 */
export function prepareTraeWorkBody(src, model) {
  if (!src || typeof src !== "object") return src;

  const obj = { ...src };
  const rawModel = (model || obj.model || "glm-5.2").trim();
  const lowerKey = rawModel.toLowerCase();
  const mapped = CANONICAL_MODELS[lowerKey];
  const resolvedModel = mapped ? mapped.configName : rawModel;
  const resolvedFunction = mapped ? mapped.fn : (obj.function || DEFAULT_FUNCTION);

  obj.stream = true;
  obj.function = resolvedFunction;
  obj.config_name = resolvedModel;
  obj.model = resolvedModel;

  if (Array.isArray(obj.messages)) {
    obj.messages = obj.messages.map((m) => {
      if (!m || typeof m !== "object") return m;
      const copy = { ...m };
      let role = copy.role;

      // SOLO upstream only supports system, assistant, user, tool (no developer)
      if (role === "developer") {
        copy.role = "system";
        role = "system";
      }

      if (role === "assistant" && Array.isArray(copy.tool_calls)) {
        const kept = [];
        for (const tc of copy.tool_calls) {
          if (!tc || typeof tc !== "object") continue;
          const tcCopy = { ...tc };
          if (tcCopy.function && typeof tcCopy.function === "object") {
            tcCopy.function_call = tcCopy.function;
            delete tcCopy.function;
          }
          if (tcCopy.function_call?.name?.trim?.()) {
            kept.push(tcCopy);
          }
        }
        if (kept.length === 0) {
          delete copy.tool_calls;
        } else {
          copy.tool_calls = kept;
        }
      }

      // SOLO expects content to be array of text blocks: [{ type: "text", text: s }]
      if (typeof copy.content === "string") {
        copy.content = [{ type: "text", text: copy.content }];
      }

      return copy;
    });
  }

  // Normalize tool_choice
  if (obj.tool_choice !== undefined) {
    const tc = obj.tool_choice;
    if (typeof tc === "string") {
      if (tc.toLowerCase() === "none") {
        delete obj.tool_choice;
        delete obj.tools;
        delete obj.functions;
      }
    } else if (tc && typeof tc === "object") {
      const typ = String(tc.type || "").toLowerCase().trim();
      if (typ === "none") {
        delete obj.tool_choice;
        delete obj.tools;
        delete obj.functions;
      } else if (typ === "auto" || typ === "required") {
        obj.tool_choice = typ;
      } else if (typ === "function") {
        const fnName = tc.function?.name || tc.name;
        obj.tool_choice = fnName?.trim?.() || "auto";
      } else {
        delete obj.tool_choice;
      }
    } else {
      delete obj.tool_choice;
    }
  }

  // Normalize tools (SOLO upstream expects function.parameters to be a JSON string)
  if (Array.isArray(obj.tools)) {
    const validTools = [];
    for (const item of obj.tools) {
      if (!item || typeof item !== "object") continue;
      const t = { ...item };
      if (t.function && typeof t.function === "object") {
        const fn = { ...t.function };
        if (fn.parameters && typeof fn.parameters === "object") {
          try {
            fn.parameters = JSON.stringify(fn.parameters);
          } catch {
            // Keep as-is
          }
        }
        t.function = fn;
      }
      validTools.push(t);
    }
    if (validTools.length > 0) {
      obj.tools = validTools;
    } else {
      delete obj.tools;
    }
  }

  return obj;
}

/**
 * Wrap upstream Trae SOLO SSE stream into standard OpenAI streaming chunks
 */
export async function wrapTraeWorkSSE(response, model) {
  if (!response.ok || !response.body) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = response.body.getReader();

  const responseId = `chatcmpl-traework-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  let buffer = "";
  let doneEmitted = false;
  let currentEvent = "";
  let pendingUsage = null;

  function formatChunk(delta, finishReason = null) {
    const chunk = {
      id: responseId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason,
        },
      ],
    };
    if (pendingUsage) {
      chunk.usage = pendingUsage;
    }
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  // Upstream `event:error` frames (e.g. HTTP 200 + {"code":4001,"message":"param
  // is invalid"}) were previously flattened into a normal content delta with
  // finish_reason "stop". That made a rejected request indistinguishable from a
  // successful reply: the dashboard's model test saw non-empty content and
  // reported the model as reachable. An SSE error frame (no choices) is what
  // let downstream — streaming clients and the forced-SSE→JSON aggregator
  // (parseSSEToOpenAIResponse) — treat it as a failed turn instead of an answer.
  function formatError(message, code) {
    const suffix = code === undefined || code === null || String(code) === "" ? "" : ` (${code})`;
    const chunk = {
      id: responseId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [],
      error: { message: `${message}${suffix}`, type: "api_error", code: code ?? "" },
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  const transformStream = new ReadableStream({
    async start(controller) {
      try {
        while (!doneEmitted) {
          const { done, value } = await reader.read();
          if (done) {
            if (!doneEmitted) {
              controller.enqueue(encoder.encode(formatChunk({}, "stop")));
              controller.enqueue(encoder.encode(SSE_DONE));
              doneEmitted = true;
            }
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          let newlineIdx;

          while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
            buffer = buffer.slice(newlineIdx + 1);

            if (line.startsWith("event:")) {
              currentEvent = line.slice(6).trim();
              continue;
            }

            if (line.startsWith(":")) {
              // Comment / keepalive
              continue;
            }

            if (line.startsWith("data:")) {
              const rawData = line.slice(5).trim();
              if (!rawData) continue;

              let payload = null;
              try {
                payload = JSON.parse(rawData);
              } catch {
                continue;
              }

              if (currentEvent === "output") {
                const delta = {};
                if (payload.response) {
                  delta.content = payload.response;
                }
                if (payload.reasoning_content) {
                  delta.reasoning_content = payload.reasoning_content;
                }

                if (Array.isArray(payload.tool_calls) && payload.tool_calls.length > 0) {
                  delta.tool_calls = payload.tool_calls.map((call, idx) => {
                    const c = { ...call };
                    if (c.function_call) {
                      c.function = c.function_call;
                      delete c.function_call;
                    }
                    if (c.function) {
                      delete c.function.namespace;
                      delete c.function.partial_arguments;
                    }
                    if (c.index === undefined) c.index = idx;
                    return c;
                  });
                }

                if (Object.keys(delta).length > 0) {
                  controller.enqueue(encoder.encode(formatChunk(delta, null)));
                }
              } else if (currentEvent === "token_usage") {
                pendingUsage = payload;
              } else if (currentEvent === "done") {
                const finish = payload.finish_reason || "stop";
                controller.enqueue(encoder.encode(formatChunk({}, finish)));
                controller.enqueue(encoder.encode(SSE_DONE));
                doneEmitted = true;
                break;
              } else if (currentEvent === "error") {
                const msg = payload.message || "TraeWork upstream error";
                controller.enqueue(encoder.encode(formatError(msg, payload.code)));
                controller.enqueue(encoder.encode(SSE_DONE));
                doneEmitted = true;
                break;
              }
            } else if (line === "") {
              currentEvent = "";
            }
          }
        }
      } catch (err) {
        if (!doneEmitted) {
          controller.enqueue(encoder.encode(formatError(`TraeWork stream error: ${err.message}`)));
          controller.enqueue(encoder.encode(SSE_DONE));
        }
      } finally {
        controller.close();
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  return new Response(transformStream, {
    status: response.status,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export class TraeWorkExecutor extends BaseExecutor {
  constructor() {
    super("traework", PROVIDERS.traework);
    this.ideVersion = DEFAULT_IDE_VERSION;
  }

  buildHeaders(credentials, stream = true) {
    const token = credentials?.accessToken || "";
    const psd = credentials?.providerSpecificData || {};
    const ideVersion = psd.ideVersion || this.ideVersion || DEFAULT_IDE_VERSION;

    const headers = {
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
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
      "X-OS-Version": psd.osVersion || DEFAULT_OS_VERSION,
      "X-Device-Brand": psd.deviceBrand || DEFAULT_DEVICE_BRAND,
      "Request-Traffic-Type": "prod",
    };

    if (psd.uid) headers["X-Uid"] = psd.uid;
    if (psd.machineId) headers["X-Machine-Id"] = psd.machineId;
    if (psd.deviceId) headers["x-device-id"] = psd.deviceId;

    return headers;
  }

  transformRequest(model, body, stream, credentials) {
    return prepareTraeWorkBody(body, model);
  }

  // Surface the upstream SOLO message instead of the raw JSON envelope, so
  // client-facing errors read "We're sorry, the param is invalid..." rather
  // than a serialized {"error":{...}} blob.
  parseError(response, bodyText) {
    let message = bodyText || `HTTP ${response.status}`;
    const code = response.status;
    try {
      const json = JSON.parse(bodyText);
      const err = json?.error || json;
      if (err?.message) message = err.message;
      const rawCode = err?.code;
      if (rawCode !== undefined && rawCode !== null && String(rawCode) !== "") {
        message = `${message} (${rawCode})`;
      }
    } catch {
      // Non-JSON body — keep as-is.
    }
    return { status: code, message };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const transformedBody = this.transformRequest(model, body, stream, credentials);
    const headers = this.buildHeaders(credentials, true); // SOLO chat upstream always streams
    const url = this.config.baseUrl || "https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat";

    const timeoutMs = this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS;
    const connectCtrl = new AbortController();
    const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
    const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

    let response;
    try {
      response = await proxyAwareFetch(
        url,
        {
          method: "POST",
          headers,
          body: JSON.stringify(transformedBody),
          signal: mergedSignal,
        },
        proxyOptions
      );
    } finally {
      clearTimeout(connectTimer);
    }

    if (!response.ok || !response.body) {
      return { response, url, headers, transformedBody };
    }

    // Surface a leading upstream error as a real HTTP error before streaming:
    // the choices-less error frame would otherwise be dropped by format
    // translators (Claude/Gemini clients) and read as an empty success.
    const peeked = await peekTraeWorkHead(response);
    if (peeked.error) {
      return {
        response: traeWorkErrorResponse(peeked.error.message, peeked.error.code),
        url,
        headers,
        transformedBody,
      };
    }

    const wrapped = await wrapTraeWorkSSE(peeked.response, model);
    return { response: wrapped, url, headers, transformedBody };
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials?.refreshToken) return null;
    try {
      const { refreshTraeworkToken } = await import("../services/tokenRefresh/providers.js");
      const result = await refreshTraeworkToken(credentials.refreshToken, credentials, log);
      if (result) log?.info?.("TOKEN", "traework refreshed");
      return result;
    } catch (error) {
      log?.error?.("TOKEN", `traework refresh error: ${error.message}`);
      return null;
    }
  }
}

export default TraeWorkExecutor;
