import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api.js";
import { waitForIdle } from "../src/tools.js";
import type { ToolDeps } from "../src/tools.js";

const resultEvent = {
  id: "12", event: "client_event",
  payload: {
    event_type: "result",
    payload: {
      subtype: "success", is_error: false, result: "done", num_turns: 1,
      stop_reason: "end_turn", permission_denials: [], total_cost_usd: 0.25,
    },
  },
};

/** A session event as the list endpoint returns it. */
function listed(sequence: number, eventType: string, payload: Record<string, unknown> = {}) {
  return { sequence_num: String(sequence), event_type: eventType, payload };
}

/** A stream frame carrying a result, numbered the way the live API numbers it. */
function resultFrame(sequence: number, text: string) {
  return {
    id: String(sequence), event: "client_event",
    payload: {
      sequence_num: String(sequence), event_type: "result",
      payload: { ...resultEvent.payload.payload, result: text },
    },
  };
}

function depsWithStream(
  frames: unknown[][],
  /** Session status per getSession call; the last entry repeats. */
  statuses: string[] = ["active"],
  /** What listEvents returns, newest first, as the live API orders it. */
  events: unknown[] = [],
): {
  toolDeps: ToolDeps;
  streamEvents: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  listEvents: ReturnType<typeof vi.fn>;
} {
  let call = 0;
  const streamEvents = vi.fn(async function* (_id: string, _opts: { lastEventId?: string }) {
    for (const frame of frames[call] ?? []) yield frame;
    call++;
  });
  let statusCall = 0;
  const getSession = vi.fn(async (id: string) => {
    const status = statuses[Math.min(statusCall, statuses.length - 1)] ?? "active";
    statusCall += 1;
    return { id, status };
  });
  const listEvents = vi.fn(async (_id: string, _opts: { limit?: number }) => ({
    events, resumeCursor: null,
  }));
  return {
    toolDeps: {
      api: { streamEvents, getSession, listEvents }, discovery: {}, maxSpawned: 3,
    } as unknown as ToolDeps,
    streamEvents,
    getSession,
    listEvents,
  };
}

describe("wait_for_idle", () => {
  it("stops immediately when the session is already archived", async () => {
    const { toolDeps, streamEvents } = depsWithStream([[resultEvent]], ["archived"]);

    const outcome = await waitForIdle(toolDeps, { session_id: "s-1", timeout_s: 60 });

    expect(outcome).toMatchObject({ finished: false, outcome: "archived" });
    expect(outcome.note).toMatch(/archived/i);
    // An archived session never emits a result, so opening the stream at all
    // would be waiting for something that cannot arrive.
    expect(streamEvents).not.toHaveBeenCalled();
  });

  it("stops waiting once the session is archived mid-wait", async () => {
    vi.useFakeTimers();
    // The stream stays silent; only the status poll can end this wait.
    const { toolDeps } = depsWithStream([], ["active", "active", "archived"]);

    const pending = waitForIdle(toolDeps, { session_id: "s-1", timeout_s: 600 });
    await vi.advanceTimersByTimeAsync(20_000);
    const outcome = await pending;

    expect(outcome).toMatchObject({ finished: false, outcome: "archived" });
  });

  it("stops waiting when the session has been deleted", async () => {
    const { toolDeps, streamEvents } = depsWithStream([[resultEvent]]);
    (toolDeps.api.getSession as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiError("Session s-1 not found", 404, null),
    );

    const outcome = await waitForIdle(toolDeps, { session_id: "s-1", timeout_s: 60 });

    expect(outcome).toMatchObject({ finished: false, outcome: "deleted" });
    expect(streamEvents).not.toHaveBeenCalled();
  });

  it("keeps waiting when a status check itself fails", async () => {
    const { toolDeps } = depsWithStream([[resultEvent]]);
    (toolDeps.api.getSession as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiError("upstream hiccup", 503, null),
    );

    const outcome = await waitForIdle(toolDeps, { session_id: "s-1", timeout_s: 60 });

    // A failed status check must not be read as "the session is gone".
    expect(outcome).toMatchObject({ finished: true, outcome: "result" });
  });

  it("returns the turn's result", async () => {
    const { toolDeps } = depsWithStream([[
      { id: "11", event: "client_event", payload: { event_type: "assistant", payload: {} } },
      resultEvent,
    ]]);

    const outcome = await waitForIdle(toolDeps, { session_id: "s-1", timeout_s: 5 });

    expect(outcome.finished).toBe(true);
    expect(outcome.result).toEqual({
      text: "done", isError: false, stopReason: "end_turn",
      numTurns: 1, permissionDenials: [], costUsd: 0.25,
    });
  });

  it("skips a replayed result from an earlier turn and returns the current one", async () => {
    // Mid-turn: the newest events are the new prompt and the work on it. The
    // stream replays the whole history, earlier turn's result included.
    const { toolDeps, streamEvents } = depsWithStream([[
      resultFrame(12, "first turn"),
      { id: "19", event: "client_event", payload: { sequence_num: "19", event_type: "user", payload: {} } },
      { id: "20", event: "client_event", payload: { sequence_num: "20", event_type: "assistant", payload: {} } },
      { id: "21", event: "client_event", payload: { sequence_num: "21", event_type: "assistant", payload: {} } },
      resultFrame(22, "second turn"),
    ]], ["active"], [
      listed(20, "assistant"), listed(19, "user"), listed(18, "system"), listed(12, "result"),
    ]);

    const outcome = await waitForIdle(toolDeps, { session_id: "s-1", timeout_s: 5 });

    expect(outcome).toMatchObject({ finished: true, outcome: "result" });
    expect(outcome.result?.text).toBe("second turn");
    // Resumed from the newest event, so a server that honours it skips the replay.
    expect(streamEvents.mock.calls[0][1]).toMatchObject({ lastEventId: "20" });
  });

  it("returns the latest result at once when the session is already idle", async () => {
    // As seen live: control and system events can follow the last result.
    const { toolDeps, streamEvents } = depsWithStream([], ["active"], [
      listed(30, "control_response"), listed(29, "control_request"), listed(28, "system"),
      listed(27, "result", { ...resultEvent.payload.payload, result: "latest turn" }),
      listed(26, "assistant"), listed(25, "user"),
      listed(12, "result", { ...resultEvent.payload.payload, result: "first turn" }),
    ]);

    const outcome = await waitForIdle(toolDeps, { session_id: "s-1", timeout_s: 60 });

    expect(outcome).toMatchObject({ finished: true, outcome: "result" });
    expect(outcome.result?.text).toBe("latest turn");
    expect(streamEvents).not.toHaveBeenCalled();
  });

  it("reconnects from the last seen id when the stream ends early", async () => {
    const { toolDeps, streamEvents } = depsWithStream([
      [{ id: "5", event: "client_event", payload: { event_type: "assistant", payload: {} } }],
      [resultEvent],
    ]);

    vi.useFakeTimers();
    const pending = waitForIdle(toolDeps, { session_id: "s-1", timeout_s: 5 });
    await vi.advanceTimersByTimeAsync(1000);
    const outcome = await pending;

    expect(outcome.finished).toBe(true);
    expect(streamEvents.mock.calls[1][1]).toMatchObject({ lastEventId: "5" });
  });

  it("waits before every reconnect, including after a stream that ended cleanly", async () => {
    // Two consecutive empty streams: nothing throws, so the old code reopened
    // the stream with no pause at all and spun the reconnect loop.
    const { toolDeps, streamEvents } = depsWithStream([[], []]);

    vi.useFakeTimers();
    const pending = waitForIdle(toolDeps, { session_id: "s-1", timeout_s: 10 });

    await vi.advanceTimersByTimeAsync(0);
    expect(streamEvents).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(streamEvents).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(streamEvents).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(10_000);
    const outcome = await pending;

    expect(outcome.finished).toBe(false);
    // One attempt per second of the ten-second budget, give or take the
    // boundary — not the thousands an unthrottled loop would make.
    expect(streamEvents.mock.calls.length).toBeLessThanOrEqual(12);
    expect(streamEvents.mock.calls.length).toBeGreaterThanOrEqual(10);
  });

  it("says the session is still working when the timeout expires", async () => {
    const { toolDeps } = depsWithStream([[], [], []]);
    const outcome = await waitForIdle(toolDeps, { session_id: "s-1", timeout_s: 0 });
    expect(outcome).toMatchObject({ finished: false });
    expect(outcome.note).toMatch(/still working/i);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconnects after a dropped connection rather than failing the wait", async () => {
    let call = 0;
    const streamEvents = vi.fn(async function* (_id: string, _opts: { lastEventId?: string }) {
      if (call === 0) {
        call++;
        yield { id: "7", event: "client_event", payload: { event_type: "assistant", payload: {} } };
        throw new Error("ECONNRESET");
      }
      call++;
      yield resultEvent;
    });
    const toolDeps = {
      api: { streamEvents, listEvents: async () => ({ events: [], resumeCursor: null }) },
      discovery: {}, maxSpawned: 3,
    } as unknown as ToolDeps;

    vi.useFakeTimers();
    const outcome = waitForIdle(toolDeps, { session_id: "s-1", timeout_s: 5 });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await outcome;

    expect(result.finished).toBe(true);
    expect(result.result).toEqual({
      text: "done", isError: false, stopReason: "end_turn",
      numTurns: 1, permissionDenials: [], costUsd: 0.25,
    });
    expect(streamEvents.mock.calls[1][1]).toMatchObject({ lastEventId: "7" });
  });

  it("rejects immediately on a non-retriable 4xx instead of waiting out the timeout", async () => {
    const streamEvents = vi.fn(async function* (_id: string, _opts: { lastEventId?: string }) {
      throw new ApiError("no such session", 404, null);
    });
    const toolDeps = {
      api: { streamEvents, listEvents: async () => ({ events: [], resumeCursor: null }) },
      discovery: {}, maxSpawned: 3,
    } as unknown as ToolDeps;

    await expect(waitForIdle(toolDeps, { session_id: "s-1", timeout_s: 5 }))
      .rejects.toThrow(ApiError);
    expect(streamEvents).toHaveBeenCalledTimes(1);
  });
});
