import { describe, expect, test } from "vitest";
import type { SafariDriver, TabInfo } from "../../src/driver/types.js";
import { createReplSession } from "../../src/repl/context.js";
import { Page } from "../../src/repl/page.js";
import { createFakeDriver } from "../helpers/fake-driver.js";

type Settle = { navigated: boolean; leaving: boolean; url?: string };

/**
 * settle(n, 시작 뒤 지난 밀리초) 가 settleTab 의 답을 정한다. readyState 읽기(runJs 에 readyState 가 든 글)는 reads 로 센다.
 * 동작(goto · click · nav)은 expectNav 로 답한다.
 */
function fake(settle: (n: number, ms: number) => Settle, opts: { expectNav?: boolean; navUrl?: string } = {}) {
  const log = { settles: [] as unknown[], reads: 0, actions: 0 };
  const t0 = Date.now();
  let n = 0;
  const d = {
    async runJs(_key: string, source: string) {
      if (source.includes("readyState")) {
        log.reads++;
        return "complete|1|1";
      }
      log.actions++;
      return JSON.stringify({ ok: true, r: { expectNav: opts.expectNav ?? true, v: opts.navUrl ?? "http://x/old" } });
    },
    async settleTab(_key: string, o?: unknown) {
      log.settles.push(o);
      const r = settle(n++, Date.now() - t0);
      const tab: TabInfo = { key: "t1", windowId: 1, index: 1, title: "", url: r.url ?? "http://x/old", isActive: false, owned: true };
      return { navigated: r.navigated, leaving: r.leaving, tab };
    },
    lastUrl: () => "http://x/old",
  } as unknown as SafariDriver;
  return { page: new Page(d, "t1"), log };
}

describe("goto · reload · 뒤로 · 앞으로: 떠나는 중이면 새 문서가 올 때까지 호출한 시간만큼 기다린다", () => {
  test("goto: 느린 서버(12초 가정 대신 0.6초) — 떠나는 중이다가 새 문서가 오면 정상 끝, 8초 상한 · 2초 grace 에 막히지 않는다", async () => {
    const { page, log } = fake((_n, ms) => (ms < 600 ? { navigated: false, leaving: true } : { navigated: true, leaving: false, url: "http://x/new" }));
    await page.goto("http://x/new", { timeout: 30_000 });
    expect(log.reads).toBe(1); // 새 문서에서 domcontentloaded 확인
  });
  test("goto: 계속 떠나는 중이면 호출한 시간 뒤 한국어 TIMEOUT(옛 문서에서 load 를 기다리다 끝내지 않는다)", async () => {
    const { page, log } = fake(() => ({ navigated: false, leaving: true }));
    const t0 = Date.now();
    await expect(page.goto("http://x/new", { timeout: 700 })).rejects.toMatchObject({ code: "TIMEOUT", message: expect.stringContaining("700ms 안에 이동하지 않음") });
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(log.reads).toBe(0);
  });
  test("goto: 같은 문서 안 이동(해시만, 이동 없음)은 기다리지 않고 끝나며 load 도 확인하지 않는다", async () => {
    const { page, log } = fake(() => ({ navigated: false, leaving: false }), { expectNav: false });
    const t0 = Date.now();
    await page.goto("http://x/old#a");
    expect(Date.now() - t0).toBeLessThan(500);
    expect(log.reads).toBe(0);
  });
  test("goto: 떠나는 낌새 없이 이동도 안 일어나면 grace 뒤 끝낸다(오류 아님, 옛 문서에서 기다리지 않음)", async () => {
    const { page, log } = fake(() => ({ navigated: false, leaving: false }));
    await page.goto("http://x/new", { timeout: 30_000 });
    expect(log.reads).toBe(0);
  });
  test("reload: 계속 떠나는 중이면 TIMEOUT", async () => {
    const { page, log } = fake(() => ({ navigated: false, leaving: true }));
    await expect(page.reload({ timeout: 600 })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(log.reads).toBe(0);
  });
  test("goBack: 갈 곳이 없으면(떠나는 낌새 없음) 잠깐 뒤 아무 일 없이 끝난다", async () => {
    const { page, log } = fake(() => ({ navigated: false, leaving: false }));
    await page.goBack({ timeout: 30_000 });
    expect(log.reads).toBe(0);
  });
  test("goBack: 되살아난 문서(bfcache — 표시는 그대로, 주소만 바뀜)도 새 문서처럼 끝난다", async () => {
    const { page, log } = fake(() => ({ navigated: false, leaving: false, url: "http://x/prev" }), { navUrl: "http://x/old" });
    await page.goBack();
    expect(log.reads).toBe(1);
  });
  test("호스트에 넘기는 기다림은 남은 시간(최대 100초)", async () => {
    const { page, log } = fake(() => ({ navigated: true, leaving: false }));
    await page.goto("http://x/new", { timeout: 40_000 });
    const b = (log.settles[0] as { loadBudgetMs: number }).loadBudgetMs;
    expect(b).toBeLessThanOrEqual(40_000);
    expect(b).toBeGreaterThan(39_000);
  });
});

describe("waitForURL 과 동작(클릭 등) 뒤 이동 확인도 호스트 기다림을 남은 시간으로 맞춘다", () => {
  test("waitForURL(url, {timeout:2000}): settleTab 에 2000 이하를 넘긴다", async () => {
    const { page, log } = fake(() => ({ navigated: false, leaving: false, url: "http://x/yes" }));
    await page.waitForURL("http://x/yes", { timeout: 2000 });
    expect((log.settles[0] as { loadBudgetMs: number }).loadBudgetMs).toBeLessThanOrEqual(2000);
  });
  test("waitForURL: 주소가 안 맞으면 timeout 뒤 오류", async () => {
    const { page } = fake(() => ({ navigated: false, leaving: false, url: "http://x/no" }));
    const t0 = Date.now();
    await expect(page.waitForURL("http://x/yes", { timeout: 400 })).rejects.toThrow(/맞지 않았어요/);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
  test("클릭(nav 없음): 기본 15초 이하를 호스트에 넘기고, 떠나는 중이면 8초까지만 기다리던 옛 동작 그대로(여기서는 바로 새 문서)", async () => {
    const { page, log } = fake((n) => ({ navigated: n >= 1, leaving: n < 1 }));
    await page.locator("e1").click();
    expect((log.settles[0] as { loadBudgetMs: number }).loadBudgetMs).toBeLessThanOrEqual(15_000);
    expect((log.settles[0] as { loadBudgetMs: number }).loadBudgetMs).toBeGreaterThan(14_000);
  });
});

describe("screenshot 의 load 대기", () => {
  test("읽기가 실패해도 찍는다, 호출이 끝났으면(abort) 읽기 실패를 삼키지 않고 멈춘다", async () => {
    let aborted = false;
    const d = {
      async showTab() {},
      async runJs() {
        throw new Error("읽을 수 없음");
      },
      async captureWindow() {
        return Buffer.from("png");
      },
    } as unknown as SafariDriver;
    const ai = { windowFor: async () => 7, closed: () => {}, note: () => {}, aborted: () => aborted };
    const page = new Page(d, "t1", ai);
    expect((await page.screenshot()).toString()).toBe("png");
    aborted = true;
    await expect(page.screenshot()).rejects.toThrow(/이미 끝나서/);
  });
});

describe("REPL 코드에서는 열기용 기다림 함수를 부를 수 없다", () => {
  test("page.waitLoad 는 없다", async () => {
    const d = createFakeDriver();
    d.answer = () => "complete|1|1";
    const s = createReplSession(d);
    const r = await s.run('const p = await openTab("http://a/"); console.log(typeof p.waitLoad, Object.getOwnPropertySymbols(p).length)');
    expect(r.output).toBe("undefined 0");
    await s.dispose();
  });
});
