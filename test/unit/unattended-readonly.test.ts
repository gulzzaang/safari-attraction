// 사람 없음 모드: 기억 · 프로젝트를 바꾸지 않고, 사용자 탭을 읽거나 붙잡지 않는다.
import { afterEach, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createSafariServer, type SafariServer } from "../../src/server.js";
import { createReplSession, type ReplSession } from "../../src/repl/context.js";
import { MemoryHome } from "../../src/memory/home.js";
import { makeTempHome, type TempHome } from "../helpers/memory-home.js";
import { createFakeDriver } from "../helpers/fake-driver.js";

const NOT_ALLOWED_TEXT = "사람 없이 도는 일은 기억 · 프로젝트를 바꾸지 않아요";
let client: Client | undefined;
let srv: SafariServer | undefined;
let live: ReplSession | undefined;
let tmp: TempHome | undefined;

async function connect(unattended: boolean) {
  tmp = await makeTempHome();
  srv = createSafariServer(createFakeDriver(), { home: new MemoryHome(tmp.dir), unattended });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await srv.server.connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return { c: client, dir: tmp.dir };
}

afterEach(async () => {
  await client?.close();
  await srv?.shutdown();
  await live?.dispose();
  await tmp?.remove();
  client = undefined;
  srv = undefined;
  live = undefined;
  tmp = undefined;
});

const textOf = (r: unknown): string => ((r as { content: Array<{ text: string }> }).content[0]?.text) ?? "";
const isErr = (r: unknown): boolean => (r as { isError?: boolean }).isError === true;

/** 폴더 아래 모든 파일 글을 이어 붙인다. */
async function allText(dir: string): Promise<string> {
  let out = "";
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    out += e.isDirectory() ? await allText(p) : await readFile(p, "utf8");
  }
  return out;
}

describe("사람 없음 모드 — 기억 · 프로젝트 쓰기 막기", () => {
  test("memory 의 쓰는 action(remember · forget · tidy · tidy_save · pause)은 NOT_ALLOWED 로 거절하고 아무것도 쓰지 않는다", async () => {
    const { c, dir } = await connect(true);
    for (const args of [
      { action: "remember", text: "속임수 글" },
      { action: "forget", text: "속임수" },
      { action: "tidy" },
      { action: "tidy_save", text: "정리" },
      { action: "pause", on: true },
    ]) {
      const r = await c.callTool({ name: "memory", arguments: args });
      expect(isErr(r), args.action).toBe(true);
      expect(textOf(r), args.action).toContain(NOT_ALLOWED_TEXT);
    }
    expect(await allText(dir)).not.toContain("속임수");
  });
  test("memory 의 search · read 는 된다", async () => {
    const { c } = await connect(true);
    const r = await c.callTool({ name: "memory", arguments: { action: "search", query: "없는말" } });
    expect(textOf(r)).not.toContain(NOT_ALLOWED_TEXT);
    const r2 = await c.callTool({ name: "memory", arguments: { action: "read", path: "기억/나.md" } });
    expect(textOf(r2)).not.toContain(NOT_ALLOWED_TEXT);
  });
  test("project 는 list 만 되고 create · open · update · save_doc · open_sites · archive 는 거절한다", async () => {
    const { c } = await connect(true);
    expect(textOf(await c.callTool({ name: "project", arguments: { action: "list" } }))).not.toContain(NOT_ALLOWED_TEXT);
    for (const action of ["create", "open", "update", "save_doc", "open_sites", "archive"]) {
      const r = await c.callTool({ name: "project", arguments: { action, name: "x", text: "y" } });
      expect(isErr(r), action).toBe(true);
      expect(textOf(r), action).toContain(NOT_ALLOWED_TEXT);
    }
  });
  test("사람 없음이 아니면 remember · create 가 그대로 된다", async () => {
    const { c } = await connect(false);
    expect(textOf(await c.callTool({ name: "memory", arguments: { action: "remember", text: "커피를 좋아함" } }))).not.toContain(NOT_ALLOWED_TEXT);
    expect(textOf(await c.callTool({ name: "project", arguments: { action: "create", name: "시험", text: "요약" } }))).not.toContain(NOT_ALLOWED_TEXT);
  });
});

describe("사람 없음 모드 — 사용자 탭 붙이기 막기", () => {
  const code = ["await listBrowserTabs()", 'await attachBrowserTab("t1")', "await attachActiveBrowserTab()"];
  test("listBrowserTabs · attachBrowserTab · attachActiveBrowserTab 은 NOT_ALLOWED 이다", async () => {
    live = createReplSession(createFakeDriver(), { unattended: true });
    for (const c of code) {
      const r = await live.run(c);
      expect(r.errorCode, c).toBe("NOT_ALLOWED");
      expect(r.error, c).toContain("사람 없이 도는 일은 사용자 탭을 읽거나 붙잡지 않아요");
    }
  });
  test("사람 없음이 아니면 listBrowserTabs 가 된다", async () => {
    live = createReplSession(createFakeDriver(), {});
    expect((await live.run("await listBrowserTabs()")).error).toBeUndefined();
  });
});
