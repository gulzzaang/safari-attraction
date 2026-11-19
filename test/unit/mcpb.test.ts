import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSafariServer, type SafariServer } from "../../src/server.js";
import { VERSION } from "../../src/version.js";
import { createFakeDriver } from "../helpers/fake-driver.js";

const manifest = JSON.parse(readFileSync(new URL("../../mcpb/manifest.json", import.meta.url), "utf8"));
const pack = readFileSync(new URL("../../scripts/pack-mcpb.sh", import.meta.url), "utf8");

let client: Client | undefined;
let srv: SafariServer | undefined;

afterEach(async () => {
  await client?.close();
  await srv?.shutdown();
  client = undefined;
  srv = undefined;
});

/** 실제 서버에 등록된 도구 이름(가짜 드라이버로 띄워 MCP 로 물어본다). */
async function serverToolNames(): Promise<string[]> {
  srv = createSafariServer(createFakeDriver());
  const [a, b] = InMemoryTransport.createLinkedPair();
  await srv.server.connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return (await client.listTools()).tools.map((t) => t.name).sort();
}

describe("mcpb manifest(글 검사)", () => {
  test("version 이 VERSION 과 같다", () => {
    expect(manifest.version).toBe(VERSION);
  });

  test("entry_point 와 실행 인자가 server.mjs 다", () => {
    expect(manifest.server.type).toBe("node");
    expect(manifest.server.entry_point).toBe("server.mjs");
    expect(manifest.server.mcp_config.command).toBe("node");
    expect(manifest.server.mcp_config.args).toEqual(["${__dirname}/server.mjs"]);
  });

  test("맥 전용이다", () => {
    expect(manifest.compatibility.platforms).toEqual(["darwin"]);
  });

  test("tools 이름이 실제 서버 도구 이름과 같고 설명이 한국어로 있다", async () => {
    const names = manifest.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(await serverToolNames());
    for (const t of manifest.tools) expect(t.description).toMatch(/[가-힣]/);
  });

  test("이름 · 표시 이름 · 저자", () => {
    expect(manifest.manifest_version).toBe("0.3");
    expect(manifest.name).toBe("safari-attraction");
    expect(manifest.display_name).toBe("사파리-어트랙션");
    expect(manifest.author.name).toBe("gulzzaang");
  });

  test("긴 설명에 처음 준비가 한국어로 들어 있다", () => {
    const d: string = manifest.long_description;
    expect(d).toContain("웹 개발자용 기능 보기");
    expect(d).toContain("Apple 이벤트의 JavaScript 허용");
    expect(d).toContain("허용");
    expect(d).toContain("화면 및 시스템 오디오 녹음");
    expect(d).toContain("status 도구로 점검해 줘");
  });
});

describe("pack-mcpb.sh(글 검사)", () => {
  test("빌드 → 복사 → validate → pack 순서, 도구 버전 고정", () => {
    const i = (s: string) => pack.indexOf(s);
    expect(i("npm run build")).toBeGreaterThan(-1);
    expect(i("rm -rf build/mcpb")).toBeGreaterThan(i("npm run build"));
    expect(i("@anthropic-ai/mcpb@2.1.2 validate")).toBeGreaterThan(i("rm -rf build/mcpb"));
    expect(i("@anthropic-ai/mcpb@2.1.2 pack")).toBeGreaterThan(i("validate"));
    expect(pack).toContain("plugin/server.mjs");
    expect(pack).toContain("plugin/jxa/host.js");
    expect(pack).toContain("out-mcpb/safari-attraction-");
  });
});
