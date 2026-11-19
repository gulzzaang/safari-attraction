import type { SafariDriver, TabInfo, WindowInfo } from "../../src/driver/types.js";

export interface FakeCalls {
  openTab: Array<{ url: string; windowId?: number }>;
  runJs: Array<{ key: string; source: string }>;
  closeTab: string[];
  settleTab: string[];
}

export interface FakeDriver extends SafariDriver {
  calls: FakeCalls;
  /** 사용자가 열어 둔 탭(listTabs 에 나온다). 시험이 채운다. */
  userTabs: TabInfo[];
  windows: WindowInfo[];
  /** openTab 이 돌려줄 frontAppChanged 값. 기본 false. */
  frontAppChanged: boolean;
  /** runJs 가 소스를 받아 답한다. 기본은 빈 글. */
  answer: (key: string, source: string) => string | Promise<string>;
}

/** 사파리 없이 REPL 을 시험하는 가짜 드라이버. 탭 키는 t1, t2 … 로 나간다. */
export function createFakeDriver(): FakeDriver {
  let seq = 0;
  const owned: TabInfo[] = [];
  const calls: FakeCalls = { openTab: [], runJs: [], closeTab: [], settleTab: [] };
  const d: FakeDriver = {
    calls,
    userTabs: [],
    windows: [{ id: 1, index: 1, isPrivate: false, tabCount: 1 }],
    frontAppChanged: false,
    answer: () => "",
    async listWindows() {
      return d.windows;
    },
    async listTabs() {
      return [...d.userTabs, ...owned];
    },
    async openTab(url, opts) {
      calls.openTab.push({ url, windowId: opts?.windowId });
      const tab: TabInfo = { key: `t${++seq}`, windowId: 1, index: 1 + owned.length, title: "", url, isActive: false, owned: true };
      owned.push(tab);
      return { tab, frontAppChanged: d.frontAppChanged };
    },
    async runJs(key, source) {
      calls.runJs.push({ key, source });
      return d.answer(key, source);
    },
    async closeTab(key) {
      calls.closeTab.push(key);
      const i = owned.findIndex((t) => t.key === key);
      if (i >= 0) owned.splice(i, 1);
    },
    async rebindTab(key) {
      return { key, windowId: 1, index: 1, title: "", url: "", isActive: false, owned: true };
    },
    async settleTab(key) {
      calls.settleTab.push(key);
      return { navigated: false, leaving: false, tab: { key, windowId: 1, index: 1, title: "", url: "", isActive: false, owned: true } };
    },
    async closeOwned() {
      const n = owned.length;
      owned.length = 0;
      return n;
    },
    async close() {},
  };
  return d;
}
