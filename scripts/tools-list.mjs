#!/usr/bin/env node
// Prints the server's tools/list answer (names, descriptions, inputSchema,
// outputSchema) as stable JSON, so a dependency upgrade can be checked for
// schema drift against the committed snapshot in tests/fixtures/tools-list.json.
// Object keys are sorted so the diff shows only changes in meaning.
//
//   npm run build && node scripts/tools-list.mjs [out.json]
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";

// The tools are never invoked: tools/list only needs the registrations.
const server = buildServer({ maxSpawned: 3 });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "tools-list", version: "0.0.0" });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
const { tools } = await client.listTools();
await client.close();

const sortKeys = (value) =>
  Array.isArray(value) ? value.map(sortKeys)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]))
    : value;
const text = JSON.stringify(sortKeys(tools), null, 2) + "\n";
const out = process.argv[2];
if (out) writeFileSync(out, text);
else process.stdout.write(text);
