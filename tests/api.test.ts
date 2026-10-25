import { describe, expect, it, vi } from "vitest";
import { ApiError, SessionsApi } from "../src/api.js";

const token = { read: async () => "tok", invalidate: vi.fn() };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const session = {
  id: "s-1", title: "demo", status: "active", status_bucket: "working",
  worker_status: "running", connection_status: "connected",
  environment_id: "env-1", last_event_at: "2026-01-01T00:00:00Z",
  tags: ["mcp:claude-sessions-mcp", "spawned-by:tester"],
};

describe("SessionsApi", () => {
  it("creates a session with tags and config, and unwraps {session}", async () => {
    const fetchImpl = vi.fn(async () => json({ session }));
    const api = new SessionsApi({ token, fetchImpl: fetchImpl as unknown as typeof fetch });

    const created = await api.createSession({
      environmentId: "env-1", title: "demo",
      tags: ["mcp:claude-sessions-mcp"], effort: "medium", permissionMode: "auto",
    });

    expect(created.id).toBe("s-1");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/code/sessions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(JSON.parse(init.body as string)).toEqual({
      environment_id: "env-1", title: "demo", tags: ["mcp:claude-sessions-mcp"],
      config: { effort_level: "medium", permission_mode: "auto", origin: "cli" },
    });
  });

  it("sends the model in config only when one is given", async () => {
    const fetchImpl = vi.fn(async () => json({ session }));
    const api = new SessionsApi({ token, fetchImpl: fetchImpl as unknown as typeof fetch });

    await api.createSession({
      environmentId: "env-1", title: "demo", tags: [], effort: "medium",
      permissionMode: "auto", model: "claude-opus-5",
    });
    await api.createSession({
      environmentId: "env-1", title: "demo", tags: [], effort: "medium", permissionMode: "auto",
    });

    const bodies = fetchImpl.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(bodies[0].config).toEqual({
      effort_level: "medium", permission_mode: "auto", origin: "cli", model: "claude-opus-5",
    });
    expect(bodies[1].config).not.toHaveProperty("model");
  });

  it("posts a user message in the event_type envelope the API requires", async () => {
    const fetchImpl = vi.fn(async () => json({ results: [] }));
    const api = new SessionsApi({ token, fetchImpl: fetchImpl as unknown as typeof fetch });

    await api.postUserMessage("s-1", "hello");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/code/sessions/s-1/events");
    expect(JSON.parse(init.body as string)).toEqual({
      events: [{ event_type: "user_message", payload: { type: "user", message: { role: "user", content: "hello" } } }],
    });
  });

  it("posts a control request in the payload-only envelope Claude Code's remote client uses", async () => {
    const fetchImpl = vi.fn(async () => json({ results: [] }));
    const api = new SessionsApi({ token, fetchImpl: fetchImpl as unknown as typeof fetch });

    await api.postControlRequest("s-1", "set-mode-1", { subtype: "set_permission_mode", mode: "plan" });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/code/sessions/s-1/events");
    expect(JSON.parse(init.body as string)).toEqual({
      events: [{ payload: {
        type: "control_request",
        request_id: "set-mode-1",
        request: { subtype: "set_permission_mode", mode: "plan" },
        uuid: expect.stringMatching(/^[0-9a-f-]{36}$/),
      } }],
    });
  });

  it("reconnects a session to its bridge on the environments API with its beta", async () => {
    const fetchImpl = vi.fn(async () => json({ environment_id: "env-1" }));
    const api = new SessionsApi({ token, fetchImpl: fetchImpl as unknown as typeof fetch });

    await api.reconnectSession("env-1", "cse_1");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/environments/env-1/bridge/reconnect");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["anthropic-beta"])
      .toBe("oauth-2025-04-20,environments-2025-11-01");
    expect(JSON.parse(init.body as string)).toEqual({ session_id: "cse_1" });
  });

  it("unwraps the response_shape envelope that only GET of one session uses", async () => {
    const fetchImpl = vi.fn(async () => json({ response_shape: session }));
    const api = new SessionsApi({ token, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await api.getSession("s-1")).status).toBe("active");
  });

  it("carries the cursor and hands back the next one", async () => {
    const fetchImpl = vi.fn(async () => json({ data: [session], next_cursor: "page-2" }));
    const api = new SessionsApi({ token, fetchImpl: fetchImpl as unknown as typeof fetch });

    const page = await api.listSessionsPage({ limit: 100, cursor: "page-1" });

    expect(page.nextCursor).toBe("page-2");
    expect(page.sessions).toHaveLength(1);
    expect(fetchImpl.mock.calls[0][0])
      .toBe("https://api.anthropic.com/v1/code/sessions?limit=100&cursor=page-1");
  });

  it("retries a 429 and then succeeds", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ error: { message: "slow down" } }, 429))
      .mockResolvedValueOnce(json({ data: [session], next_cursor: null }));
    const api = new SessionsApi({ token, fetchImpl: fetchImpl as unknown as typeof fetch, retryDelayMs: 0 });

    expect(await api.listSessions()).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("re-reads the token once on 401 and retries", async () => {
    const invalidate = vi.fn();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ error: { message: "expired" } }, 401))
      .mockResolvedValueOnce(json({ data: [], next_cursor: null }));
    const api = new SessionsApi({
      token: { read: async () => "tok", invalidate },
      fetchImpl: fetchImpl as unknown as typeof fetch, retryDelayMs: 0,
    });

    await api.listSessions();
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it("gives up on a second 401 with an actionable message", async () => {
    const fetchImpl = vi.fn(async () => json({ error: { message: "expired" } }, 401));
    const api = new SessionsApi({
      token, fetchImpl: fetchImpl as unknown as typeof fetch, retryDelayMs: 0,
    });
    await expect(api.listSessions()).rejects.toThrow(/claude \/login/);
  });

  it("does not retry a 400 and carries the request id", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error: { message: "bad" } }, 400, { "request-id": "req_1" }));
    const api = new SessionsApi({
      token, fetchImpl: fetchImpl as unknown as typeof fetch, retryDelayMs: 0,
    });

    const failure = await api.listSessions().catch((e: unknown) => e as ApiError);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(400);
    expect((failure as ApiError).requestId).toBe("req_1");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("archives, unarchives and deletes by path", async () => {
    const fetchImpl = vi.fn(async () => json({ session }));
    const api = new SessionsApi({ token, fetchImpl: fetchImpl as unknown as typeof fetch });

    await api.archiveSession("s-1");
    await api.unarchiveSession("s-1");
    await api.deleteSession("s-1");

    expect(fetchImpl.mock.calls.map(([url, init]) => [
      (url as string).replace("https://api.anthropic.com/v1/code/sessions/", ""),
      (init as RequestInit).method,
    ])).toEqual([["s-1/archive", "POST"], ["s-1/unarchive", "POST"], ["s-1", "DELETE"]]);
  });
});
