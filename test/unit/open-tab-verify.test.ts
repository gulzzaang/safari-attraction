import { describe, expect, test } from "vitest";
import { createHarness } from "../helpers/host-harness.js";

const KEY = "t1.abcd1234";
const open = (h: ReturnType<typeof createHarness>, url = "http://a/x") => h.ops.openTab!({ windowId: 7, url, key: KEY, loadBudgetMs: 20 });
const markers = (h: ReturnType<typeof createHarness>) => h.windows.get(7)!.tabs.map((t) => t.page.dataset.saTab ?? "");

// 탭을 연 직후 표시를 적기 전에 그 자리의 탭이 정말 우리가 연 탭인지 확인한다 — 기다리는 사이 사용자가 탭을 열고 닫아 순번이 밀리면
// 사용자 탭에 우리 표시를 적지 않고 우리 탭을 다시 찾아 적는다(못 찾으면 아무것도 적지 않고 오류).
describe("openTab: 표시를 적기 전에 탭 확인", () => {
  test("끼어드는 탭이 없으면 연 탭에 표시를 적는다", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/0" });
    const r = open(h);
    expect(r).toMatchObject({ windowId: 7, index: 2, url: "http://a/x", stamped: true });
    expect(markers(h)).toEqual(["", KEY]);
  });

  test("[포커스 5] 기다리는 사이 사용자가 앞에 탭을 열어 순번이 밀려도 사용자 탭에는 표시를 안 적고 연 탭에 적는다", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/0" });
    h.beforeFirstJs = () => h.windows.get(7)!.tabs.unshift(h.newTab("http://user/new"));
    const r = open(h);
    expect(r).toMatchObject({ windowId: 7, index: 3, url: "http://a/x", stamped: true }); // 밀린 새 순번을 알린다
    expect(markers(h)).toEqual(["", "", KEY]);
  });

  test("끼어든 사용자 탭이 같은 주소여도(표시 없음) 연 탭을 뒤에서부터 찾아 그 탭에 적는다", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/0" });
    h.beforeFirstJs = () => h.windows.get(7)!.tabs.unshift(h.newTab("http://a/x"));
    expect(open(h)).toMatchObject({ index: 3, stamped: true });
    expect(markers(h)).toEqual(["", "", KEY]);
  });

  test("사용자가 앞의 탭을 닫아 순번이 당겨져도 연 탭에 적는다", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/0" }, { url: "http://user/1" });
    h.beforeFirstJs = () => h.windows.get(7)!.tabs.shift();
    expect(open(h)).toMatchObject({ index: 2, stamped: true });
    expect(markers(h)).toEqual(["", KEY]);
  });

  test("주소가 바뀐 채(이동 · 리디렉트) 순번은 그대로면 연 탭에 적는다 — 탭 수가 그대로라 밀린 것이 아니다", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/0" });
    h.beforeFirstJs = () => {
      h.windows.get(7)!.tabs[1]!.page.href = "http://consent.example/landing"; // 연 탭이 다른 주소로 감
    };
    expect(open(h)).toMatchObject({ index: 2, stamped: true });
    expect(markers(h)).toEqual(["", KEY]);
  });

  test("순번도 밀리고 주소도 바뀌어 어느 탭인지 확신할 수 없으면 아무 탭에도 표시를 적지 않고 오류로 알린다", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/0" });
    h.beforeFirstJs = () => {
      const tabs = h.windows.get(7)!.tabs;
      tabs[1]!.page.href = "http://consent.example/landing";
      tabs.unshift(h.newTab("http://user/new"));
    };
    expect(() => open(h)).toThrow(/확인/);
    expect(markers(h)).toEqual(["", "", ""]);
    expect(h.events.some((e) => e.kind === "doJavaScript" && e.script.includes("saTab ="))).toBe(false);
  });

  test("이미 다른 표시가 있는 탭에는 적지 않는다", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/0" });
    h.beforeFirstJs = () => h.windows.get(7)!.tabs.unshift(h.newTab("http://a/x", "t9.other")); // 앞에 같은 주소 · 다른 표시 탭
    expect(open(h)).toMatchObject({ index: 3, stamped: true });
    expect(markers(h)).toEqual(["t9.other", "", KEY]);
  });

  test("같은 주소의 사용자 탭이 따로 있고 연 탭이 리디렉트돼도(밀림 없음) 사용자 탭이 아니라 연 탭에 적는다", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://a/x" }); // 사용자가 같은 주소를 열어 둠
    h.beforeFirstJs = () => {
      h.windows.get(7)!.tabs[1]!.page.href = "http://a/login"; // 연 탭만 리디렉트됨(예: 세션 만료)
    };
    expect(open(h)).toMatchObject({ index: 2, stamped: true });
    expect(markers(h)).toEqual(["", KEY]);
  });

  test("연 주소와 같은 사용자 탭이 앞에 있고 순번도 밀려도 연 탭(창 끝 쪽)에 적는다", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://a/x" });
    h.beforeFirstJs = () => h.windows.get(7)!.tabs.unshift(h.newTab("http://user/new")); // [new, 사용자 a/x, 연 탭] — 열 때 정한 자리(2)는 사용자 a/x
    expect(open(h)).toMatchObject({ index: 3, stamped: true });
    expect(markers(h)).toEqual(["", "", KEY]);
  });

  test("「Apple 이벤트에서 JavaScript 허용」이 꺼져 있으면 표시를 읽지 않고 연 탭을 닫고 오류를 올린다(사용자 탭은 그대로)", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/0" });
    h.beforeFirstJs = () => {
      h.windows.get(7)!.tabs[1]!.page.jsOff = true;
    };
    expect(() => open(h)).toThrow(/Apple 이벤트/);
    expect(h.windows.get(7)!.tabs.map((t) => t.page.href)).toEqual(["http://user/0"]); // 연 탭만 닫혔다
  });

  test("JS 허용이 꺼져 있고 순번이 밀렸으면 어느 탭인지 확인되는 것만 닫는다 — 사용자 탭은 닫지 않는다", () => {
    const h = createHarness();
    h.addWindow(7, { url: "http://user/0" });
    h.beforeFirstJs = () => {
      const tabs = h.windows.get(7)!.tabs;
      tabs[1]!.page.jsOff = true;
      tabs.unshift(h.newTab("http://user/new"));
    };
    expect(() => open(h)).toThrow(/Apple 이벤트/);
    expect(h.windows.get(7)!.tabs.map((t) => t.page.href)).toEqual(["http://user/new", "http://user/0"]); // 주소로 확인된 연 탭만 닫혔다
  });
});
