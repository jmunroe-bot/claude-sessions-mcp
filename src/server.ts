import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { SessionsApi } from "./api.js";
import { VERSION } from "./version.js";
import { createTokenReader } from "./credentials.js";
import { defaultDiscoveryDeps } from "./discovery.js";
import {
  ALLOWED_PERMISSION_MODES, archiveSession, deleteSession, listInstances, listSessions,
  readSession, sendMessage, spawnSession, unarchiveSession, waitForIdle, type ToolDeps,
} from "./tools.js";

export interface ServerConfig {
  port: number;
  host: string;
  credentialsPath: string;
  claudeConfigDir: string;
  maxSpawned: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const home = env.HOME ?? "";
  const host = env.HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(
      `Refusing to bind ${host}: this server spawns agents and is meant for the loopback interface only.`,
    );
  }
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  return {
    host,
    port: Number(env.PORT ?? 8765),
    credentialsPath: env.CLAUDE_CREDENTIALS_PATH ?? join(claudeConfigDir, ".credentials.json"),
    claudeConfigDir,
    maxSpawned: Number(env.CLAUDE_SESSIONS_MCP_MAX_SPAWNED ?? 6),
  };
}

/**
 * Tool arguments as a zod object that still advertises
 * `additionalProperties: false`. Zod 3's converter emitted it for every plain
 * object; zod 4's toJSONSchema leaves it out for input schemas, which would
 * loosen the published tools/list. The meta key restores the published schema
 * while parsing keeps zod's default of stripping unknown keys, as before.
 */
const toolInput = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.object(shape).meta({ additionalProperties: false });

const asJson = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

export function buildServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: "claude-sessions-mcp", version: VERSION });

  server.registerTool("list_instances", {
    description: "Remote Control bridges running on this machine, with their environment ids and how many workers each has in use.",
    inputSchema: {},
  }, async () => asJson(await listInstances(deps)));

  server.registerTool("list_sessions", {
    description: "Sessions of one bridge, or of every bridge when no instance is named.",
    inputSchema: toolInput({ instance: z.string().optional() }),
  }, async (args) => asJson(await listSessions(deps, args)));

  server.registerTool("spawn_session", {
    description:
      "Start a new Claude Code session inside a running bridge and give it a first prompt. " +
      "The session belongs to that bridge: its worker runs under the bridge process and it " +
      "appears in the session list like any other. Effort defaults to medium; " +
      `permission_mode is one of ${ALLOWED_PERMISSION_MODES.join(", ")} (bypassPermissions is refused).`,
    inputSchema: toolInput({
      instance: z.string(),
      prompt: z.string(),
      title: z.string().optional(),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      permission_mode: z.string().optional(),
      caller: z.string().optional().describe("Who is asking, recorded on the session as spawned-by"),
    }),
  }, async (args) => asJson(await spawnSession(deps, args)));

  server.registerTool("send_message", {
    description: "Send a message to a live session, as if typed by its user.",
    inputSchema: toolInput({ session_id: z.string(), text: z.string() }),
  }, async (args) => asJson(await sendMessage(deps, args)));

  server.registerTool("read_session", {
    description: "Recent events of a session, condensed to the conversation. Pass verbose for the machinery, cursor to continue.",
    inputSchema: toolInput({
      session_id: z.string(),
      limit: z.number().int().positive().max(200).optional(),
      cursor: z.string().optional(),
      verbose: z.boolean().optional(),
    }),
  }, async (args) => asJson(await readSession(deps, args)));

  server.registerTool("wait_for_idle", {
    description:
      "Wait on the session's event stream until its current turn finishes, then return the answer, " +
      "stop reason, permission denials and cost. Returns an `outcome` saying why the wait ended: " +
      "`result` when the turn finished, `archived` or `deleted` when the session stopped and no " +
      "result can arrive, `timeout` when it is still working.",
    inputSchema: toolInput({ session_id: z.string(), timeout_s: z.number().int().positive().max(3600).optional() }),
  }, async (args) => asJson(await waitForIdle(deps, args)));

  server.registerTool("archive_session", {
    description: "Stop a session and free its slot on the bridge, keeping its history.",
    inputSchema: toolInput({ session_id: z.string() }),
  }, async (args) => asJson(await archiveSession(deps, args)));

  server.registerTool("unarchive_session", {
    description: "Return an archived session to active. This does NOT restart its worker — a client has to open the session for it to run again.",
    inputSchema: toolInput({ session_id: z.string() }),
  }, async (args) => asJson(await unarchiveSession(deps, args)));

  server.registerTool("delete_session", {
    description: "Delete a session and stop its worker.",
    inputSchema: toolInput({ session_id: z.string() }),
  }, async (args) => asJson(await deleteSession(deps, args)));

  return server;
}

/**
 * Host header values accepted when DNS-rebinding protection is on. The endpoint
 * is loopback-only by design, so the list is the loopback names with and
 * without the port rather than anything configurable.
 */
export function loopbackAllowedHosts(port: number): string[] {
  const names = ["127.0.0.1", "localhost", "[::1]", "::1"];
  return names.flatMap((name) => [name, `${name}:${port}`]);
}

const INTERNAL_ERROR_BODY = JSON.stringify({
  jsonrpc: "2.0",
  error: { code: -32603, message: "Internal server error" },
  id: null,
});

/**
 * One MCP server and one transport per POST. The SDK's stateless transport
 * refuses to be reused across requests, and this server keeps no state between
 * calls anyway, so the per-request pair is both what the SDK documents and what
 * the design asks for.
 */
export function createRequestHandler(
  deps: ToolDeps,
  options: { allowedHosts: string[] },
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void handleRequest(deps, options, req, res);
  };
}

async function handleRequest(
  deps: ToolDeps,
  options: { allowedHosts: string[] },
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!req.url?.startsWith("/mcp")) {
    res.writeHead(404).end();
    return;
  }
  if (req.method !== "POST") {
    // Stateless: there is no session to attach a server-initiated stream to,
    // and nothing to DELETE.
    res.writeHead(405, { allow: "POST", "content-type": "application/json" })
      .end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed: this endpoint is stateless and serves POST only." },
        id: null,
      }));
    return;
  }

  const server = buildServer(deps);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableDnsRebindingProtection: true,
    allowedHosts: options.allowedHosts,
  });
  const closeBoth = async () => {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  };
  res.on("close", () => {
    void closeBoth();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    // The rejection used to be discarded with `void`, which is how a transport
    // that refused the request failed silently.
    console.error("claude-sessions-mcp: request failed", error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" }).end(INTERNAL_ERROR_BODY);
    } else {
      res.end();
    }
    await closeBoth();
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const token = createTokenReader(config.credentialsPath);
  const deps: ToolDeps = {
    api: new SessionsApi({ token }),
    discovery: defaultDiscoveryDeps(config.claudeConfigDir),
    maxSpawned: config.maxSpawned,
  };

  const handler = createRequestHandler(deps, { allowedHosts: loopbackAllowedHosts(config.port) });
  createServer(handler).listen(config.port, config.host, () => {
    console.log(`claude-sessions-mcp listening on http://${config.host}:${config.port}/mcp`);
  });
}

if (process.argv[1]?.endsWith("server.js")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
