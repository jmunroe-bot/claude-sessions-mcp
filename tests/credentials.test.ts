import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CredentialsError, createTokenReader } from "../src/credentials.js";

async function credentialsFile(token: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "creds-"));
  const path = join(dir, "credentials.json");
  await writeFile(path, JSON.stringify({ claudeAiOauth: { accessToken: token } }));
  return path;
}

describe("createTokenReader", () => {
  it("reads the access token", async () => {
    const reader = createTokenReader(await credentialsFile("token-1"));
    expect(await reader.read()).toBe("token-1");
  });

  // Two writes a few milliseconds apart can share an mtime, because the kernel
  // stamps files from a coarse clock. The tests set mtimes explicitly so they
  // exercise the cache rather than race that clock. Whole seconds, because a
  // Date cannot carry the sub-millisecond part of mtimeMs back to the file.
  const earlier = new Date("2026-01-01T00:00:00Z");
  const later = new Date("2026-01-01T00:00:01Z");

  it("serves the cached token without re-reading an unchanged file", async () => {
    const path = await credentialsFile("token-1");
    await utimes(path, earlier, earlier);
    const reader = createTokenReader(path);
    expect(await reader.read()).toBe("token-1");
    await writeFile(path, JSON.stringify({ claudeAiOauth: { accessToken: "token-2" } }));
    await utimes(path, earlier, earlier);
    expect(await reader.read()).toBe("token-1"); // same mtime, so the cache answers
  });

  it("re-reads the file once its mtime changes", async () => {
    const path = await credentialsFile("token-1");
    await utimes(path, earlier, earlier);
    const reader = createTokenReader(path);
    expect(await reader.read()).toBe("token-1");
    await writeFile(path, JSON.stringify({ claudeAiOauth: { accessToken: "token-2" } }));
    await utimes(path, later, later);
    expect(await reader.read()).toBe("token-2"); // mtime changed, so the cache yields
  });

  it("re-reads after invalidate even when the file has not changed", async () => {
    const path = await credentialsFile("token-1");
    const reader = createTokenReader(path);
    await reader.read();
    await writeFile(path, JSON.stringify({ claudeAiOauth: { accessToken: "token-3" } }));
    reader.invalidate();
    expect(await reader.read()).toBe("token-3");
  });

  it("explains itself when the file is missing", async () => {
    const reader = createTokenReader("/nonexistent/credentials.json");
    await expect(reader.read()).rejects.toBeInstanceOf(CredentialsError);
    await expect(reader.read()).rejects.toThrow(/claude \/login/);
  });

  it("does not blame a missing login when the file cannot be read", async () => {
    // A regular file used as a directory component gives a deterministic
    // non-ENOENT errno without depending on the test user's privileges.
    const path = join(await credentialsFile("token-1"), "credentials.json");
    const failure = await createTokenReader(path).read().catch((e: unknown) => e as Error);

    expect(failure).toBeInstanceOf(CredentialsError);
    expect(failure.message).toMatch(/ENOTDIR/);
    expect(failure.message).not.toMatch(/\/login/);
  });

  it("explains itself when the file holds no OAuth token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "creds-"));
    const path = join(dir, "credentials.json");
    await writeFile(path, JSON.stringify({ mcpOAuth: {} }));
    await expect(createTokenReader(path).read()).rejects.toBeInstanceOf(CredentialsError);
  });
});
