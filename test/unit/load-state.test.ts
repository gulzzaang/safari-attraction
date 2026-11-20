import { describe, expect, test } from "vitest";
import { createReplSession } from "../../src/repl/context.js";
import { IdleWatch, loadPollSource, parseLoadReading, parseLoadStateArgs, parseWaitUntil, reached, usable } from "../../src/repl/load-state.js";
import { MAX_WAIT_MS } from "../../src/repl/locator.js";
import { Page } from "../../src/repl/page.js";
import type { SafariDriver, TabInfo } from "../../src/driver/types.js";
import { createFakeDriver } from "../helpers/fake-driver.js";

describe("waitUntil · waitForLoadState 인자 풀기", () => {
  test("waitUntil 을 안 주면 domcontentloaded", () => {
    expect(parseWaitUntil(undefined, "goto", true)).toBe("domcontentloaded");
    expect(parseWaitUntil(null, "goto", true)).toBe("domcontentloaded");
  });
  test("commit 은 허용한 곳에서만, 모르는 값은 한국어 오류", () => {
    expect(parseWaitUntil("commit", "goto", true)).toBe("commit");
    expect(() => parseWaitUntil("commit", "waitForLoadState", false)).toThrow(/waitForLoadState: waitUntil 은/);
    expect(() => parseWaitUntil("loaded", "goto", true)).toThrow(/'loaded'/);
    expect(() => parseWaitUntil(5, "goto", true)).toThrow(/waitUntil/);
  });
  test("waitForLoadState() 는 load · 15초(Playwright 와 같다)", () => {
    expect(parseLoadStateArgs(undefined, undefined)).toEqual({ state: "load", timeoutMs: 15000 });
  });
  test("상태와 {timeout}", () => {
    expect(parseLoadStateArgs("networkidle", { timeout: 4000 })).toEqual({ state: "networkidle", timeoutMs: 4000 });
    expect(parseLoadStateArgs("domcontentloaded", undefined).state).toBe("domcontentloaded");
  });
  test("옛 꼴: 숫자(밀리초) 와 {timeout} 만 준 꼴", () => {
    expect(parseLoadStateArgs(3000, undefined)).toEqual({ state: "load", timeoutMs: 3000 });
    expect(parseLoadStateArgs({ timeout: 2500 }, undefined)).toEqual({ state: "load", timeoutMs: 2500 });
  });
  test("waitForLoadState('load', 5000) 처럼 숫자를 둘째 인자로 줘도 시간으로 본다", () => {
    expect(parseLoadStateArgs("load", 5000)).toEqual({ state: "load", timeoutMs: 5000 });
  });
  test("시간 제한은 110초까지로 바로잡는다", () => {
    expect(parseLoadStateArgs("load", { timeout: 999_999 }).timeoutMs).toBe(MAX_WAIT_MS);
    expect(parseLoadStateArgs(0, undefined).timeoutMs).toBe(MAX_WAIT_MS);
  });
});

describe("읽은 값으로 상태 판단", () => {
  test("domcontentloaded: DOMContentLoaded 가 끝나고 body 가 있을 때, 또는 complete", () => {
    expect(usable(parseLoadReading("loading|1|0"))).toBe(false);
    expect(usable(parseLoadReading("interactive|0|0"))).toBe(false);
    expect(usable(parseLoadReading("interactive|1|0"))).toBe(false); // defer · module 스크립트가 아직 안 돈 때
    expect(usable(parseLoadReading("interactive|1|1"))).toBe(true);
    expect(usable(parseLoadReading("interactive|0|1"))).toBe(false); // body 없음
    expect(usable(parseLoadReading("complete|1|0"))).toBe(true); // navigation 기록을 못 읽는 경우의 대비
    expect(usable(parseLoadReading("complete|0|0"))).toBe(true); // body 없는 문서(XML 등)
  });
  test("load 는 complete 만", () => {
    expect(reached("load", parseLoadReading("interactive|1|1"))).toBe(false);
    expect(reached("load", parseLoadReading("complete|1|1"))).toBe(true);
    expect(reached("domcontentloaded", parseLoadReading("interactive|1|1"))).toBe(true);
  });
  test("옛 꼴 답(complete 만)도 받아들인다", () => {
    expect(reached("load", parseLoadReading("complete"))).toBe(true);
    expect(usable(parseLoadReading("interactive|1"))).toBe(true); // DCL 칸이 없으면 loading 이 아닌 것으로 본다
  });
  test("읽는 식: DCL 은 navigation 기록으로 본다", () => {
    expect(loadPollSource("domcontentloaded")).toContain("domContentLoadedEventEnd");
    expect(loadPollSource("load")).toContain("getEntriesByType('navigation')");
  });
  test("읽는 식: networkidle 만 리소스 기록을 본다", () => {
    expect(loadPollSource("load")).not.toContain("getEntriesByType('resource')");
    expect(loadPollSource("domcontentloaded")).not.toContain("getEntriesByType('resource')");
    expect(loadPollSource("networkidle")).toContain("getEntriesByType('resource')");
    for (const st of ["domcontentloaded", "load", "networkidle"] as const) expect(() => new Function(`return ${loadPollSource(st)}`)).not.toThrow();
  });
});

describe("IdleWatch(networkidle 판단)", () => {
  test("첫 읽기부터 리소스 기록이 250개 이상이면(칸이 찬 문서) 개수를 믿지 못하니 1500ms 조용해야 한다", () => {
    const full = parseLoadReading("complete|1|1|250|900");
    const w = new IdleWatch();
    w.feed(full, 0);
    expect(w.feed(full, 600)).toBe(false);
    expect(w.feed(full, 1499)).toBe(false);
    expect(w.feed(full, 1500)).toBe(true);
  });
  test("읽는 식은 문서마다 한 번만, 기록 칸이 안 찼을 때만 칸을 키운다", () => {
    const src = loadPollSource("networkidle");
    expect(src).toContain("__saRtb");
    expect(src).toContain("r.length<250");
    expect(src.match(/setResourceTimingBufferSize/g)).toHaveLength(2); // 있는지 확인 + 부르기(매 읽기마다 부르지 않는다)
  });
  const r = (state: string, sig: string) => parseLoadReading(`${state}|1|1|${sig}`);
  test("load 가 끝난 뒤 변화 없이 500ms 가 지나야 한다", () => {
    const w = new IdleWatch();
    expect(w.feed(r("complete", "3|10"), 0)).toBe(false); // 처음 본 값
    expect(w.feed(r("complete", "3|10"), 499)).toBe(false);
    expect(w.feed(r("complete", "3|10"), 500)).toBe(true);
  });
  test("새 리소스가 생기면 다시 센다", () => {
    const w = new IdleWatch();
    w.feed(r("complete", "3|10"), 0);
    expect(w.feed(r("complete", "4|20"), 400)).toBe(false);
    expect(w.feed(r("complete", "4|20"), 800)).toBe(false);
    expect(w.feed(r("complete", "4|20"), 900)).toBe(true);
  });
  test("load 전에는 아무리 조용해도 안 된다", () => {
    const w = new IdleWatch();
    w.feed(r("interactive", "3|10"), 0);
    expect(w.feed(r("interactive", "3|10"), 5000)).toBe(false);
    expect(w.feed(r("complete", "3|10"), 5100)).toBe(false); // complete 가 된 때부터 센다
    expect(w.feed(r("complete", "3|10"), 5600)).toBe(true);
  });
});

/** 가짜 드라이버: poll 은 readiness 읽기(runJs 에 보낸 글에 readyState 가 든 것), settles 는 settleTab 이 받은 인자. */
function fake(readings: string[]) {
  const log = { polls: 0, other: 0, settleOpts: [] as unknown[] };
  const tab: TabInfo = { key: "t1", windowId: 1, index: 1, title: "", url: "http://x/", isActive: false, owned: true };
  const d = {
    async runJs(_key: string, source: string) {
      if (source.includes("readyState")) return readings[Math.min(log.polls++, readings.length - 1)]!;
      log.other++;
      return JSON.stringify({ ok: true, r: { expectNav: true } });
    },
    async settleTab(_key: string, o?: unknown) {
      log.settleOpts.push(o);
      return { navigated: true, leaving: false, tab };
    },
    lastUrl: () => "http://x/",
  } as unknown as SafariDriver;
  return { d, page: new Page(d, "t1"), log };
}

describe("Page.waitForLoadState", () => {
  test("인자 없이 부르면 load 를 기다린다(interactive 로는 안 끝난다)", async () => {
    const { page, log } = fake(["interactive|1|1", "interactive|1|1", "complete|1|1"]);
    await page.waitForLoadState();
    expect(log.polls).toBe(3);
  });
  test("domcontentloaded 는 interactive + body 에서 끝난다", async () => {
    const { page, log } = fake(["loading|0|0", "interactive|1|0", "interactive|1|1", "complete|1|1"]);
    await page.waitForLoadState("domcontentloaded");
    expect(log.polls).toBe(3); // defer 스크립트가 도는 중(DCL 끝나기 전)에는 안 끝난다
  });
  test("옛 숫자 꼴: 제한 시간 안에 안 뜨면 TIMEOUT", async () => {
    const { page } = fake(["interactive|1"]);
    await expect(page.waitForLoadState(250)).rejects.toMatchObject({ code: "TIMEOUT", message: expect.stringContaining("250ms") });
  });
  test("옛 숫자 꼴: 이미 complete 면 바로 끝난다", async () => {
    const { page, log } = fake(["complete|1"]);
    await page.waitForLoadState(5000);
    expect(log.polls).toBe(1);
  });
  test("{timeout} 옵션도 지킨다", async () => {
    const { page } = fake(["loading|1"]);
    const t0 = Date.now();
    await expect(page.waitForLoadState("load", { timeout: 300 })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(Date.now() - t0).toBeLessThan(1500);
  });
  test("모르는 상태는 한국어 오류", async () => {
    const { page } = fake(["complete|1"]);
    await expect(page.waitForLoadState("idle" as never)).rejects.toThrow(/waitUntil 은/);
  });
  test("networkidle: complete 가 된 뒤 새 리소스가 없이 500ms 가 지나야 끝난다", async () => {
    const { page, log } = fake(["interactive|1|1|2|50", "complete|1|1|3|90", "complete|1|1|3|90", "complete|1|1|3|90"]);
    const t0 = Date.now();
    await page.waitForLoadState("networkidle");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(480);
    expect(log.polls).toBeGreaterThanOrEqual(5);
  });
  test("networkidle: 새 리소스가 계속 생기면 시간 초과", async () => {
    let n = 0;
    const tab: TabInfo = { key: "t1", windowId: 1, index: 1, title: "", url: "http://x/", isActive: false, owned: true };
    const d = { async runJs() { return `complete|1|1|${++n}|${n}`; }, async settleTab() { return { navigated: false, leaving: false, tab }; } } as unknown as SafariDriver;
    await expect(new Page(d, "t1").waitForLoadState("networkidle", { timeout: 600 })).rejects.toMatchObject({ code: "TIMEOUT", message: expect.stringContaining("networkidle") });
  });
  test("호출이 끝난(abort) 코드는 더 이상 페이지에 아무것도 하지 않는다", async () => {
    let aborted = false;
    const tab: TabInfo = { key: "t1", windowId: 1, index: 1, title: "", url: "http://x/", isActive: false, owned: true };
    let calls = 0;
    const d = { async runJs() { calls++; return "loading|1"; }, async settleTab() { return { navigated: false, leaving: false, tab }; } } as unknown as SafariDriver;
    const ai = { windowFor: async () => 1, closed: () => {}, note: () => {}, aborted: () => aborted };
    const p = new Page(d, "t1", ai).waitForLoadState("load", { timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 250));
    aborted = true;
    await expect(p).rejects.toThrow(/이미 끝나서/);
    const after = calls;
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toBe(after);
  });
});

describe("Page 의 이동은 기본으로 domcontentloaded 까지만 기다린다", () => {
  test("goto: interactive 로 끝난다", async () => {
    const { page, log } = fake(["interactive|1|1", "complete|1|1"]);
    await page.goto("http://x/next");
    expect(log.polls).toBe(1);
    expect(log.settleOpts[0]).toMatchObject({ loadBudgetMs: expect.any(Number) });
    expect(log.settleOpts[0]).not.toHaveProperty("waitUntil");
    expect((log.settleOpts[0] as { loadBudgetMs: number }).loadBudgetMs).toBeLessThanOrEqual(15000);
  });
  test("goto {waitUntil:'load'} 는 load 까지 기다린다", async () => {
    const { page, log } = fake(["interactive|1", "interactive|1", "complete|1"]);
    await page.goto("http://x/next", { waitUntil: "load" });
    expect(log.polls).toBe(3);
  });
  test("goto {waitUntil:'commit'} 은 settleTab 에 commit 을 알리고 더 기다리지 않는다", async () => {
    const { page, log } = fake(["loading|0"]);
    await page.goto("http://x/next", { waitUntil: "commit" });
    expect(log.polls).toBe(0);
    expect(log.settleOpts[0]).toMatchObject({ waitUntil: "commit" });
  });
  test("goto {timeout}: 안 뜨면 그 시간 뒤 한국어 TIMEOUT, 호스트에도 그 시간을 넘긴다", async () => {
    const { page, log } = fake(["loading|0|0"]);
    const t0 = Date.now();
    await expect(page.goto("http://x/next", { timeout: 300 })).rejects.toMatchObject({ code: "TIMEOUT", message: expect.stringContaining("쓸 수 있게 되지 않음") });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect((log.settleOpts[0] as { loadBudgetMs: number }).loadBudgetMs).toBeLessThanOrEqual(300);
  });
  test("goto {timeout} 은 110초로 바로잡고 호스트에는 100초까지만 넘긴다", async () => {
    const { page, log } = fake(["complete|1|1"]);
    await page.goto("http://x/next", { timeout: 9_999_999 });
    expect((log.settleOpts[0] as { loadBudgetMs: number }).loadBudgetMs).toBe(100_000);
  });
  test("goto 에 잘못된 waitUntil 은 페이지를 건드리기 전에 오류", async () => {
    const { page, log } = fake(["complete|1"]);
    await expect(page.goto("http://x/", { waitUntil: "soon" as never })).rejects.toThrow(/waitUntil/);
    expect(log.other).toBe(0);
  });
  test("reload · goBack · goForward 도 waitUntil 을 받는다(기본 domcontentloaded)", async () => {
    const a = fake(["interactive|1", "complete|1"]);
    await a.page.reload();
    expect(a.log.polls).toBe(1);
    const b = fake(["interactive|1", "complete|1"]);
    await b.page.goBack({ waitUntil: "load" });
    expect(b.log.polls).toBe(2);
    const c = fake(["loading|0"]);
    await c.page.goForward({ waitUntil: "commit" });
    expect(c.log.polls).toBe(0);
  });
  test("waitForURL 도 기본은 domcontentloaded, {waitUntil:'load'} 면 load", async () => {
    const a = fake(["interactive|1", "complete|1"]);
    await a.page.waitForURL("http://x/");
    expect(a.log.polls).toBe(1);
    const b = fake(["interactive|1", "complete|1"]);
    await b.page.waitForURL("http://x/", { waitUntil: "load" });
    expect(b.log.polls).toBe(2);
  });
});

describe("openTab 의 waitUntil", () => {
  test("기본은 드라이버가 돌려준 때에 바로 끝난다(더 기다리지 않는다)", async () => {
    const d = createFakeDriver();
    let polls = 0;
    d.answer = (_k, src) => (src.includes("readyState") ? (polls++, "interactive|1") : "");
    const s = createReplSession(d);
    await s.run('const p1 = await openTab("http://a/"); console.log(p1.key)');
    expect(polls).toBe(0);
    await s.dispose();
  });
  test("{waitUntil:'load'} 는 load 까지 기다린다", async () => {
    const d = createFakeDriver();
    let polls = 0;
    d.answer = (_k, src) => (src.includes("readyState") ? ++polls < 3 ? "interactive|1" : "complete|1" : "");
    const s = createReplSession(d);
    const r = await s.run('await openTab("http://a/", { waitUntil: "load" }); console.log("끝")');
    expect(r).toEqual({ output: "끝" });
    expect(polls).toBe(3);
    await s.dispose();
  });
  test("{waitUntil:'networkidle'}", async () => {
    const d = createFakeDriver();
    d.answer = (_k, src) => (src.includes("getEntriesByType") ? "complete|1|1|2|40" : "");
    const s = createReplSession(d);
    const t0 = Date.now();
    await s.run('await openTab("http://a/", { waitUntil: "networkidle" })');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(480);
    await s.dispose();
  });
  test("잘못된 waitUntil 이면 탭을 열지 않는다", async () => {
    const d = createFakeDriver();
    const s = createReplSession(d);
    const r = await s.run('await openTab("http://a/", { waitUntil: "later" })');
    expect(r.error).toContain("waitUntil");
    expect(d.calls.openTab).toEqual([]);
    await s.dispose();
  });
  test("{waitUntil:'load', timeout} 시간 안에 안 뜨면 TIMEOUT 오류, 탭은 남아 page 로 쓸 수 있다", async () => {
    const d = createFakeDriver();
    d.answer = (_k, src) => (src.includes("readyState") ? "interactive|1" : "");
    const s = createReplSession(d);
    const r = await s.run('await openTab("http://a/", { waitUntil: "load", timeout: 300 })');
    expect(r.errorCode).toBe("TIMEOUT");
    expect((await s.run("console.log(tabs.length)")).output).toBe("1");
    await s.dispose();
  });
});
