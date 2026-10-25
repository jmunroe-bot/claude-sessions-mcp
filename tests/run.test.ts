import { describe, expect, it, vi } from "vitest";
import { parseTarget, runTask, VECTOR_TAG } from "../src/run.js";
import type { RunDeps } from "../src/run.js";

const bridge = {
  name: "alpha", cwd: "/srv/alpha", pid: 1, environmentId: "env-1",
  capacity: 8, workers: 0, spawnMode: "same-dir",
};
const tasksJson = JSON.stringify({ tasks: {
  "ci-monitor": { cron: "17 */3 * * *", prompt_file: "ci-monitor.md" },
  "nightly": { cron: "0 3 * * *", prompt_file: "nightly.md", timeout_min: 5, model: "claude-opus-5" },
  "watch": { cron: "*/30 * * * *", prompt_file: "watch.md", precheck: "list-work" },
  "guarded": { cron: "*/30 * * * *", prompt_file: "g.md", precheck: "list-work", precheck_max_skip_h: 24 },
} });

function resultFrame(isError: boolean) {
  return { id: "9", payload: { event_type: "result", payload: {
    subtype: isError ? "error_during_execution" : "success", is_error: isError,
    result: isError ? "boom" : "done", num_turns: 3, stop_reason: "end_turn",
    permission_denials: [], total_cost_usd: 0.1,
  } } };
}

interface GateOpts {
  precheck?: { code: number; stdout: string } | Error;
  state?: Record<string, { fingerprint: string; ranAt: number }>;
  now?: number;
}

function makeDeps(opts: { frames?: unknown[]; bridges?: typeof bridge[]; archiveFails?: boolean } & GateOpts = {}) {
  const createSession = vi.fn(async () => ({ id: "s-1" }));
  const postUserMessage = vi.fn(async () => {});
  const archiveSession = vi.fn(async (id: string) => {
    if (opts.archiveFails) throw new Error("archive down");
    return { id, status: "archived", tags: [] };
  });
  const streamEvents = vi.fn(async function* () { for (const f of opts.frames ?? []) yield f; });
  const getSession = vi.fn(async (id: string) => ({ id, status: "active" }));
  const listEvents = vi.fn(async () => ({ events: [], resumeCursor: null }));
  const listSessionsPage = vi.fn(async () => ({ sessions: [], nextCursor: null }));
  const readFile = vi.fn(async (p: string) => {
    if (p === "/srv/alpha/.claude/background/tasks.json") return tasksJson;
    throw new Error(`ENOENT ${p}`);
  });
  const state: Record<string, { fingerprint: string; ranAt: number }> = { ...(opts.state ?? {}) };
  const exec = vi.fn(async () => {
    if (opts.precheck instanceof Error) throw opts.precheck;
    return opts.precheck ?? { code: 0, stdout: "" };
  });
  const deps = {
    api: {
      createSession, postUserMessage, archiveSession, streamEvents, getSession, listEvents, listSessionsPage,
    },
    discovery: {}, maxSpawned: 6,
    discover: async () => opts.bridges ?? [bridge],
    readFile,
    exec,
    readState: async (key: string) => state[key] ?? null,
    writeState: async (key: string, value: { fingerprint: string; ranAt: number }) => { state[key] = value; },
    now: () => opts.now ?? 1_000_000_000_000,
  } as unknown as RunDeps;
  return { deps, createSession, postUserMessage, archiveSession, exec, state };
}

describe("parseTarget", () => {
  it("accepts the systemd instance form and the two-argument form", () => {
    expect(parseTarget(["vts--ci-monitor"])).toEqual({ instance: "vts", task: "ci-monitor" });
    expect(parseTarget(["personal-doctor--code-review"]))
      .toEqual({ instance: "personal-doctor", task: "code-review" });
    expect(parseTarget(["vts", "ci-monitor"])).toEqual({ instance: "vts", task: "ci-monitor" });
  });
  it("rejects anything else", () => {
    expect(() => parseTarget(["vts"])).toThrow(/instance--task/);
    expect(() => parseTarget([])).toThrow(/instance--task/);
  });
});

describe("runTask", () => {
  it("spawns a tagged Vector session, waits for its result, archives it and reports success", async () => {
    const { deps, createSession, postUserMessage, archiveSession } = makeDeps({ frames: [resultFrame(false)] });

    const report = await runTask(deps, "alpha", "ci-monitor");

    expect(report).toMatchObject({ ok: true, sessionId: "s-1", outcome: "result" });
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      title: "Вектор Прайм · ci-monitor",
      tags: ["mcp:claude-sessions-mcp", "spawned-by:vector-task", VECTOR_TAG],
      permissionMode: "auto",
    }));
    expect(postUserMessage.mock.calls[0][1]).toContain("/srv/alpha/.claude/background/ci-monitor.md");
    expect(archiveSession).toHaveBeenCalledWith("s-1");
  });

  it("passes the task's model through", async () => {
    const { deps, createSession } = makeDeps({ frames: [resultFrame(false)] });
    await runTask(deps, "alpha", "nightly");
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-opus-5" }));
  });

  it("reports failure on an error result and still archives", async () => {
    const { deps, archiveSession } = makeDeps({ frames: [resultFrame(true)] });
    const report = await runTask(deps, "alpha", "ci-monitor");
    expect(report.ok).toBe(false);
    expect(report.detail).toContain("boom");
    expect(archiveSession).toHaveBeenCalledWith("s-1");
  });

  it("fails before spawning when the task is not in tasks.json", async () => {
    const { deps, createSession } = makeDeps();
    await expect(runTask(deps, "alpha", "nope")).rejects.toThrow(/nope.*tasks\.json/);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("fails before spawning when the bridge is not running", async () => {
    const { deps, createSession } = makeDeps({ bridges: [] });
    await expect(runTask(deps, "alpha", "ci-monitor")).rejects.toThrow(/No running bridge named "alpha"/);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("reports an archive failure without hiding the task's own verdict", async () => {
    const { deps } = makeDeps({ frames: [resultFrame(false)], archiveFails: true });
    const report = await runTask(deps, "alpha", "ci-monitor");
    expect(report.ok).toBe(false);
    expect(report.detail).toMatch(/archive down/);
  });
});

describe("runTask precheck gate", () => {
  const HOUR = 3_600_000;

  it("does not run a precheck for a task without one", async () => {
    const { deps, exec, createSession } = makeDeps({ frames: [resultFrame(false)] });
    await runTask(deps, "alpha", "ci-monitor");
    expect(exec).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalled();
  });

  it("runs the precheck in the project directory", async () => {
    const { deps, exec } = makeDeps({ precheck: { code: 0, stdout: "" } });
    await runTask(deps, "alpha", "watch");
    expect(exec).toHaveBeenCalledWith("list-work", "/srv/alpha", expect.any(Number));
  });

  it("skips without spawning when the precheck reports no work", async () => {
    const { deps, createSession } = makeDeps({ precheck: { code: 0, stdout: "  \n" } });
    const report = await runTask(deps, "alpha", "watch");
    expect(report).toMatchObject({ ok: true, sessionId: null, outcome: "skipped" });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("runs when there is work and records it after a successful run", async () => {
    const { deps, createSession, state } = makeDeps({
      precheck: { code: 0, stdout: "event 1\n" }, frames: [resultFrame(false)],
    });
    const report = await runTask(deps, "alpha", "watch");
    expect(report.ok).toBe(true);
    expect(createSession).toHaveBeenCalled();
    expect(state["alpha--watch"]).toMatchObject({ ranAt: 1_000_000_000_000 });
    expect(state["alpha--watch"].fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("skips when the work is the same as at the last successful run", async () => {
    const first = makeDeps({ precheck: { code: 0, stdout: "event 1" }, frames: [resultFrame(false)] });
    await runTask(first.deps, "alpha", "watch");
    const again = makeDeps({ precheck: { code: 0, stdout: "event 1\n" }, state: first.state });
    const report = await runTask(again.deps, "alpha", "watch");
    expect(report.outcome).toBe("skipped");
    expect(again.createSession).not.toHaveBeenCalled();
  });

  it("runs again when the work changed", async () => {
    const first = makeDeps({ precheck: { code: 0, stdout: "event 1" }, frames: [resultFrame(false)] });
    await runTask(first.deps, "alpha", "watch");
    const again = makeDeps({ precheck: { code: 0, stdout: "event 1\nevent 2" }, state: first.state, frames: [resultFrame(false)] });
    await runTask(again.deps, "alpha", "watch");
    expect(again.createSession).toHaveBeenCalled();
  });

  it("does not record the work when the run failed, so the next firing retries it", async () => {
    const { deps, state } = makeDeps({ precheck: { code: 0, stdout: "event 1" }, frames: [resultFrame(true)] });
    await runTask(deps, "alpha", "watch");
    expect(state["alpha--watch"]).toBeUndefined();
  });

  it("fails open: a failing precheck runs the task and records nothing", async () => {
    const { deps, createSession, state } = makeDeps({ precheck: { code: 3, stdout: "" }, frames: [resultFrame(false)] });
    const report = await runTask(deps, "alpha", "watch");
    expect(createSession).toHaveBeenCalled();
    expect(report.ok).toBe(true);
    expect(state["alpha--watch"]).toBeUndefined();
  });

  it("fails open when the precheck cannot be started at all", async () => {
    const { deps, createSession } = makeDeps({ precheck: new Error("spawn bash ENOENT"), frames: [resultFrame(false)] });
    await runTask(deps, "alpha", "watch");
    expect(createSession).toHaveBeenCalled();
  });

  it("forces a run once precheck_max_skip_h has passed since the last real run", async () => {
    const t0 = 1_000_000_000_000;
    const { deps, createSession } = makeDeps({
      precheck: { code: 0, stdout: "" }, frames: [resultFrame(false)], now: t0 + 25 * HOUR,
      state: { "alpha--guarded": { fingerprint: "", ranAt: t0 } },
    });
    await runTask(deps, "alpha", "guarded");
    expect(createSession).toHaveBeenCalled();
  });

  it("keeps skipping inside precheck_max_skip_h", async () => {
    const t0 = 1_000_000_000_000;
    const { deps, createSession } = makeDeps({
      precheck: { code: 0, stdout: "" }, now: t0 + 23 * HOUR,
      state: { "alpha--guarded": { fingerprint: "", ranAt: t0 } },
    });
    const report = await runTask(deps, "alpha", "guarded");
    expect(report.outcome).toBe("skipped");
    expect(createSession).not.toHaveBeenCalled();
  });
});
