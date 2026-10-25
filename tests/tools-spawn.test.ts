import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api.js";
import { spawnSession } from "../src/tools.js";
import type { ToolDeps } from "../src/tools.js";
import { SERVER_TAG } from "../src/sessions.js";

const instance = {
  name: "alpha", cwd: "/srv/alpha", pid: 100, environmentId: "env-1",
  capacity: 8, workers: 2, spawnMode: "same-dir",
};

type FakeSession = { environment_id: string; status: string; tags: string[] };

function deps(overrides: {
  existing?: FakeSession[];
  /** Pages the session list hands back, in order; each page but the last carries a cursor. */
  pages?: FakeSession[][];
  endless?: boolean;
  instances?: typeof instance[];
  instance?: typeof instance;
  maxSpawned?: number;
  postFails?: Error;
  deleteFails?: Error;
  /** How the worker answers set_permission_mode; "echo" confirms the mode asked for. */
  modeReply?: "echo" | "silent" | { subtype: string; error?: string; mode?: string };
  /** Thrown by every stream opened, before anything is yielded. */
  streamFails?: Error;
} = {}) {
  const order: string[] = [];
  const createSession = vi.fn(async () => ({ id: "s-new" }));
  const postUserMessage = vi.fn(async () => {
    order.push("prompt");
    if (overrides.postFails) throw overrides.postFails;
  });
  let pending: { requestId: string; mode: string } | null = null;
  const postControlRequest = vi.fn(async (_id: string, requestId: string, request: { mode: string }) => {
    order.push(`control:${request.mode}`);
    pending = { requestId, mode: request.mode };
  });
  const streamEvents = vi.fn(async function* () {
    if (overrides.streamFails) throw overrides.streamFails;
    const reply = overrides.modeReply ?? "echo";
    // An unrelated event and another request's answer come first, as on a live stream.
    yield { id: "1", payload: { event_type: "env_manager_log", payload: {} } };
    yield { id: "2", payload: { event_type: "control_response", payload: { response: {
      request_id: "set-mode-someone-else", subtype: "error", error: "not ours",
    } } } };
    if (!pending || reply === "silent") return;
    const response = reply === "echo"
      ? { subtype: "success", response: { mode: pending.mode === "manual" ? "default" : pending.mode } }
      : { subtype: reply.subtype, error: reply.error, ...(reply.mode ? { response: { mode: reply.mode } } : {}) };
    yield { id: "3", payload: { event_type: "control_response", payload: { response: {
      request_id: pending.requestId, ...response,
    } } } };
  });
  const deleteSession = vi.fn(async () => {
    if (overrides.deleteFails) throw overrides.deleteFails;
  });
  const pages = overrides.pages ?? [overrides.existing ?? []];
  const listSessionsPage = vi.fn(async ({ cursor }: { cursor?: string } = {}) => {
    const index = cursor ? Number(cursor) : 0;
    const last = index >= pages.length - 1;
    return {
      sessions: pages[index] ?? [],
      nextCursor: overrides.endless || !last ? String(index + 1) : null,
    };
  });
  const toolDeps = {
    api: { createSession, postUserMessage, postControlRequest, streamEvents, deleteSession, listSessionsPage },
    discovery: { proc: { list: async () => [] }, readPointers: async () => [] },
    maxSpawned: overrides.maxSpawned ?? 3,
    modeConfirmMs: 50,
    discover: async () => overrides.instances ?? [overrides.instance ?? instance],
  } as unknown as ToolDeps;
  return {
    toolDeps, createSession, postUserMessage, postControlRequest, streamEvents, deleteSession, listSessionsPage, order,
  };
}

const spawned = (n: number) =>
  Array.from({ length: n }, () => ({ environment_id: "env-1", status: "active", tags: [SERVER_TAG] }));

describe("spawn_session", () => {
  it("creates a tagged session and posts the prompt", async () => {
    const { toolDeps, createSession, postUserMessage } = deps();

    const result = await spawnSession(toolDeps, {
      instance: "alpha", prompt: "review the diff", caller: "alpha-prime",
    });

    expect(result.session_id).toBe("s-new");
    expect(createSession).toHaveBeenCalledWith({
      environmentId: "env-1",
      title: "review the diff",
      tags: [SERVER_TAG, "spawned-by:alpha-prime"],
      effort: "medium",
      permissionMode: "auto",
    });
    expect(postUserMessage).toHaveBeenCalledWith("s-new", "review the diff");
    expect(result.permission_mode).toBe("auto");
  });

  it("rejects bypassPermissions instead of downgrading it", async () => {
    const { toolDeps, createSession } = deps();
    await expect(spawnSession(toolDeps, {
      instance: "alpha", prompt: "p", permission_mode: "bypassPermissions",
    })).rejects.toThrow(/bypassPermissions/);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("refuses an environment that is not a live local bridge", async () => {
    const { toolDeps, createSession } = deps();
    await expect(spawnSession(toolDeps, { instance: "elsewhere", prompt: "p" }))
      .rejects.toThrow(/elsewhere/);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("refuses an ambiguous instance name instead of picking the first match", async () => {
    const { toolDeps, createSession } = deps({
      instances: [
        instance,
        { ...instance, pid: 200, cwd: "/srv/alpha-worktree", environmentId: "env-2" },
      ],
    });

    await expect(spawnSession(toolDeps, { instance: "alpha", prompt: "p" }))
      .rejects.toThrow(/matches 2 running bridges.*\/srv\/alpha.*\/srv\/alpha-worktree/s);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("counts its own sessions across every page of the session list", async () => {
    const { toolDeps, createSession, listSessionsPage } = deps({
      pages: [
        Array.from({ length: 100 }, () => ({ environment_id: "env-other", status: "active", tags: [] })),
        spawned(3),
      ],
      maxSpawned: 3,
    });

    await expect(spawnSession(toolDeps, { instance: "alpha", prompt: "p" }))
      .rejects.toThrow(/ceiling/i);
    expect(listSessionsPage).toHaveBeenCalledTimes(2);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("fails closed when the session list never ends, rather than spawning on a partial count", async () => {
    const { toolDeps, createSession } = deps({ endless: true });

    await expect(spawnSession(toolDeps, { instance: "alpha", prompt: "p" }))
      .rejects.toThrow(/cannot be counted completely/i);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("deletes the session when its first prompt cannot be posted", async () => {
    const { toolDeps, deleteSession } = deps({ postFails: new Error("503 from the API") });

    await expect(spawnSession(toolDeps, { instance: "alpha", prompt: "p" }))
      .rejects.toThrow(/s-new.*503 from the API.*has been deleted/s);
    expect(deleteSession).toHaveBeenCalledWith("s-new");
  });

  it("says so when the post failed and the cleanup failed too", async () => {
    const { toolDeps, deleteSession } = deps({
      postFails: new Error("503 from the API"),
      deleteFails: new Error("delete refused"),
    });

    await expect(spawnSession(toolDeps, { instance: "alpha", prompt: "p" }))
      .rejects.toThrow(/s-new.*Deleting it also failed \(delete refused\).*by hand/s);
    expect(deleteSession).toHaveBeenCalledWith("s-new");
  });

  it("refuses when the bridge is full, which would otherwise look like a hang", async () => {
    const { toolDeps, createSession } = deps({ instance: { ...instance, workers: 8, capacity: 8 } });
    await expect(spawnSession(toolDeps, { instance: "alpha", prompt: "p" }))
      .rejects.toThrow(/capacity/i);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("refuses once its own ceiling is reached", async () => {
    const { toolDeps, createSession } = deps({ existing: spawned(3), maxSpawned: 3 });
    await expect(spawnSession(toolDeps, { instance: "alpha", prompt: "p" }))
      .rejects.toThrow(/ceiling/i);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("counts only its own live sessions towards the ceiling", async () => {
    const { toolDeps, createSession } = deps({
      existing: [
        ...spawned(2),
        { environment_id: "env-1", status: "archived", tags: [SERVER_TAG] },
        { environment_id: "env-1", status: "active", tags: [] },
        { environment_id: "env-other", status: "active", tags: [SERVER_TAG] },
      ],
      maxSpawned: 3,
    });
    await spawnSession(toolDeps, { instance: "alpha", prompt: "p" });
    expect(createSession).toHaveBeenCalledOnce();
  });

  it("truncates a long prompt when deriving the title", async () => {
    const { toolDeps, createSession } = deps();
    await spawnSession(toolDeps, { instance: "alpha", prompt: "x".repeat(200) });
    expect(createSession.mock.calls[0][0].title).toHaveLength(60);
  });

  it("adds caller-supplied tags after its own and passes the model through", async () => {
    const { toolDeps, createSession } = deps();

    await spawnSession(toolDeps, {
      instance: "alpha", prompt: "p", caller: "vector-task",
      tags: ["role:vector-prime"], model: "claude-opus-5",
    });

    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      tags: [SERVER_TAG, "spawned-by:vector-task", "role:vector-prime"],
      model: "claude-opus-5",
    }));
  });

  // The bridge ignores config.permission_mode, so the mode is set on the
  // worker and confirmed before the prompt goes in.
  describe("permission_mode", () => {
    it("sets the requested mode on the worker and confirms it before posting the prompt", async () => {
      const { toolDeps, postControlRequest, order } = deps();

      const result = await spawnSession(toolDeps, { instance: "alpha", prompt: "p", permission_mode: "plan" });

      expect(postControlRequest).toHaveBeenCalledWith(
        "s-new", expect.stringMatching(/^set-mode-/), { subtype: "set_permission_mode", mode: "plan" },
      );
      expect(order).toEqual(["control:plan", "prompt"]);
      expect(result.permission_mode).toBe("plan");
    });

    it("sets auto explicitly when no mode is given, rather than trusting the bridge default", async () => {
      const { toolDeps, postControlRequest } = deps();
      await spawnSession(toolDeps, { instance: "alpha", prompt: "p" });
      expect(postControlRequest.mock.calls[0][2]).toEqual({ subtype: "set_permission_mode", mode: "auto" });
    });

    it("accepts manual, which the worker reports as default", async () => {
      const { toolDeps } = deps();
      await expect(spawnSession(toolDeps, { instance: "alpha", prompt: "p", permission_mode: "manual" }))
        .resolves.toMatchObject({ permission_mode: "manual" });
    });

    it("fails the spawn and deletes the session when the worker refuses the mode", async () => {
      const { toolDeps, postUserMessage, deleteSession } = deps({
        modeReply: { subtype: "error", error: "gate not enabled" },
      });

      await expect(spawnSession(toolDeps, { instance: "alpha", prompt: "p", permission_mode: "plan" }))
        .rejects.toThrow(/s-new.*permission_mode "plan" could not be applied.*gate not enabled.*has been deleted/s);
      expect(postUserMessage).not.toHaveBeenCalled();
      expect(deleteSession).toHaveBeenCalledWith("s-new");
    });

    it("fails the spawn when the worker confirms a different mode", async () => {
      const { toolDeps, postUserMessage } = deps({ modeReply: { subtype: "success", mode: "auto" } });

      await expect(spawnSession(toolDeps, { instance: "alpha", prompt: "p", permission_mode: "plan" }))
        .rejects.toThrow(/reports mode "auto" instead/);
      expect(postUserMessage).not.toHaveBeenCalled();
    });

    it("fails the spawn when the worker never answers, instead of running in an unknown mode", async () => {
      const { toolDeps, postUserMessage, deleteSession, streamEvents } = deps({ modeReply: "silent" });
      // Long enough for one reconnect.
      toolDeps.modeConfirmMs = 1500;

      await expect(spawnSession(toolDeps, { instance: "alpha", prompt: "p", permission_mode: "plan" }))
        .rejects.toThrow(/did not confirm it within/);
      expect(postUserMessage).not.toHaveBeenCalled();
      expect(deleteSession).toHaveBeenCalledWith("s-new");
      // A stream that ends without the answer is reopened, not given up on.
      expect(streamEvents.mock.calls.length).toBeGreaterThan(1);
    });

    it("does not retry a stream the API rejects as a bad request", async () => {
      const { toolDeps, streamEvents, deleteSession } = deps({
        streamFails: new ApiError("stream s-new failed (404)", 404, null),
      });

      await expect(spawnSession(toolDeps, { instance: "alpha", prompt: "p", permission_mode: "plan" }))
        .rejects.toThrow(/could not be applied.*404/s);
      expect(streamEvents).toHaveBeenCalledOnce();
      expect(deleteSession).toHaveBeenCalledWith("s-new");
    });

    it("reconnects after a dropped stream and still confirms the mode", async () => {
      const { toolDeps, streamEvents, order } = deps();
      const real = streamEvents.getMockImplementation()!;
      streamEvents.mockImplementationOnce(async function* () { throw new Error("socket hang up"); });
      streamEvents.mockImplementation(real);
      toolDeps.modeConfirmMs = 5000;

      await spawnSession(toolDeps, { instance: "alpha", prompt: "p", permission_mode: "acceptEdits" });

      expect(streamEvents).toHaveBeenCalledTimes(2);
      expect(order).toEqual(["control:acceptEdits", "prompt"]);
    });
  });
});
