import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createSafariServer, type SafariServer } from "../../src/server.js";
import { MemoryHome, machineName } from "../../src/memory/home.js";
import { makeTempHome } from "../helpers/memory-home.js";
import { SafariError } from "../../src/driver/types.js";
import { createFakeDriver, type FakeDriver } from "../helpers/fake-driver.js";

let client: Client | undefined;
let srv: SafariServer | undefined;

async function connect(d: FakeDriver, opts: Parameters<typeof createSafariServer>[1] = {}) {
  srv = createSafariServer(d, opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await srv.server.connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}

afterEach(async () => {
  await client?.close();
  await srv?.shutdown();
  client = undefined;
  srv = undefined;
});

const textOf = (r: unknown): string => ((r as { content: Array<{ text: string }> }).content[0]?.text) ?? "";

describe("MCP 서버", () => {
  test("도구 목록은 repl · status · memory · project", async () => {
    const c = await connect(createFakeDriver());
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["memory", "project", "repl", "status"]);
  });

  test("project 설명은 700자 이하이고 언제 쓰는지 · 영어 한 줄 · 모든 action 을 알려 준다, memory 와 합쳐 1,500자 이하", async () => {
    const c = await connect(createFakeDriver());
    const tools = (await c.listTools()).tools;
    const proj = tools.find((t) => t.name === "project")!;
    const mem = tools.find((t) => t.name === "memory")!;
    const d = proj.description ?? "";
    expect([...d].length).toBeLessThanOrEqual(700);
    for (const w of ["이사 준비", "list", "create", "open", "update", "save_doc", "open_sites", "archive"]) expect(d).toContain(w);
    expect(d.split("\n").filter((l) => /^[A-Z][^가-힣]*$/.test(l))).toHaveLength(1); // 영어 한 줄
    expect(proj.title).toMatch(/프로젝트/);
    expect([...d].length + [...(mem.description ?? "")].length).toBeLessThanOrEqual(1500);
  });

  test("memory 설명은 800자 이하이고 언제 쓰는지 · 영어 한 줄 · 모든 action 을 알려 준다", async () => {
    const c = await connect(createFakeDriver());
    const mem = (await c.listTools()).tools.find((t) => t.name === "memory")!;
    const d = mem.description ?? "";
    expect([...d].length).toBeLessThanOrEqual(800);
    for (const w of ["기억해", "찾아 줘", "정리", "remember", "search", "read", "forget", "tidy", "tidy_save", "pause"]) expect(d).toContain(w);
    expect(d.split("\n").filter((l) => /^[A-Z][^가-힣]*$/.test(l))).toHaveLength(1); // 영어 한 줄
    expect(mem.title).toMatch(/기억/);
  });

  test("repl 설명이 쓰는 법과 알려진 한계를 알려 준다", async () => {
    const c = await connect(createFakeDriver());
    const repl = (await c.listTools()).tools.find((t) => t.name === "repl")!;
    const d = repl.description ?? "";
    for (const w of ["console.log", "openTab", "attachActiveBrowserTab", "snapshot", "iframe", "개인정보 보호", "CORS", "openAiWindow", "listWindows", "useWindow", "useAiWindow", "setViewportSize", "screenshot", "display", "4장", "화면 및 시스템 오디오 녹음"]) expect(d).toContain(w);
    expect(d).toContain("열린 shadow DOM 과 같은 사이트 iframe");
    expect(d).toContain("닫힌 shadow root");
    expect(d).not.toContain("Reading skips iframes");
  });

  test("repl 은 콘솔 출력을 글로 돌려준다", async () => {
    const c = await connect(createFakeDriver());
    const r = await c.callTool({ name: "repl", arguments: { title: "더하기", code: "console.log(1+2)" } });
    expect(textOf(r)).toBe("3");
    expect(r.isError).toBeFalsy();
  });

  test("repl 오류는 isError 이고 출력도 함께 준다", async () => {
    const c = await connect(createFakeDriver());
    const r = await c.callTool({ name: "repl", arguments: { title: "오류", code: 'console.log("먼저"); throw new Error("앗")' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("먼저");
    expect(textOf(r)).toContain("앗");
  });

  test("repl 안에서 난 사파리 오류는 한국어 안내가 붙는다", async () => {
    const d = createFakeDriver();
    d.openTab = async () => {
      throw new SafariError("JS_FROM_APPLE_EVENTS_OFF", "원문");
    };
    const c = await connect(d);
    const r = await c.callTool({ name: "repl", arguments: { title: "열기", code: 'await openTab("http://a/")' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("사파리 설정 → 개발자 → 'Apple 이벤트의 JavaScript 허용'");
  });

  test("display 한 이미지가 응답 content 에 image 로 붙는다", async () => {
    const d = createFakeDriver();
    const c = await connect(d);
    const r = (await c.callTool({
      name: "repl",
      arguments: { title: "찍기", code: 'await openAiWindow("http://a/"); display(await page.screenshot()); console.log("찍음")' },
    })) as { isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
    expect(r.isError).toBeFalsy();
    expect(r.content[0]).toMatchObject({ type: "text", text: "찍음" });
    expect(r.content[1]).toMatchObject({ type: "image", mimeType: "image/png", data: d.png.toString("base64") });
    expect(r.content).toHaveLength(2);
  });

  test("이미지가 5장이면 4장만 붙고 안내 줄이 글에 있다", async () => {
    const c = await connect(createFakeDriver());
    const r = (await c.callTool({
      name: "repl",
      arguments: { title: "찍기", code: 'await openAiWindow("http://a/"); const b = await page.screenshot(); for (let i = 0; i < 5; i++) display(b)' },
    })) as { content: Array<{ type: string; text?: string }> };
    expect(r.content.filter((x) => x.type === "image")).toHaveLength(4);
    expect(r.content[0]!.text).toContain("이미지는 한 번에 4장까지");
  });

  test("오류 응답에도 오류 전에 display 한 이미지가 붙는다", async () => {
    const c = await connect(createFakeDriver());
    const r = (await c.callTool({
      name: "repl",
      arguments: { title: "찍기", code: 'await openAiWindow("http://a/"); display(await page.screenshot()); throw new Error("앗")' },
    })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("앗");
    expect(r.content.filter((x) => x.type === "image")).toHaveLength(1);
  });

  test("SCREEN_CAPTURE_DENIED 는 한국어 안내로, 서버는 계속 응답한다", async () => {
    const d = createFakeDriver();
    d.screenAllowed = false;
    const c = await connect(d);
    const r = await c.callTool({ name: "repl", arguments: { title: "찍기", code: 'await openAiWindow("http://a/"); await page.screenshot()' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("화면 찍기 권한이 없어요. 시스템 설정 → 개인정보 보호 및 보안 → 화면 및 시스템 오디오 녹음에서");
    const r2 = await c.callTool({ name: "repl", arguments: { title: "더하기", code: "console.log(1+2)" } });
    expect(textOf(r2)).toBe("3");
    expect(r2.isError).toBeFalsy();
  });

  test("status 는 점검 결과를 ✓ 줄로 알리고 연 탭을 닫는다", async () => {
    const d = createFakeDriver();
    d.answer = () => "2";
    const c = await connect(d);
    const r = await c.callTool({ name: "status", arguments: {} });
    const t = textOf(r);
    expect(t).toContain("✓ 사파리 실행");
    expect(t).toContain("✓ 자동화 허락");
    expect(t).toContain("✓ Apple 이벤트의 JavaScript 허용");
    expect(t).toContain("✓ 화면 기록(찍기용)");
    expect(t).toContain("준비 끝 — 바로 쓰면 됩니다");
    expect(d.calls.openTab).toHaveLength(1);
    expect(d.calls.closeTab).toEqual(["t1"]);
  });

  test("status: 설정이 꺼져 있어도 열었던 탭을 닫고 안내를 준다", async () => {
    const d = createFakeDriver();
    d.answer = () => {
      throw new SafariError("JS_FROM_APPLE_EVENTS_OFF", "원문");
    };
    const c = await connect(d);
    const t = textOf(await c.callTool({ name: "status", arguments: {} }));
    expect(t).toContain("✗ Apple 이벤트의 JavaScript 허용");
    expect(t).toContain("사파리 → 설정 → 고급");
    expect(d.calls.closeTab).toEqual(["t1"]);
  });

  test("status: 사파리가 꺼져 있으면 켜지 않고 알린다", async () => {
    const d = createFakeDriver();
    d.listWindows = async () => {
      throw new SafariError("SAFARI_NOT_RUNNING", "사파리가 실행 중이 아님");
    };
    const c = await connect(d);
    const t = textOf(await c.callTool({ name: "status", arguments: {} }));
    expect(t).toContain("✗ 사파리 실행");
    expect(t).toContain("사파리를 켜 두세요");
    expect(d.calls.openTab).toHaveLength(0);
  });

  test("status: 자동화 거부를 알린다", async () => {
    const d = createFakeDriver();
    d.listWindows = async () => {
      throw new SafariError("AUTOMATION_DENIED", "원문");
    };
    const c = await connect(d);
    const t = textOf(await c.callTool({ name: "status", arguments: {} }));
    expect(t).toContain("✗ 자동화 허락");
    expect(t).toContain("시스템 설정 → 개인정보 보호 및 보안 → 자동화");
  });

  test("서버를 닫으면 우리 탭을 닫는다", async () => {
    const d = createFakeDriver();
    let closed = 0;
    const orig = d.closeOwned.bind(d);
    d.closeOwned = async () => {
      closed++;
      return orig();
    };
    const c = await connect(d);
    await c.callTool({ name: "repl", arguments: { title: "열기", code: 'await openTab("http://a/")' } });
    await srv!.shutdown();
    expect(closed).toBe(1);
    expect(d.calls.openTab).toHaveLength(1);
  });
});

describe("repl 응답에 기록 · 메모 · 안내 붙이기", () => {
  const NOW = new Date(2026, 10, 23, 14, 5, 0);
  let tmp: Awaited<ReturnType<typeof makeTempHome>>;
  let home: MemoryHome;
  let clock: Date;
  beforeEach(async () => {
    tmp = await makeTempHome();
    home = new MemoryHome(tmp.dir);
    clock = new Date(NOW);
  });
  afterEach(async () => {
    await client?.close();
    await srv?.shutdown();
    client = undefined;
    srv = undefined;
    await tmp.remove();
  });
  const put = async (rel: string, text: string) => {
    const p = home.path(rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, text, "utf8");
  };
  const repl = (c: Client, code: string, title = "시험") => c.callTool({ name: "repl", arguments: { title, code } });

  test("닿은 사이트가 하루 기록에 쓰이고, 사이트 메모가 출력 끝에 한 번만 붙는다", async () => {
    await put("기억/사이트/a.example.md", "로그인 필요");
    const c = await connect(createFakeDriver(), { home, now: () => clock });
    const r1 = await repl(c, 'await openTab("https://a.example/x?q=1"); console.log("본문")', "첫 열기");
    expect(textOf(r1)).toBe("본문\n\n… 이 사이트 메모(a.example): 로그인 필요");
    const r2 = await repl(c, 'await openTab("https://a.example/y"); console.log("본문2")');
    expect(textOf(r2)).toBe("본문2");
    const log = (await home.read(`기억/일지/2026-11-23-${machineName()}.md`))!;
    expect(log).toContain("- 14:05 「첫 열기」 — https://a.example/x · 성공");
    expect(log).not.toContain("q=1");
  });

  test("오류 응답에도 메모가 붙고 기록에는 실패 이유가 남는다", async () => {
    await put("기억/사이트/a.example.md", "메모");
    const c = await connect(createFakeDriver(), { home, now: () => clock });
    const r = await repl(c, 'await openTab("https://a.example/"); throw new Error("앗")');
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe("오류: 앗\n\n… 이 사이트 메모(a.example): 메모");
    expect((await home.read(`기억/일지/2026-11-23-${machineName()}.md`))!).toContain("실패(앗)");
  });

  test("정리 안내가 메모 뒤에 붙고 한 번만", async () => {
    await put("기억/사이트/a.example.md", "메모");
    await put("기억/일지/2026-11-20-옛맥.md", "- 옛 기록\n");
    const c = await connect(createFakeDriver(), { home, now: () => clock });
    const r1 = await repl(c, 'await openTab("https://a.example/"); console.log("x")');
    expect(textOf(r1)).toBe("x\n\n… 이 사이트 메모(a.example): 메모\n\n… 기억 정리할 때가 됐어요 — memory 도구 tidy");
    const r2 = await repl(c, 'console.log("y")');
    expect(textOf(r2)).toBe("y");
  });

  test("붙이면 16KB 를 넘는 출력에는 붙이지 않는다(기록은 남는다)", async () => {
    await put("기억/사이트/a.example.md", "메모".repeat(40));
    const c = await connect(createFakeDriver(), { home, now: () => clock });
    const r = await repl(c, 'await openTab("https://a.example/"); console.log("x".repeat(16350))');
    expect(textOf(r)).not.toContain("이 사이트 메모");
    expect(Buffer.byteLength(textOf(r))).toBeLessThanOrEqual(16384);
    expect(await home.read(`기억/일지/2026-11-23-${machineName()}.md`)).toContain("a.example");
  });

  test("기억 폴더에 쓸 수 없어도 repl 결과는 그대로, 안내는 한 줄씩 대화당 한 번", async () => {
    await writeFile(tmp.dir + "/막힘", "파일");
    const bad = new MemoryHome(tmp.dir + "/막힘");
    const c = await connect(createFakeDriver(), { home: bad, now: () => clock });
    const r1 = await repl(c, 'await openTab("https://a.example/"); console.log("본문")');
    expect(r1.isError).toBeFalsy();
    expect(textOf(r1)).toMatch(/^본문\n\n기억 폴더에 쓸 수 없어요: .*막힘 — .+$/);
    const r2 = await repl(c, 'await openTab("https://a.example/z"); console.log("본문2")');
    expect(textOf(r2)).toBe("본문2");
  });

  test("status 도 사용 시각을 갱신한다", async () => {
    const c = await connect(createFakeDriver(), { home, now: () => clock });
    const before = srv!.activity.state.lastUse;
    clock = new Date(clock.getTime() + 60_000);
    await c.callTool({ name: "status", arguments: {} });
    expect(srv!.activity.state.lastUse).toBe(before + 60_000);
  });

  test("30분 넘게 안 쓰면 사이트 메모를 다시 붙인다", async () => {
    await put("기억/사이트/a.example.md", "메모");
    const c = await connect(createFakeDriver(), { home, now: () => clock });
    await repl(c, 'await openTab("https://a.example/")');
    clock = new Date(clock.getTime() + 1_800_001);
    const r = await repl(c, 'await openTab("https://a.example/")');
    expect(textOf(r)).toContain("이 사이트 메모(a.example)");
  });

  test("붙일 글이 하나만 들어가는 자리면 들어가는 것만 붙인다(사이트 메모는 못 들어가고 정리 안내는 딱 맞게)", async () => {
    const HINT = "… 기억 정리할 때가 됐어요 — memory 도구 tidy";
    await put("기억/사이트/a.example.md", "메모".repeat(40));
    await put("기억/일지/2026-11-20-옛맥.md", "- 옛 기록\n");
    const c = await connect(createFakeDriver(), { home, now: () => clock });
    const n = 16384 - 2 - Buffer.byteLength(HINT);
    const r = await repl(c, `await openTab("https://a.example/"); console.log("x".repeat(${n}))`);
    expect(textOf(r)).toBe("x".repeat(n) + "\n\n" + HINT);
    expect(Buffer.byteLength(textOf(r))).toBe(16384);
  });

  test("기억 쓰기가 멈춰도(2초 상한 — 시험은 줄여서) repl 결과는 덧붙임 없이 바로 온다", async () => {
    await put("기억/사이트/a.example.md", "메모");
    const stuck = new MemoryHome(tmp.dir);
    stuck.append = () => new Promise<void>(() => {});
    const c = await connect(createFakeDriver(), { home: stuck, now: () => clock, memoryTimeoutMs: 50 });
    const t0 = Date.now();
    const r = await repl(c, 'await openTab("https://a.example/"); console.log("본문")');
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe("본문");
  });

  test("늦게 실패하는 기억 쓰기는 처리 안 된 거부를 남기지 않고, 늦은 실패 안내도 쓰지 않는다", async () => {
    const slow = new MemoryHome(tmp.dir);
    slow.append = () => new Promise<void>((_, rej) => setTimeout(() => rej(new Error("늦은 실패")), 150));
    const stray: unknown[] = [];
    const onStray = (e: unknown) => stray.push(e);
    process.on("unhandledRejection", onStray);
    try {
      const c = await connect(createFakeDriver(), { home: slow, now: () => clock, memoryTimeoutMs: 20 });
      const r = await repl(c, 'await openTab("https://a.example/"); console.log("본문")');
      expect(textOf(r)).toBe("본문");
      await new Promise((res) => setTimeout(res, 400));
      expect(stray).toEqual([]);
      expect(srv!.activity.state.writeWarned).toBe(false); // 아무도 못 본 안내로 한 번을 쓰지 않는다
    } finally {
      process.off("unhandledRejection", onStray);
    }
  });
});

describe("memory 도구(MCP 로 부르기)", () => {
  const NOW = new Date(2026, 10, 23, 14, 5, 0);
  let tmp: Awaited<ReturnType<typeof makeTempHome>>;
  let home: MemoryHome;
  let clock: Date;
  beforeEach(async () => {
    tmp = await makeTempHome();
    home = new MemoryHome(tmp.dir);
    clock = new Date(NOW);
  });
  afterEach(async () => {
    await client?.close();
    await srv?.shutdown();
    client = undefined;
    srv = undefined;
    await tmp.remove();
  });
  const mem = (c: Client, args: Record<string, unknown>) => c.callTool({ name: "memory", arguments: args });

  test("기억해 → 찾기 · 서버는 index 를 내놓는다", async () => {
    const c = await connect(createFakeDriver(), { home, now: () => clock });
    expect(srv!.index).toBeDefined();
    const a = await mem(c, { action: "remember", text: "LG 그램 노트북 비교", about: "나" });
    expect(textOf(a)).toBe("기억했어요: 기억/나.md");
    expect(a.isError).toBeFalsy();
    const b = await mem(c, { action: "search", query: "노트북" });
    expect(textOf(b)).toContain("LG 그램");
  });

  test("오류는 isError 로, 열린 프로젝트는 첫 줄에", async () => {
    const c = await connect(createFakeDriver(), { home, now: () => clock });
    srv!.activity.state.openProject = "이사 준비";
    const r = await mem(c, { action: "remember" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe("열린 프로젝트: 이사 준비\n기억할 내용(text)을 알려 주세요.");
  });

  test("action 이 목록에 없으면 MCP 가 거절한다", async () => {
    const c = await connect(createFakeDriver(), { home, now: () => clock });
    const r = await mem(c, { action: "해줘" }).catch((e: unknown) => e);
    const failed = r instanceof Error || (r as { isError?: boolean }).isError === true;
    expect(failed).toBe(true);
  });

  test("pause 는 서버의 repl 기록을 멈춘다", async () => {
    const c = await connect(createFakeDriver(), { home, now: () => clock });
    await mem(c, { action: "pause", on: true });
    await c.callTool({ name: "repl", arguments: { title: "멈춤", code: 'await openTab("https://a.example/")' } });
    expect(await home.read(`기억/일지/2026-11-23-${machineName()}.md`)).toBeNull();
  });

  test("쓸 수 없는 기억 폴더: memory 는 한 줄 오류, repl 은 그대로", async () => {
    await writeFile(tmp.dir + "/막힘", "파일");
    const c = await connect(createFakeDriver(), { home: new MemoryHome(tmp.dir + "/막힘/아래"), now: () => clock });
    const r = await mem(c, { action: "remember", text: "가나다" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^기억 폴더에 쓸 수 없어요: .*막힘\/아래 — /);
    const ok = await c.callTool({ name: "repl", arguments: { title: "더하기", code: "console.log(1+2)" } });
    expect(textOf(ok).split("\n")[0]).toBe("3");
  });
});

describe("project 도구(MCP 로 부르기)", () => {
  const NOW = new Date(2026, 10, 23, 14, 5, 0);
  let tmp: Awaited<ReturnType<typeof makeTempHome>>;
  let home: MemoryHome;
  let clock: Date;
  beforeEach(async () => {
    tmp = await makeTempHome();
    home = new MemoryHome(tmp.dir);
    clock = new Date(NOW);
  });
  afterEach(async () => {
    await client?.close();
    await srv?.shutdown();
    client = undefined;
    srv = undefined;
    await tmp.remove();
  });
  const proj = (c: Client, args: Record<string, unknown>) => c.callTool({ name: "project", arguments: args });

  test("만들기 → 열기 → 고치기, 오류는 isError", async () => {
    const c = await connect(createFakeDriver(), { home, now: () => clock });
    expect(textOf(await proj(c, { action: "create", name: "이사 준비", text: "6월 이사" }))).toContain("이사 준비");
    const o = await proj(c, { action: "open", name: "이사 준비" });
    expect(textOf(o).split("\n")[0]).toBe("열린 프로젝트: 이사 준비");
    expect(srv!.activity.state.openProject).toBe("이사 준비");
    await proj(c, { action: "update", section: "조건", text: "예산 3억" });
    expect(textOf(await proj(c, { action: "open", name: "이사 준비" }))).toContain("예산 3억");
    const bad = await proj(c, { action: "open", name: "없는일" });
    expect(bad.isError).toBe(true);
  });

  test("action · section · mode 가 목록에 없으면 MCP 가 거절한다", async () => {
    const c = await connect(createFakeDriver(), { home, now: () => clock });
    for (const args of [{ action: "해줘" }, { action: "update", section: "상태", text: "x" }, { action: "update", section: "메모", text: "x", mode: "합치기" }]) {
      const r = await proj(c, args).catch((e: unknown) => e);
      expect(r instanceof Error || (r as { isError?: boolean }).isError === true).toBe(true);
    }
  });

  test("open_sites: 사이트를 뒤쪽 탭으로 열고, 하루 기록 · 프로젝트 기록에 「프로젝트 사이트 열기」 한 줄, 서버가 끝나면 닫는다", async () => {
    const d = createFakeDriver();
    const c = await connect(d, { home, now: () => clock });
    await proj(c, { action: "create", name: "이사 준비" });
    await proj(c, { action: "open", name: "이사 준비" });
    await proj(c, { action: "update", section: "사이트", text: "https://a.example/1\nhttps://b.example/2" });
    const r = await proj(c, { action: "open_sites" });
    expect(r.isError).toBeFalsy();
    expect(d.calls.openTab.map((x) => x.url)).toEqual(["https://a.example/1", "https://b.example/2"]);
    expect(textOf(r)).toContain("https://b.example/2");
    const day = (await home.read(`기억/일지/2026-11-23-${machineName()}.md`))!.trim().split("\n");
    expect(day).toHaveLength(1);
    expect(day[0]).toBe("- 14:05 「프로젝트 사이트 열기」 — https://a.example/1, https://b.example/2 · 성공 · 프로젝트: 이사 준비");
    expect(await home.read(`프로젝트/이사 준비/기록-${machineName()}.md`)).toBe("- 2026-11-23 " + day[0]!.slice(2) + "\n");
    await srv!.shutdown();
    expect((await d.listTabs()).filter((t) => t.owned)).toHaveLength(0);
  });

  test("open_sites: 사이트 메모를 결과에 붙이고 열린 프로젝트 첫 줄 · 8KB 안", async () => {
    await mkdir(tmp.dir + "/기억/사이트", { recursive: true });
    await writeFile(tmp.dir + "/기억/사이트/a.example.md", "A 메모", "utf8");
    const c = await connect(createFakeDriver(), { home, now: () => clock });
    await proj(c, { action: "create", name: "p" });
    await proj(c, { action: "open", name: "p" });
    await proj(c, { action: "update", section: "사이트", text: "https://a.example/1" });
    const r = textOf(await proj(c, { action: "open_sites" }));
    expect(r).toContain("… 이 사이트 메모(a.example): A 메모");
    expect(r.split("\n")[0]).toBe("열린 프로젝트: p");
    expect(Buffer.byteLength(r, "utf8")).toBeLessThanOrEqual(8192);
  });

  test("memory 의 remember(프로젝트)와 project 가 같은 프로젝트.md 에 서로 안 덮어쓴다(같은 줄 서기)", async () => {
    const c = await connect(createFakeDriver(), { home, now: () => clock });
    await proj(c, { action: "create", name: "p" });
    await proj(c, { action: "open", name: "p" });
    await Promise.all([
      ...Array.from({ length: 5 }, (_, i) => c.callTool({ name: "memory", arguments: { action: "remember", about: "프로젝트", text: `기억${i}` } })),
      ...Array.from({ length: 5 }, (_, i) => proj(c, { action: "update", section: "메모", text: `- 고침${i}`, mode: "append" })),
    ]);
    const md = (await home.read("프로젝트/p/프로젝트.md"))!;
    for (let i = 0; i < 5; i++) {
      expect(md).toContain(`기억${i}`);
      expect(md).toContain(`고침${i}`);
    }
  });
});
