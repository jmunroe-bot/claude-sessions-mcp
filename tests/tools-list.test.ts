import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import type { ToolDeps } from "../src/tools.js";

// The snapshot was recorded with zod 3 before the zod 4 upgrade
// (scripts/tools-list.mjs). A dependency bump that changes what clients see
// in tools/list should fail here rather than ship silently.
const snapshot = JSON.parse(
  readFileSync(new URL("./fixtures/tools-list.json", import.meta.url), "utf8"),
);

async function listTools() {
  const server = buildServer({ maxSpawned: 3 } as unknown as ToolDeps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tools-list-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

describe("tools/list", () => {
  it("publishes the same tool names, input and output schemas as the snapshot", async () => {
    expect(await listTools()).toEqual(snapshot);
  });

  it("still strips unknown arguments instead of rejecting them", async () => {
    const server = buildServer({ maxSpawned: 3 } as unknown as ToolDeps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "tools-list-test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    // Missing a required argument is a validation error...
    const missing = await client.callTool({ name: "send_message", arguments: { session_id: "s" } });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toMatch(/text/);
    // ...an unknown one is not: it gets past validation to the handler, which
    // fails here only because the test deps have no API.
    const extra = await client.callTool({
      name: "send_message", arguments: { session_id: "s", text: "t", unknown: 1 },
    });
    expect(JSON.stringify(extra.content)).not.toMatch(/validation|unrecognized/i);
    await client.close();
  });
});
