import { SafariError, type SafariDriver, type TabInfo, type WindowInfo } from "../../src/driver/types.js";

export interface FakeCalls {
  openTab: Array<{ url: string; windowId?: number }>;
  runJs: Array<{ key: string; source: string }>;
  closeTab: string[];
  settleTab: string[];
  openWindow: Array<{ url: string; width?: number; height?: number }>;
  setWindowSize: Array<{ windowId: number; width: number; height: number }>;
  closeWindow: number[];
  captureWindow: number[];
  showTab: string[];
  adoptWindow: number[];
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
  /** screenCaptureAllowed 가 돌려줄 값. 기본 true. */
  screenAllowed: boolean;
  /** captureWindow 가 돌려줄 그림. 기본은 PNG 서명만 든 8바이트. */
  png: Buffer;
}

/** 사파리 없이 REPL 을 시험하는 가짜 드라이버. 탭 키는 t1, t2 … 로 나간다. */
export function createFakeDriver(): FakeDriver {
  let seq = 0;
  const owned: TabInfo[] = [];
  let winSeq = 100;
  const ownedWindows: WindowInfo[] = [];
  const adopted = new Set<number>();
  const usable = (id: number) => adopted.has(id) || ownedWindows.some((w) => w.id === id);
  const calls: FakeCalls = { openTab: [], runJs: [], closeTab: [], settleTab: [], openWindow: [], setWindowSize: [], closeWindow: [], captureWindow: [], showTab: [], adoptWindow: [] };
  const d: FakeDriver = {
    calls,
    userTabs: [],
    windows: [{ id: 1, index: 1, isPrivate: false, tabCount: 1, visible: true, minimized: false, bounds: { x: 0, y: 0, width: 1200, height: 800 }, title: "", owned: false }],
    frontAppChanged: false,
    answer: () => "",
    screenAllowed: true,
    png: Buffer.from("89504e470d0a1a0a", "hex"),
    async listWindows() {
      return [...d.windows, ...ownedWindows];
    },
    async listTabs() {
      return [...d.userTabs, ...owned];
    },
    async openTab(url, opts) {
      calls.openTab.push({ url, windowId: opts?.windowId });
      const tab: TabInfo = { key: `t${++seq}`, windowId: opts?.windowId ?? 1, index: 1 + owned.length, title: "", url, isActive: false, owned: true };
      owned.push(tab);
      return { tab, frontAppChanged: d.frontAppChanged };
    },
    async openWindow(url, opts) {
      calls.openWindow.push({ url, width: opts?.width, height: opts?.height });
      const windowId = ++winSeq;
      const tab: TabInfo = { key: `t${++seq}`, windowId, index: 1, title: "", url, isActive: true, owned: true };
      owned.push(tab);
      ownedWindows.push({
        id: windowId,
        index: d.windows.length + ownedWindows.length + 1,
        isPrivate: false,
        tabCount: 1,
        visible: true,
        minimized: false,
        bounds: { x: 0, y: 0, width: opts?.width ?? 1200, height: opts?.height ?? 800 },
        title: "",
        owned: true,
      });
      return { windowId, tab, frontAppChanged: d.frontAppChanged };
    },
    async setWindowSize(windowId, width, height) {
      calls.setWindowSize.push({ windowId, width, height });
      if (!usable(windowId)) throw new SafariError("SAFARI_ERROR", "Claude 가 연 창이나 AI 전용 창으로 고른 창만 크기를 바꿔요");
      return { innerWidth: width, innerHeight: height };
    },
    async closeWindow(windowId) {
      calls.closeWindow.push(windowId);
      const i = ownedWindows.findIndex((w) => w.id === windowId);
      if (i < 0) throw new SafariError("SAFARI_ERROR", "Claude 가 연 창만 닫아요");
      ownedWindows.splice(i, 1);
      for (let j = owned.length - 1; j >= 0; j--) if (owned[j]!.windowId === windowId) owned.splice(j, 1);
    },
    async captureWindow(windowId) {
      calls.captureWindow.push(windowId);
      if (!d.screenAllowed) throw new SafariError("SCREEN_CAPTURE_DENIED", "창을 찍지 못함");
      return d.png;
    },
    async showTab(key) {
      calls.showTab.push(key);
      const t = owned.find((x) => x.key === key);
      if (!t) throw new SafariError("TAB_CLOSED", `모르는 탭 ${key}`);
      if (!usable(t.windowId)) throw new SafariError("SAFARI_ERROR", "Claude 가 연 창 안의 탭만 앞에 보여요");
    },
    async adoptWindow(windowId) {
      calls.adoptWindow.push(windowId);
      if (![...d.windows, ...ownedWindows].some((w) => w.id === windowId)) throw new SafariError("WINDOW_CLOSED", `창 ${windowId} 이(가) 이미 닫혔음`);
      if (!ownedWindows.some((w) => w.id === windowId)) adopted.add(windowId);
    },
    async screenCaptureAllowed() {
      return d.screenAllowed;
    },
    async runJs(key, source) {
      calls.runJs.push({ key, source });
      return d.answer(key, source);
    },
    lastUrl(key) {
      return [...d.userTabs, ...owned].find((t) => t.key === key)?.url;
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
      const n = ownedWindows.length + owned.filter((t) => !ownedWindows.some((w) => w.id === t.windowId)).length;
      owned.length = 0;
      ownedWindows.length = 0;
      adopted.clear();
      return n;
    },
    async close() {},
  };
  return d;
}
