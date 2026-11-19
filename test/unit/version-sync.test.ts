import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSafariServer, type SafariServer } from "../../src/server.js";
import { VERSION } from "../../src/version.js";
import { createFakeDriver } from "../helpers/fake-driver.js";

// 버전의 기준은 src/version.ts 의 VERSION 하나. 아래 자리가 모두 같아야 한다.
const read = (rel: string): string => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
const json = (rel: string) => JSON.parse(read(rel));

let client: Client | undefined;
let srv: SafariServer | undefined;

afterEach(async () => {
  await client?.close();
  await srv?.shutdown();
  client = undefined;
  srv = undefined;
});

test("VERSION 은 x.y.z 모양이다", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});

test("package.json", () => {
  expect(json("package.json").version).toBe(VERSION);
});

test("package-lock.json 의 루트 두 자리", () => {
  const lock = json("package-lock.json");
  expect(lock.version).toBe(VERSION);
  expect(lock.packages[""].version).toBe(VERSION);
});

test("플러그인 plugin.json", () => {
  expect(json("plugin/.claude-plugin/plugin.json").version).toBe(VERSION);
});

test("마켓플레이스 plugins[0].version", () => {
  expect(json(".claude-plugin/marketplace.json").plugins[0].version).toBe(VERSION);
});

test("mcpb manifest", () => {
  expect(json("mcpb/manifest.json").version).toBe(VERSION);
});

test("홈브루 formula 의 tag (version 줄이 있으면 그것도)", () => {
  const rb = read("Formula/safari-attraction.rb");
  expect(rb).toContain(`tag: "v${VERSION}"`);
  const versionLine = rb.match(/^\s*version\s+"([^"]+)"/m);
  if (versionLine) expect(versionLine[1]).toBe(VERSION);
});

test("MCP 서버 이름표", async () => {
  srv = createSafariServer(createFakeDriver());
  const [a, b] = InMemoryTransport.createLinkedPair();
  await srv.server.connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  expect(client.getServerVersion()?.version).toBe(VERSION);
});
