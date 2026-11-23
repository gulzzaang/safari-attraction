import { afterEach, describe, expect, test, vi } from "vitest";
import { createJxaDriver } from "../../src/driver/jxa-driver.js";
import { HostError } from "../../src/driver/jxa-host.js";
import { createHarness, type Harness } from "../helpers/host-harness.js";

// 최종 검토(계획 6)의 고침들: 호스트(host.js)를 진짜로 돌리는 가짜 사파리 위에서 드라이버 · 레지스트리까지 이어서 본다.
const KEY = "t1.abcd1234";

/** 드라이버가 호스트 op 를 그대로 부르는 가짜 호스트(오류는 진짜 호스트처럼 HostError 로). */
function driverOn(h: Harness) {
  const warned: string[] = [];
  const host = {
    async call(op: string, args: object = {}) {
      const f = h.ops[op];
      if (!f) throw new HostError(`모르는 op ${op}`);
      try {
        return f(args as Record<string, unknown>);
      } catch (e) {
        throw new HostError(String((e as Error).message), (e as { errorNumber?: number }).errorNumber);
      }
    },
    async close() {},
  };
  return { d: createJxaDriver({ host, warn: (l) => warned.push(l) }), warned };
}
/** 가짜 페이지는 readyState 가 없어 기다림이 예산을 다 쓴다 — 짧게. */
const FAST = { loadBudgetMs: 20 };
const tabsOf = (h: Harness) => h.windows.get(7)!.tabs;
const urls = (h: Harness) => tabsOf(h).map((t) => t.page.href);
const markers = (h: Harness) => tabsOf(h).map((t) => t.page.dataset.saTab ?? "");
/** 우리 탭이 새 문서로 바뀐다(표시가 사라지고 주소가 바뀜). */
const navigate = (h: Harness, i: number, href: string) => {
  const t = tabsOf(h)[i]!;
  t.page.dataset = {};
  t.page.href = href;
};

describe("호스트 settle · rebind: 표시 없는 탭에 표시를 적기 전 확인(R9)", () => {
  const sargs = (o: Record<string, unknown> = {}) => ({ windowId: 7, index: 2, key: KEY, url: "http://a.example/x", loadBudgetMs: 20, ...o });
  const shape = (o: Record<string, unknown> = {}) => ({ count: 2, prev: ["http://user/1"], next: null, ...o });

  test("창 모습(탭 수 · 이웃 주소)이 그대로면 새 문서에 표시를 다시 적는다", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/1" }, { url: "http://a.example/next" });
    expect(h.ops.settle!(sargs({ shape: shape() }))).toMatchObject({ status: "navigated", stamped: true });
    expect(markers(h)).toEqual(["", KEY]);
  });

  test("사용자가 우리 탭 앞에 탭을 끼워 자리의 표시 없는 탭이 사용자 탭이면(탭 수가 늘었다) 표시를 적지 않고 gone", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/1" }, { url: "http://user/new" }, { url: "http://a.example/x", marker: KEY }); // 우리 탭은 3 번째로 밀렸다
    expect(h.ops.settle!(sargs({ shape: shape() }))).toEqual({ status: "gone" });
    expect(markers(h)).toEqual(["", "", KEY]); // 사용자 탭에 안 적었다
  });

  test("탭 수는 같아도 이웃 주소가 다르면 적지 않는다", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/other" }, { url: "http://a.example/next" });
    expect(h.ops.settle!(sargs({ shape: shape() }))).toEqual({ status: "gone" });
    expect(markers(h)).toEqual(["", ""]);
  });

  test("뒤 이웃이 달라도 적지 않는다", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/1" }, { url: "http://a.example/next" }, { url: "http://user/changed" });
    expect(h.ops.settle!(sargs({ shape: shape({ count: 3, next: ["http://user/3"] }) }))).toEqual({ status: "gone" });
    expect(markers(h)).toEqual(["", "", ""]);
  });

  test("창 모습을 모르면 탭 주소가 기록한 주소(또는 가는 중인 주소)와 정확히 같을 때만 적는다", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/1" }, { url: "http://a.example/other" });
    expect(h.ops.settle!(sargs())).toEqual({ status: "gone" }); // 주소가 다르다
    expect(markers(h)).toEqual(["", ""]);
    expect(h.ops.settle!(sargs({ altUrl: "http://a.example/other" }))).toMatchObject({ status: "navigated", stamped: true }); // 가는 중이던 주소
    expect(markers(h)).toEqual(["", KEY]);
  });

  test("rebind 도 같은 확인을 한다", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/1" }, { url: "http://user/new" }, { url: "http://a.example/x", marker: KEY });
    expect(h.ops.rebind!(sargs({ shape: shape() }))).toEqual({ status: "gone" });
    expect(markers(h)).toEqual(["", "", KEY]);
    const h2 = createHarness();
    h2.addWindow(7, { url: "http://user/1" }, { url: "http://a.example/next" });
    expect(h2.ops.rebind!(sargs({ shape: shape() }))).toMatchObject({ status: "ok", stamped: true });
  });

  test("우리 표시가 그대로인 탭은 (창 모습이 달라도) 확인 없이 same", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/1" }, { url: "http://a.example/x", marker: KEY }, { url: "http://user/late" });
    expect(h.ops.settle!(sargs({ shape: shape() }))).toMatchObject({ status: "same" });
  });
});

describe("[C1] 표시를 못 정한 새 탭은 던지지 않고 등록돼 끝낼 때 닫힌다", () => {
  test("다른 사이트로 리디렉트되는 조용한 열기 — 표시가 적히고 끝낼 때 닫힌다(0.3.0 대비 회귀 방지)", async () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/0" });
    h.beforeFirstJs = () => {
      tabsOf(h)[1]!.page.href = "http://www.youtube.example/watch";
    };
    const { d } = driverOn(h);
    const { tab } = await d.openTab("http://youtu.example/abc", { windowId: 7, loadBudgetMs: 20 });
    expect(tab).toMatchObject({ owned: true, index: 2 });
    expect(markers(h)[1]).toMatch(/^t\d+\./);
    expect(await d.closeOwned()).toBe(1);
    expect(urls(h)).toEqual(["http://user/0"]);
  });

  test("증거가 약해 표시를 못 적은 탭도 등록되고, 그 자리에 정확히 연 주소로 그대로 있으면 끝낼 때 닫힌다(사용자 탭은 그대로)", async () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/0" });
    h.beforeFirstJs = () => tabsOf(h).push(h.newTab("http://www.a.example/x")); // 사용자가 끝에 같은 주소 탭을 열어 어느 쪽이 우리 탭인지 모른다
    const { d } = driverOn(h);
    const { tab } = await d.openTab("http://www.a.example/x", { windowId: 7, loadBudgetMs: 20 });
    expect(tab).toMatchObject({ owned: true, index: 2, url: "http://www.a.example/x" });
    expect(markers(h)).toEqual(["", "", ""]); // 아무 탭에도 안 적었다
    expect(await d.closeOwned()).toBe(1);
    expect(urls(h)).toEqual(["http://user/0", "http://www.a.example/x"]); // 우리 자리(2)의 탭이 닫혔고 사용자의 같은 주소 탭은 산다
  });

  test("증거가 약하고 그 자리에 다른 주소의 탭이 와 있으면(사용자 탭이 밀려 옴) 끝낼 때도 닫지 않는다", async () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/0" });
    h.beforeFirstJs = () => tabsOf(h).unshift(h.newTab("http://www.a.example/x")); // [사용자 a/x, user/0, 연 탭] — 열 때 정한 자리(2)는 user/0
    const { d } = driverOn(h);
    await d.openTab("http://www.a.example/x", { windowId: 7, loadBudgetMs: 20 });
    const before = urls(h);
    expect(await d.closeOwned()).toBe(0);
    expect(urls(h)).toEqual(before);
    expect(markers(h)).toEqual(["", "", ""]);
  });
});

describe("[I1] settle · waitFor 가 사용자 탭에 표시를 적지 않는다(V1 · F1)", () => {
  test("V1: 사용자가 우리 탭 앞에 탭을 끼운 뒤 맨 settle — 사용자 탭에 표시를 안 적고 우리 탭은 표시로 찾고 끝낼 때 우리 탭만 닫는다", async () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/1" });
    const { d } = driverOn(h);
    const { tab } = await d.openTab("http://a.example/x", { windowId: 7, loadBudgetMs: 20 });
    tabsOf(h).splice(1, 0, h.newTab("http://user.example/new")); // 우리 탭 앞에 사용자 탭 — 우리 탭은 3 번째로 밀렸다(표시는 그대로)
    const r = await d.settleTab(tab.key, FAST);
    expect(r.tab.index).toBe(3); // 우리 탭을 표시로 찾았다
    expect(markers(h)[1]).toBe(""); // 사용자 탭에는 안 적었다
    expect(await d.closeOwned()).toBe(1);
    expect(urls(h)).toEqual(["http://user/1", "http://user.example/new"]); // 사용자 탭은 둘 다 산다
  });

  test("F1: 우리 탭이 이동한 바로 그때 사용자가 앞에 탭을 끼우면 표시를 적지 않는다(우리 탭을 잃어도 사용자 탭은 안 닫는다)", async () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/1" });
    const { d } = driverOn(h);
    const { tab } = await d.openTab("http://a.example/x", { windowId: 7, loadBudgetMs: 20 });
    navigate(h, 1, "http://a.example/y"); // 우리 탭이 새 문서로
    tabsOf(h).splice(1, 0, h.newTab("http://user.example/new")); // 그리고 사용자가 앞에 탭을 끼움
    await expect(d.settleTab(tab.key, FAST)).rejects.toMatchObject({ code: "TAB_CLOSED" });
    expect(markers(h)).toEqual(["", "", ""]);
    await d.closeOwned();
    expect(urls(h)).toEqual(["http://user/1", "http://user.example/new", "http://a.example/y"]); // 사용자 탭은 그대로(우리 탭은 남는다)
  });

  test("waitFor 처럼 settle 을 되풀이하는 동안 사용자가 탭을 끼워도 사용자 탭은 표시 · 닫힘 없이 살고 우리 탭은 끝에 닫힌다", async () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/1" });
    const { d } = driverOn(h);
    const { tab } = await d.openTab("http://a.example/x", { windowId: 7, loadBudgetMs: 20 });
    for (let i = 0; i < 3; i++) {
      tabsOf(h).splice(1, 0, h.newTab(`http://user.example/new${i}`));
      await d.settleTab(tab.key, FAST);
    }
    expect(markers(h).filter((m) => m !== "")).toEqual([expect.stringMatching(/^t\d+\./)]); // 우리 표시는 하나뿐
    expect(await d.closeOwned()).toBe(1);
    expect(urls(h)).toEqual(["http://user/1", "http://user.example/new2", "http://user.example/new1", "http://user.example/new0"]);
  });

  test("우리가 직접 이동시킨(goto · click) 탭은 사용자 변화가 없으면 표시를 다시 적는다 — TAB_CLOSED 없이", async () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/1" });
    const { d } = driverOn(h);
    const { tab } = await d.openTab("http://a.example/x", { windowId: 7, loadBudgetMs: 20 });
    navigate(h, 1, "http://a.example/y");
    const r1 = await d.settleTab(tab.key, FAST);
    expect(r1).toMatchObject({ navigated: true, tab: { index: 2, url: "http://a.example/y" } });
    navigate(h, 1, "http://a.example/z");
    expect((await d.settleTab(tab.key, FAST)).navigated).toBe(true); // 두 번째 이동도
    expect(await d.closeOwned()).toBe(1);
    expect(urls(h)).toEqual(["http://user/1"]);
  });

  test("앞에 끼어든 사용자 탭을 따라잡은 뒤(표시로 우리 탭을 다시 찾음)에는 우리 탭이 이동해도 표시를 다시 적는다", async () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/1" });
    const { d } = driverOn(h);
    const { tab } = await d.openTab("http://a.example/x", { windowId: 7, loadBudgetMs: 20 });
    tabsOf(h).splice(1, 0, h.newTab("http://user.example/new"));
    await d.settleTab(tab.key, FAST); // 표시로 우리 탭(3 번째)을 찾았다
    navigate(h, 2, "http://a.example/y");
    expect(await d.settleTab(tab.key, FAST)).toMatchObject({ navigated: true, tab: { index: 3 } });
    expect(markers(h)[1]).toBe(""); // 끼어든 사용자 탭은 그대로
    expect(await d.closeOwned()).toBe(1);
    expect(urls(h)).toEqual(["http://user/1", "http://user.example/new"]);
  });

  test("이동한 우리 탭 뒤에 탭을 하나 더 열어도(창 모습 기록이 이어진다) 두 탭 모두 다음 이동에서 표시를 다시 적는다", async () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/1" });
    const { d } = driverOn(h);
    const a = (await d.openTab("http://a.example/x", { windowId: 7, loadBudgetMs: 20 })).tab;
    navigate(h, 1, "http://a.example/y");
    await d.settleTab(a.key, FAST); // A 가 이동(주소가 바뀜)
    const b = (await d.openTab("http://b.example/x", { windowId: 7, loadBudgetMs: 20 })).tab; // 같은 창에 B 를 더 연다
    navigate(h, 2, "http://b.example/y");
    expect((await d.settleTab(b.key, FAST)).navigated).toBe(true);
    navigate(h, 1, "http://a.example/z");
    expect((await d.settleTab(a.key, FAST)).navigated).toBe(true);
    expect(await d.closeOwned()).toBe(2);
    expect(urls(h)).toEqual(["http://user/1"]);
  });
});

describe("[I2a] 표시 읽기: 페이지 JS 가 오류를 내는 탭은 읽지 못한 탭으로 따로 알린다", () => {
  test("호스트 readMarkers 는 JS 오류가 난 탭을 unreadable 로 돌려주고(없는 탭은 뺀다), 시간 초과 · 허용 꺼짐은 그대로다", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://u.example/doc.pdf" }, { url: "http://a.example/x", marker: KEY });
    tabsOf(h)[0]!.page.throwAfterRun = { message: "문서에서 자바스크립트를 돌릴 수 없음", number: -10000 };
    const r = h.ops.readMarkers!({ spots: [{ windowId: 7, index: 1 }, { windowId: 7, index: 2 }, { windowId: 7, index: 9 }], timeoutMs: 500 });
    expect(r).toEqual([
      { windowId: 7, index: 1, url: "http://u.example/doc.pdf", marker: "", unreadable: true },
      { windowId: 7, index: 2, url: "http://a.example/x", marker: KEY },
    ]);
    tabsOf(h)[1]!.page.jsOff = true;
    expect(() => h.ops.readMarkers!({ spots: [{ windowId: 7, index: 2 }], timeoutMs: 500 })).toThrow(/Apple 이벤트/);
  });

  test("창에 PDF 같은 JS 못 도는 웹 탭이 있어도, 우리 탭이 같은 사이트의 새 문서가 되면 끝낼 때 닫힌다(F2b)", async () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://u.example/doc.pdf" });
    tabsOf(h)[0]!.page.throwAfterRun = { message: "문서에서 자바스크립트를 돌릴 수 없음", number: -10000 };
    const { d } = driverOn(h);
    await d.openTab("http://a.example/login", { windowId: 7, loadBudgetMs: 20 });
    navigate(h, 1, "http://a.example/home"); // 로그인 뒤 같은 사이트의 새 문서
    expect(await d.closeOwned()).toBe(1);
    expect(urls(h)).toEqual(["http://u.example/doc.pdf"]);
  });
});

// R12: 표시를 다시 적을 때 견주는 모습은 긴 기록이 아니라 「우리 표시를 마지막으로 확인한 바로 그때」의 것이다(확인한 호스트 호출이 함께 알려 준다).
describe("[R12] 바로 앞 확인 모습과 견줘 표시 적기", () => {
  test("(a) 사용자가 창 끝에 탭을 연 뒤에 Claude 가 우리 탭에서 동작해(확인) 새 문서가 떠도 표시를 다시 적는다 — TAB_CLOSED 없이", async () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/1" });
    const { d } = driverOn(h);
    const { tab } = await d.openTab("http://a.example/x", { windowId: 7, loadBudgetMs: 20 });
    tabsOf(h).push(h.newTab("http://user.example/late")); // 사용자가 열어 둔 탭(열기 뒤 · 창 모습 기록 뒤)
    await d.runJs(tab.key, "1"); // 우리 표시를 확인한다 — 그때의 창 모습이 새 기준이 된다
    navigate(h, 1, "http://a.example/y"); // 링크를 눌러 새 문서
    expect(await d.settleTab(tab.key, FAST)).toMatchObject({ navigated: true, tab: { index: 2 } });
    expect(markers(h)).toEqual(["", expect.stringMatching(/^t\d+\./), ""]);
  });

  test("(b) 확인한 뒤 우리 탭이 이동하는 도중에 사용자가 앞에 탭을 끼우면 표시를 적지 않는다(우리 탭은 남고 사용자 탭은 그대로)", async () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/1" });
    const { d } = driverOn(h);
    const { tab } = await d.openTab("http://a.example/x", { windowId: 7, loadBudgetMs: 20 });
    await d.runJs(tab.key, "1");
    navigate(h, 1, "http://a.example/y");
    tabsOf(h).splice(1, 0, h.newTab("http://user.example/new"));
    await expect(d.settleTab(tab.key, FAST)).rejects.toMatchObject({ code: "TAB_CLOSED" });
    expect(markers(h)).toEqual(["", "", ""]);
    expect(urls(h)).toEqual(["http://user/1", "http://user.example/new", "http://a.example/y"]);
  });

  test("(b) 표시가 그대로인 채 앞에 탭이 끼면(V1) 표시로 우리 탭을 찾고, 그 확인이 새 기준이 돼 다음 이동은 다시 적는다", async () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/1" });
    const { d } = driverOn(h);
    const { tab } = await d.openTab("http://a.example/x", { windowId: 7, loadBudgetMs: 20 });
    tabsOf(h).splice(1, 0, h.newTab("http://user.example/new"));
    await d.settleTab(tab.key, FAST);
    navigate(h, 2, "http://a.example/y");
    expect(await d.settleTab(tab.key, FAST)).toMatchObject({ navigated: true, tab: { index: 3 } });
    expect(markers(h)[1]).toBe("");
  });

  test("(c) waitFor 처럼 settle 을 되풀이할 때마다 기준이 새로워져, 우리 탭에서 먼 사용자 탭이 늘어도 그 뒤 이동은 다시 적는다", async () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/1" });
    const { d } = driverOn(h);
    const { tab } = await d.openTab("http://a.example/x", { windowId: 7, loadBudgetMs: 20 });
    for (let i = 0; i < 3; i++) {
      tabsOf(h).push(h.newTab(`http://user.example/far${i}`));
      await d.settleTab(tab.key, FAST); // 확인(same) — 기준 갱신
    }
    navigate(h, 1, "http://a.example/y");
    expect((await d.settleTab(tab.key, FAST)).navigated).toBe(true);
    expect(await d.closeOwned()).toBe(1);
    expect(urls(h)).toEqual(["http://user/1", "http://user.example/far0", "http://user.example/far1", "http://user.example/far2"]);
  });

  test("호스트: 표시를 확인한 호출은 창의 탭 수와 바로 앞 · 뒤 주소를 함께 돌려준다(settle same · runJsFast)", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/1" }, { url: "http://a.example/x", marker: KEY }, { url: "http://user/3" });
    const a = { windowId: 7, index: 2, key: KEY, url: "http://a.example/x", loadBudgetMs: 20 };
    expect(h.ops.settle!(a)).toMatchObject({ status: "same", around: { count: 3, prev: "http://user/1", next: "http://user/3" } });
  });
});

// R13: 끝낼 때 표시 읽기 요청 한 번도 남은 시간 안에 끝나야 한다.
describe("[R13] 끝낼 때 표시 읽기 요청 시간", () => {
  test("드라이버: closeOwned 안의 readMarkers 요청 시간은 5초 마감을 넘지 않는다(보통은 탭 수 × 0.5초 + 5초)", async () => {
    const timeouts: Array<number | undefined> = [];
    const tabs = Array.from({ length: 30 }, (_, i) => ({ windowId: 1, index: i + 1, title: "", url: `http://user/${i + 1}`, isActive: i === 0 }));
    const host = {
      async call(op: string, args: object = {}, timeoutMs?: number) {
        const a = args as { spots?: Array<{ windowId: number; index: number }> };
        switch (op) {
          case "openTab": return { windowId: 1, index: 1, title: "", url: "http://a/x", isActive: false, stamped: true };
          case "closeTab": return { stale: true };
          case "settle": return { status: "gone" };
          case "probe": return { exists: true, url: "http://user/1", marker: "" };
          case "listTabs": return tabs;
          case "readMarkers": timeouts.push(timeoutMs); return a.spots!.map((s) => ({ ...s, url: `http://user/${s.index}`, marker: "" }));
          default: throw new Error(`모르는 op ${op}`);
        }
      },
      async close() {},
    };
    const d = createJxaDriver({ host, warn: () => {} });
    await d.openTab("http://a/x");
    await d.closeOwned();
    expect(timeouts.length).toBeGreaterThan(0);
    for (const t of timeouts) expect(t).toBeLessThanOrEqual(5_000);
    for (const t of timeouts) expect(t).toBeGreaterThanOrEqual(1_000);
  });
});

// R14: 오래된 확인 모습으로 표시를 적지 않는다(S1 · S6) · 닫은 뒤 이웃 고치기(S3) · 놓쳤을 때 안내.
describe("[R14] 우리 탭 자리에 사용자 탭이 온 뒤의 settle", () => {
  afterEach(() => vi.useRealTimers());

  test("S1: 확인한 지 한참(60초 넘게) 뒤 사용자가 우리 탭을 닫고 같은 자리에 다른 사이트 탭을 열면 표시를 적지 않고 닫지도 않는다 — 놓쳤어요 안내", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = createHarness();
    h.addWindow(7, { url: "http://user/1" });
    const { d } = driverOn(h);
    const { tab } = await d.openTab("http://a.example/x", { windowId: 7, loadBudgetMs: 20 });
    vi.setSystemTime(Date.now() + 120_000);
    tabsOf(h).splice(1, 1, h.newTab("http://bank.example/account")); // 우리 탭이 닫히고 같은 자리에 사용자 탭
    const err = await d.settleTab(tab.key, FAST).catch((e) => e);
    expect(err).toMatchObject({ code: "TAB_CLOSED" });
    expect(err.message).toMatch(/놓쳤어요/);
    expect(err.message).toContain("attachBrowserTab()");
    expect(markers(h)).toEqual(["", ""]);
    expect(await d.closeOwned()).toBe(0);
    expect(urls(h)).toEqual(["http://user/1", "http://bank.example/account"]);
  });

  test("S6: 방금 확인했어도 자리에 온 탭이 http(s) 가 아니면(시작 페이지 · 즐겨찾기) 표시를 적지 않는다", async () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/1" });
    const { d } = driverOn(h);
    const { tab } = await d.openTab("http://a.example/x", { windowId: 7, loadBudgetMs: 20 });
    tabsOf(h).splice(1, 1, h.newTab("favorites://"));
    await expect(d.settleTab(tab.key, FAST)).rejects.toMatchObject({ code: "TAB_CLOSED" });
    expect(markers(h)).toEqual(["", ""]);
    expect(await d.closeOwned()).toBe(0);
    expect(urls(h)).toEqual(["http://user/1", "favorites://"]);
  });

  test("60초 안에 우리가 한 동작으로 새 문서가 뜨면 지금처럼 표시를 다시 적는다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = createHarness();
    h.addWindow(7, { url: "http://user/1" });
    const { d } = driverOn(h);
    const { tab } = await d.openTab("http://a.example/x", { windowId: 7, loadBudgetMs: 20 });
    vi.setSystemTime(Date.now() + 50_000);
    navigate(h, 1, "http://a.example/y");
    expect((await d.settleTab(tab.key, FAST)).navigated).toBe(true);
  });
});
