/**
 * TraeWork upstream error handling.
 *
 * The SOLO gateway reports failures as HTTP 200 + `event:error` (e.g. code
 * 4001 "param is invalid" for an unsupported model). Those frames used to be
 * flattened into a normal assistant delta with finish_reason "stop", so an
 * invalid model looked like a successful reply: the dashboard model test saw
 * non-empty content and reported the connection as reachable.
 *
 * These tests lock the corrected contract:
 *   • a leading `event:error` becomes a real JSON error Response (no fake reply)
 *   • invalid-request codes (4xxx) map to 400; other failures to 502
 *   • a healthy stream passes through untouched (no bytes lost to the peek)
 */
import { describe, it, expect, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { TraeWorkExecutor } = await import("../../open-sse/executors/traework.js");

const creds = {
  accessToken: "test-token",
  providerSpecificData: { uid: "1", machineId: "m", deviceId: "d" },
};

function sseResponse(frames) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function execute(model) {
  const executor = new TraeWorkExecutor();
  return executor.execute({
    model,
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: false,
    credentials: creds,
  });
}

describe("TraeWorkExecutor — upstream event:error", () => {
  it("converts a leading error frame into a 400 JSON error (invalid param)", async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'event:error\ndata:{"code":4001,"message":"We\'re sorry, the param is invalid. Please try with a valid param.","extra":null}\n\n',
        'event:done\ndata:{"finish_reason":"stop"}\n\n',
      ])
    );

    const result = await execute("glm-5.3-flash");
    const body = await result.response.json();

    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/json");
    expect(body.error.message).toContain("param is invalid");
    expect(body.error.message).not.toContain("4001)"); // code lives in the field, not duplicated in text
    expect(body.error.code).toBe(4001);
    expect(body.error.type).toBe("invalid_request_error");
    // The old bug: a text delta posing as the assistant reply.
    expect(body.choices).toBeUndefined();
  });

  it("parseError extracts the upstream message instead of the raw JSON envelope", async () => {
    const executor = new TraeWorkExecutor();
    const parsed = executor.parseError(
      { status: 400 },
      JSON.stringify({ error: { message: "param is invalid", type: "invalid_request_error", code: 4001 } })
    );
    expect(parsed.status).toBe(400);
    expect(parsed.message).toBe("param is invalid (4001)");
  });

  it("maps a non-4xxx error frame to 502 so account fallback can engage", async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse(['event:error\ndata:{"code":5000,"message":"internal upstream boom"}\n\n'])
    );

    const result = await execute("glm-5.3");
    const body = await result.response.json();

    expect(result.response.status).toBe(502);
    expect(body.error.message).toContain("internal upstream boom");
    expect(body.error.code).toBe(5000);
    expect(body.error.type).toBe("api_error");
  });

  it("keeps a healthy stream as SSE and preserves the output frames", async () => {
    const frames = [
      'event:metadata\ndata:{"model":"","session_id":"s"}\n\n',
      'event:timing_cost\ndata:{"name":"llm_raw_chat_v2"}\n\n',
      'event:output\ndata:{"response":"Hello","reasoning_content":null,"tool_calls":null}\n\n',
      'event:output\ndata:{"response":" there","reasoning_content":null,"tool_calls":null}\n\n',
      'event:done\ndata:{"finish_reason":"stop"}\n\n',
    ];
    fetchMock.mockResolvedValueOnce(sseResponse(frames));

    const result = await execute("glm-5.3");
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("content-type")).toContain("text/event-stream");

    const text = await result.response.text();
    // Both content deltas must survive the pre-flight peek replay.
    expect(text).toContain('"content":"Hello"');
    expect(text).toContain('"content":" there"');
    expect(text).toContain("data: [DONE]");
  });

  it("treats an already-outputted stream as success even if an error follows", async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'event:output\ndata:{"response":"partial"}\n\n',
        'event:output\ndata:{"response":" answer"}\n\n',
        'event:error\ndata:{"code":4001,"message":"late failure"}\n\n',
        'event:done\ndata:{"finish_reason":"stop"}\n\n',
      ])
    );

    const result = await execute("glm-5.3");
    expect(result.response.status).toBe(200);

    const text = await result.response.text();
    expect(text).toContain('"content":"partial"');
    expect(text).toContain('"content":" answer"');
    // The mid-stream error frame is surfaced as an SSE error chunk, not a reply.
    expect(text).toContain('"type":"api_error"');
  });
});
