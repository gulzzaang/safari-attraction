import { describe, expect, test } from "vitest";
import { createJxaDriver } from "../../src/driver/jxa-driver.js";
import { HostError } from "../../src/driver/jxa-host.js";
import { createHarness, type Harness } from "../helpers/host-harness.js";

// 다른 서버(다른 Claude 세션 · 끝난 세션)가 사용자 탭에 남긴 표시(`키.instanceId`)가 있는 탭을 새 서버가 쓸 수 있어야 한다.
// 호스트(host.js)와 탭 확인 글(guarded-source)을 진짜로 돌리는 가짜 사파리 위에서 드라이버 · 레지스트리까지 이어서 본다.
const FOREIGN = "t5.deadbeef";

function driverOn(h: Harness) {
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
  return createJxaDriver({ host, warn: () => {} });
}
const FAST = { loadBudgetMs: 20 };
const tabsOf = (h: Harness) => h.windows.get(7)!.tabs;
const markers = (h: Harness) => tabsOf(h).map((t) => t.page.dataset.saTab ?? "");
const URL1 = "http://user.example/page";

/** 사용자 탭 하나(주소 URL1)에 FOREIGN 표시가 남은 창. */
function foreignWindow(extra: Array<{ url: string; marker?: string }> = []) {
  const h = createHarness();
  h.addWindow(7, { url: URL1, marker: FOREIGN }, ...extra);
  return h;
}
const keyOf = async (d: ReturnType<typeof driverOn>, url = URL1) => (await d.listTabs()).find((t) => t.url === url)!.key;

describe("남의 표시가 남은 사용자 탭", () => {
  test("붙여서 evaluate 가 되고(TAB_CLOSED 없이), 목록을 다시 봐도 같은 키이며, 남의 표시를 덮어쓰지 않는다", async () => {
    const h = foreignWindow();
    const d = driverOn(h);
    const key = await keyOf(d);
    expect(await d.runJs(key, "1 + 1")).toBe("2");
    expect(await keyOf(d)).toBe(key); // 목록마다 새 키로 바뀌지 않는다
    expect(await d.runJs(key, "'다시'")).toBe("다시");
    expect(await keyOf(d)).toBe(key);
    expect(markers(h)).toEqual([FOREIGN]); // 덮어쓰지 않았다
  });

  test("소스가 오류를 던져 빠른 길이 「돌았을 수 있음」으로 끝나도(guardTab 으로 다시 확인) 남의 표시를 안 덮어쓴다", async () => {
    const h = foreignWindow();
    const d = driverOn(h);
    const key = await keyOf(d);
    expect(await d.runJs(key, "null")).toBe("");
    expect(await d.runJs(key, "(function(){ throw new Error('x'); })()").catch(() => "")).toBe("");
    expect(markers(h)).toEqual([FOREIGN]);
    expect(await d.runJs(key, "7")).toBe("7");
  });

  test("호스트 runJs · runJsFast · showTab 은 foreignOk 가 있을 때만 받아들이고 stamped:false 로 알린다", () => {
    const h = foreignWindow();
    const base = { windowId: 7, index: 1, key: "t1.abcd1234", url: URL1, unstamped: true, urls: [URL1], urlForms: [URL1], instance: "abcd1234" };
    expect(h.ops.runJs!({ ...base, source: "3" })).toEqual({ stale: true }); // 깃발이 없으면 전과 같다
    expect(h.ops.runJs!({ ...base, foreignOk: true, source: "3" })).toMatchObject({ value: "3", stamped: false });
    expect(markers(h)).toEqual([FOREIGN]);
  });

  test("끝낼 때(closeOwned) 남의 표시는 지우지 않는다", async () => {
    const h = foreignWindow();
    const d = driverOn(h);
    const key = await keyOf(d);
    await d.runJs(key, "1");
    await d.closeOwned();
    expect(markers(h)).toEqual([FOREIGN]);
    expect(tabsOf(h)).toHaveLength(1);
  });

  test("우리가 연 탭에 남의 표시가 있으면 여전히 거부하고, closeOwned 도 닫지 않는다(0.3.1 안전 규칙)", async () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/1" });
    const d = driverOn(h);
    const { tab } = await d.openTab("http://a.example/x", { windowId: 7, ...FAST });
    tabsOf(h)[1]!.page.dataset.saTab = FOREIGN; // 남이 우리 탭의 표시를 바꿔 놓았다
    await expect(d.runJs(tab.key, "1")).rejects.toMatchObject({ code: "TAB_CLOSED" });
    await d.closeOwned();
    expect(tabsOf(h).map((t) => t.page.href)).toContain("http://a.example/x"); // 남의 표시가 있는 탭은 닫지 않는다
  });

  test("같은 인스턴스의 다른 키 표시는 「남의 것」이 아니다 — 거부한다", async () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/1" }, { url: URL1 });
    const d = driverOn(h);
    const { tab } = await d.openTab("http://a.example/x", { windowId: 7, ...FAST });
    const instance = tabsOf(h)[2]!.page.dataset.saTab!.split(".")[1]!; // 우리 인스턴스(우리 탭에 적힌 표시에서)
    tabsOf(h)[1]!.page.dataset.saTab = `t99.${instance}`; // 우리 다른 탭의 표시가 사용자 탭 자리에 있다
    const user = await keyOf(d);
    await expect(d.runJs(user, "1")).rejects.toMatchObject({ code: "TAB_CLOSED" });
    expect(markers(h)[1]).toBe(`t99.${instance}`);
    expect(await d.runJs(tab.key, "2")).toBe("2");
  });

  test("표시가 없는 사용자 탭은 전처럼 우리 표시를 적고, 끝낼 때 지운다(우리 표시일 때만)", async () => {
    const h = createHarness();
    h.addWindow(7, { url: URL1 }, { url: "http://user.example/two" });
    const d = driverOn(h);
    const key = await keyOf(d);
    const key2 = await keyOf(d, "http://user.example/two");
    await d.runJs(key, "1");
    await d.runJs(key2, "1");
    expect(markers(h).every((m) => /^t\d+\./.test(m))).toBe(true);
    tabsOf(h)[1]!.page.dataset.saTab = FOREIGN; // 둘째 탭의 표시는 그 사이 남이 바꿨다
    await d.closeOwned();
    expect(markers(h)).toEqual(["", FOREIGN]);
  });

  test("끝낼 때 표시를 지우다 오류가 나도 닫기는 끝난다(최선 노력)", async () => {
    const h = createHarness();
    h.addWindow(7, { url: URL1 });
    const d = driverOn(h);
    const key = await keyOf(d);
    await d.runJs(key, "1");
    tabsOf(h)[0]!.page.jsOff = true; // 「Apple 이벤트에서 JavaScript 허용」이 꺼졌다
    await expect(d.closeOwned()).resolves.toBe(0);
  });
});

describe("남의 표시가 있는 사용자 탭의 이동 확인", () => {
  test("동작 뒤 settle: 표시가 그대로면 이동 없음(표시는 새 문서에서 사라진다) — 덮어쓰지 않는다", async () => {
    const h = foreignWindow();
    const d = driverOn(h);
    const key = await keyOf(d);
    await d.runJs(key, "1");
    expect(await d.settleTab(key, FAST)).toMatchObject({ navigated: false, leaving: false, tab: { url: URL1 } });
    expect(markers(h)).toEqual([FOREIGN]);
    expect(await keyOf(d)).toBe(key);
  });

  test("동작 사이에 사용자가 같은 창에 탭을 더 열어도(창 모습이 달라져도) 같은 탭으로 이어 쓴다 — 표시 없는 탭과 같다", async () => {
    const h = foreignWindow();
    const d = driverOn(h);
    const key = await keyOf(d);
    await d.runJs(key, "1");
    tabsOf(h).push(h.newTab("http://user.example/late")); // 사용자가 탭을 하나 더 열었다
    expect(await d.settleTab(key, FAST)).toMatchObject({ navigated: false });
    expect(await d.runJs(key, "2")).toBe("2");
    expect(await keyOf(d)).toBe(key);
    expect(markers(h)[0]).toBe(FOREIGN);
  });

  test("새 문서가 떠 남의 표시가 사라지면 이동으로 보고 우리 표시를 적는다", async () => {
    const h = foreignWindow();
    const d = driverOn(h);
    const key = await keyOf(d);
    await d.runJs(key, "1");
    tabsOf(h)[0]!.page.dataset = {};
    tabsOf(h)[0]!.page.href = "http://user.example/next";
    expect(await d.settleTab(key, FAST)).toMatchObject({ navigated: true });
    expect(markers(h)[0]).toMatch(/^t\d+\./);
    expect(markers(h)[0]).not.toBe(FOREIGN);
  });

  test("호스트 rebind: 새 문서(표시 없음)면 우리 표시를 적고, 남의 표시가 그대로면 기다린 뒤에도 적지 않는다(stamped:false)", () => {
    const h = foreignWindow();
    const args = { windowId: 7, index: 1, key: "t1.abcd1234", url: URL1, unstamped: true, urls: [URL1], instance: "abcd1234", loadBudgetMs: 20 };
    expect(h.ops.rebind!({ ...args, foreignOk: false })).toEqual({ status: "other" }); // 깃발이 없으면 전과 같다
    const r = h.ops.rebind!({ ...args, foreignOk: true }); // 옛 문서가 그대로(남의 표시) — 새 문서가 뜨길 잠깐 기다리고, 안 바뀌면 같은 문서로 본다
    expect(r).toMatchObject({ status: "ok", stamped: false });
    expect(markers(h)).toEqual([FOREIGN]);
    tabsOf(h)[0]!.page.dataset = {}; // 새 문서
    expect(h.ops.rebind!({ ...args, foreignOk: true })).toMatchObject({ status: "ok", stamped: true });
    expect(markers(h)[0]).toBe("t1.abcd1234");
  }, 15_000);

  test("navTimedOut: 남의 표시가 있는 탭은 가는 중인 목적지를 적어 둬 늦게 새 문서가 떠도 알아본다", async () => {
    const h = foreignWindow();
    const d = driverOn(h);
    const key = await keyOf(d);
    await d.runJs(key, "1");
    tabsOf(h)[0]!.dest = "http://user.example/going";
    await d.noteNavTimeout(key);
    tabsOf(h)[0]!.dest = undefined;
    tabsOf(h)[0]!.page.dataset = {};
    tabsOf(h)[0]!.page.href = "http://user.example/going";
    expect(await d.runJs(key, "'온'")).toBe("온"); // 주소(목적지)로 알아보고 표시를 적는다
    expect(await keyOf(d, "http://user.example/going")).toBe(key);
  });
});
