import { describe, expect, test } from "vitest";
import { createJxaDriver } from "../../src/driver/jxa-driver.js";
import { createReplSession } from "../../src/repl/context.js";
import { createFakeDriver } from "../helpers/fake-driver.js";

type Call = { op: string; args: Record<string, unknown>; timeoutMs?: number };

function stubHost() {
  const calls: Call[] = [];
  const tab = { windowId: 5, index: 1, title: "", url: "http://x/", isActive: false };
  return {
    calls,
    host: {
      async call(op: string, args: object = {}, timeoutMs?: number) {
        calls.push({ op, args: args as Record<string, unknown>, timeoutMs });
        if (op === "openTab") return { ...tab, stamped: true };
        if (op === "settle") return { status: "navigated", tab };
        return undefined;
      },
      async close() {},
    },
  };
}

describe("호스트가 페이지를 기다리는 시간(loadBudgetMs)", () => {
  test("openTab: 호출한 시간을 호스트에 넘기고, 15초보다 길면 요청 시간 제한도 늘린다", async () => {
    const { calls, host } = stubHost();
    const d = createJxaDriver({ host });
    await d.openTab("http://x/", { loadBudgetMs: 60_000 });
    expect(calls[0]!.args.loadBudgetMs).toBe(60_000);
    expect(calls[0]!.timeoutMs).toBeGreaterThan(60_000);
  });
  test("openTab: 짧거나 기본이면 요청 시간 제한은 호스트 기본값", async () => {
    const { calls, host } = stubHost();
    const d = createJxaDriver({ host });
    await d.openTab("http://x/", { loadBudgetMs: 2000 });
    await d.openTab("http://x/");
    expect(calls[0]!.args.loadBudgetMs).toBe(2000);
    expect(calls[0]!.timeoutMs).toBeUndefined();
    expect(calls[1]!.timeoutMs).toBeUndefined();
  });
  test("settleTab: loadBudgetMs · commit 이 호스트 settle 까지 간다", async () => {
    const { calls, host } = stubHost();
    const d = createJxaDriver({ host });
    const { tab } = await d.openTab("http://x/");
    await d.settleTab(tab.key, { waitUntil: "commit", loadBudgetMs: 2000 });
    await d.settleTab(tab.key, { loadBudgetMs: 90_000 });
    const settles = calls.filter((c) => c.op === "settle");
    expect(settles[0]!.args).toMatchObject({ waitUntil: "commit", loadBudgetMs: 2000 });
    expect(settles[0]!.timeoutMs).toBeUndefined();
    expect(settles[1]!.args.loadBudgetMs).toBe(90_000);
    expect(settles[1]!.timeoutMs).toBeGreaterThan(90_000);
  });
});

describe("REPL openTab 의 timeout", () => {
  test("정규화한 시간(기본 15초, 최대 110초)을 드라이버에 넘긴다", async () => {
    const d = createFakeDriver();
    const seen: Array<number | undefined> = [];
    const orig = d.openTab.bind(d);
    d.openTab = async (url, o) => {
      seen.push(o?.loadBudgetMs);
      return orig(url, o);
    };
    d.answer = () => "complete|1|1";
    const s = createReplSession(d);
    await s.run('await openTab("http://a/"); await openTab("http://a/", { timeout: 2000 }); await openTab("http://a/", { timeout: 999999 })');
    expect(seen).toEqual([15000, 2000, 110000]);
    await s.dispose();
  });
  test("timeout 을 줬는데 쓸 수 있게 안 되면 한국어 TIMEOUT 오류(탭은 남는다)", async () => {
    const d = createFakeDriver();
    d.answer = () => "loading|0|0";
    const s = createReplSession(d);
    const t0 = Date.now();
    const r = await s.run('await openTab("http://a/", { timeout: 300 })');
    expect(r.errorCode).toBe("TIMEOUT");
    expect(r.error).toContain("쓸 수 있게 되지 않음");
    expect(Date.now() - t0).toBeLessThan(1500);
    await s.dispose();
  });
  test("timeout 을 안 주면 확인 호출을 더하지 않는다(기본 열기는 빠르게)", async () => {
    const d = createFakeDriver();
    let polls = 0;
    d.answer = () => (polls++, "loading|0|0");
    const s = createReplSession(d);
    await s.run('await openTab("http://a/")');
    expect(polls).toBe(0);
    await s.dispose();
  });
});
