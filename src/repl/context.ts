import { AsyncLocalStorage } from "node:async_hooks";
import vm from "node:vm";
import { inspect } from "node:util";
import { GUIDES, listGuides, type SiteGuide } from "../guides/index.js";
import { fetchIsIrreversible } from "../gate/classify.js";
import { assertAllowed, clipTarget, hostOf, isNonWebDestination, type ActionGate } from "../gate/gate.js";
import { guideAnswer } from "../guides/notes.js";
import type { Touch } from "../memory/activity.js";
import { SafariError, type SafariDriver, type SafariErrorCode, type TabInfo } from "../driver/types.js";
import { buildSnapshotSource, type SnapshotOptions } from "../snapshot/inpage.js";
import { SnapshotStore, splitSnapshotMeta } from "../snapshot/store.js";
import { LOAD_TIMEOUT_MS, MAX_HOST_BUDGET_MS, parseWaitUntil, type WaitUntil } from "./load-state.js";
import { normTimeout } from "./locator.js";
import { GATE_ASK, Page, RAW_EVALUATE, WAIT_LOAD, type AiWindowAccess, type PageOptions } from "./page.js";
import { OutputBuffer } from "./output.js";
import { hoistTopLevel } from "./transform.js";

/** 한 호출의 결과. images 는 display() 로 붙인 PNG(base64)이고 없으면 빠진다. */
export interface ReplResult {
  output: string;
  error?: string;
  errorCode?: SafariErrorCode;
  images?: string[];
  /**
   * 이 호출에서 사파리가 닿은 곳(열기 · 붙이기 · 열려 있던 탭의 이동). 같은 주소는 한 번, about:blank · 빈 주소는 뺀다.
   * 오류 · 시간 초과로 끝나도 그때까지 모은 것이 온다. 닿은 곳이 없으면 빠진다.
   */
  touched?: Touch[];
}

export interface ReplSession {
  run(code: string, opts?: { timeoutMs?: number }): Promise<ReplResult>;
  /**
   * 주소들을 차례로 뒤쪽 탭으로 연다(project 도구의 open_sites). 안에서 repl 의 openTab 과 같은 함수를 부르므로 작업 창 · owned 등록 · 끝날 때 닫힘이 그대로다.
   * 출력은 「열었어요: 주소」 · 「못 열었어요: 주소 — 이유」 줄, touched 는 repl 호출처럼 채운다. 한 주소가 실패해도 나머지는 연다(모두 실패하면 error).
   * 한 번에 OPEN_TABS_MAX(10)개까지, 넘는 것은 열지 않고 알린다. repl 호출과 같은 차례 줄을 쓴다.
   */
  openTabs(urls: string[], opts?: { timeoutMs?: number }): Promise<ReplResult>;
  /**
   * 기다리지 않은 거부(Promise.reject · 늦게 던진 오류)나 타이머 · 콜백에서 난 오류가 프로세스 바깥까지 올라왔을 때 부른다.
   * 그 일이 REPL 호출 코드에서 비롯됐으면(AsyncLocalStorage 칸이 따라옴) 살아 있는 호출의 출력에 한국어 한 줄을 남기고 true 를 돌려준다.
   * 서버 자신의 문제거나 어느 호출 것인지 모르면 false.
   */
  handleStray(reason: unknown, kind: "rejection" | "exception"): boolean;
  /**
   * 세션이 지금 쥐고 있는(열었거나 붙인, 아직 안 닫은) 페이지들의 마지막으로 알려진 주소. 열린 순서이고 빈 주소 · 읽을 수 없는 것은 뺀다.
   * 닿은 곳이 아니라 「지금 들고 있는 것」 이라, 안내 요약이 16KB 상한에 잘렸을 때 다음 호출에 다시 시도하는 데 쓴다.
   */
  heldUrls(): string[];
  /** 우리가 연 탭을 닫고 기억을 비운다. 드라이버 자체는 닫지 않는다(부른 쪽 몫). */
  dispose(): Promise<void>;
}

/** 한 호출의 기본 제한 시간. */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** openTabs 한 번에 열 수 있는 최대 개수. */
export const OPEN_TABS_MAX = 10;

/** snapshot() 의 결과. console.log 로 찍으면 바뀐 곳(diff) 글이 나온다(처음이면 전체, 같으면 「변화 없음」, 내린 뒤면 새로 보이는 곳만). */
export interface SnapshotResult {
  /** 이번에 읽은 전체 글(지금 화면, 또는 full 이면 문서 전체). */
  tree: string;
  /** 지난번 읽기와 비교한 글(처음 · 많이 바뀌었으면 전체와 같다). */
  diff: string;
}

/** 페이지 안에서 fetch 를 돌려 결과를 JSON 으로 돌려주는 식(함수 식이라 evaluate 가 인자를 넣어 부른다). */
const IN_PAGE_FETCH = `(arg) => fetch(arg.url, arg.init).then((r) => r.text().then((body) => {
  var headers = {};
  r.headers.forEach((v, k) => { headers[k] = v; });
  return { status: r.status, ok: r.ok, statusText: r.statusText, url: r.url, headers: headers, body: body };
}))`;

const errorText = (e: unknown): string => {
  if (e instanceof SafariError) return e.message;
  if (e instanceof Error) return e.name && e.name !== "Error" ? `${e.name}: ${e.message}` : e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
};

/**
 * Aside 의 repl 처럼 자바스크립트를 돌리는 세션. node:vm 컨텍스트 하나를 세션 내내 쓰므로 최상위 const/let/함수가
 * 다음 호출에도 남고, top-level await 가 된다. 호출은 겹쳐도 차례로 돈다.
 */
export function createReplSession(driver: SafariDriver, opts: { guides?: SiteGuide[]; gate?: ActionGate | null; noPermissionPrompts?: boolean } = {}): ReplSession {
  const guides = opts.guides ?? GUIDES;
  // 동작 관문(없으면 null — 아무것도 묻지 않는다)과 허락 창 없는 모드. 모든 Page 가 같은 것을 쓴다.
  const pageOpts: PageOptions = { gate: opts.gate ?? null, noPermissionPrompts: opts.noPermissionPrompts === true };
  const store = new SnapshotStore();
  const owned = new Set<string>();
  // 호출마다 출력 칸(slot)을 따로 둔다. AsyncLocalStorage 가 칸을 await · 타이머 · 드라이버 호출을 건너 따라가므로,
  // 시간 초과로 끝난 호출의 코드가 나중에 찍어도 닫힌 칸에 찍혀 버려진다(다음 호출 출력에 섞이지 않는다).
  type Slot = { buf: OutputBuffer; closed: boolean; touched: Touch[]; touchedUrls: Set<string>; pauseClock?: () => void; resumeClock?: () => void };
  const slots = new AsyncLocalStorage<Slot>();
  let queue: Promise<unknown> = Promise.resolve();
  let disposed = false;
  // AI 전용 창은 세션에 하나. 번호가 이 값 하나라서, 나중에 이미 있는 창을 AI 창으로 삼는 호출도 이 값만 바꾸면 된다.
  let aiWindowId: number | null = null;
  // AI 창에서 연 탭 키 → 그 탭을 연 창 번호. 창이 닫힌 뒤(새 AI 창이 열린 뒤에도) 그 옛 탭에서 부르면 「AI 창이 아니다」가 아니라
  // 「닫혔다」로 알리려고 남겨 둔다. closeTab 으로 닫은 탭은 뺀다.
  const aiKeys = new Map<string, number>();
  // useWindow 로 고른 작업 창(openTab 의 뒤쪽 탭이 열리는 곳). null 이면 맨 앞 일반 창(기본).
  let workWindowId: number | null = null;

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Number(ms) || 0));
  const log = (...args: unknown[]) => {
    const slot = slots.getStore();
    if (slot && !slot.closed) slot.buf.log(...args);
  };

  const sandbox: Record<string, unknown> = {
    page: null,
    console: { log, info: log, warn: log, error: log, debug: log },
    sleep,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    structuredClone,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
  };
  const ctx = vm.createContext(sandbox, { name: "safari-attraction-repl" });
  // tabs 는 컨텍스트 안에서 만든 배열(Array.isArray · instanceof Array 가 맞도록)이고, 세션 내내 같은 배열을 제자리에서 고친다.
  const tabs = vm.runInContext("[]", ctx) as Page[];
  sandbox.tabs = tabs;

  const currentPage = (): Page | null => (sandbox.page as Page | null) ?? null;
  const needPage = (p: Page | null | undefined, what: string): Page => {
    const pg = p ?? currentPage();
    if (!pg) throw new Error(`${what}: 열린 page 가 없습니다. 먼저 openTab(url) 이나 attachBrowserTab(key) 로 탭을 여세요`);
    return pg;
  };
  // ---- AI 전용 창 ----
  const guideOnlyAi = (what: string) => new Error(`${what}는 AI 전용 창에서만 돼요 — openAiWindow(url) 로 여세요`);
  const noSuchWindow = () => new Error("그런 창이 없어요 — listWindows() 로 확인하세요");
  const windowExists = async (id: number): Promise<boolean> => (await driver.listWindows()).some((w) => w.id === id);

  /** AI 창이 아직 있는가. 목록에 없으면(사용자가 닫음) 상태를 비우고 false. */
  const aiWindowAlive = async (): Promise<boolean> => {
    if (aiWindowId === null) return false;
    const id = aiWindowId;
    if ((await driver.listWindows()).some((w) => w.id === id)) return true;
    if (aiWindowId === id) aiWindowId = null;
    return false;
  };

  const aiAccess: AiWindowAccess = {
    async windowFor(tabKey, what) {
      const former = aiKeys.get(tabKey); // 이 탭이 AI 창에서 열렸다면 그 창 번호
      if (aiWindowId === null) throw former !== undefined ? new SafariError("WINDOW_CLOSED", "AI 전용 창이 이미 닫혔음") : guideOnlyAi(what);
      const id = aiWindowId;
      if (!(await aiWindowAlive())) throw new SafariError("WINDOW_CLOSED", `AI 전용 창(${id}) 이(가) 닫혔음`);
      const t = (await driver.listTabs()).find((x) => x.key === tabKey);
      if (!t) {
        // 옛 AI 창의 탭이었는데 그 창이 없어졌으면 「창이 닫혔다」, 그 밖에는 탭이 없다.
        if (former !== undefined && former !== id && !(await windowExists(former))) throw new SafariError("WINDOW_CLOSED", `AI 전용 창(${former}) 이(가) 닫혔음`);
        throw new SafariError("TAB_CLOSED", `탭 ${tabKey} 이(가) 닫혔음`);
      }
      if (t.windowId !== id) throw guideOnlyAi(what);
      return id;
    },
    closed(windowId) {
      // 그사이 다른 창이 AI 창이 되었으면 그 상태를 지우지 않는다.
      if (aiWindowId === windowId) aiWindowId = null;
    },
    note: (line) => log(line),
    // 호출이 끝났거나 시간 초과로 닫힌 뒤에도 돌고 있는 코드(AsyncLocalStorage 칸이 따라온다)는 기다림 · 재시도를 멈춘다.
    aborted: () => slots.getStore()?.closed === true,
    // 사람이 동작 카드에 답하는 시간은 코드 실행 시간이 아니다 — 관문을 기다리는 동안 이 호출의 시간 제한 시계를 멈춘다.
    gateWait() {
      const slot = slots.getStore();
      if (!slot || slot.closed || !slot.pauseClock) return () => {};
      slot.pauseClock();
      return () => slot.resumeClock?.();
    },
  };

  // 닿은 곳 모으기: 세션이 아는 Page 마다 「마지막으로 기록한 주소」를 둔다. 호출이 시작될 때 지금 주소로 맞춰 두고(닿은 것으로 치지 않는다),
  // 열기 · 붙이기가 끝나면 그 자리에서 기록하고, 호출이 끝날 때(오류 · 시간 초과 포함) 주소가 달라진 Page 를 이동으로 기록한다.
  // last === null 은 열렸지만 아직 기록 못 한 것(기다림이 시간 초과로 끝난 열기 등)이다.
  const watched = new Map<string, { page: Page; last: string | null; how: "open" | "attach" }>();
  const addTouch = (kind: Touch["kind"], url: string, userTab: boolean, given?: Slot): void => {
    const slot = given ?? slots.getStore();
    if (!slot || slot.closed) return; // 시간 초과로 닫힌 호출의 늦은 코드는 버려진다
    if (!url || url === "about:blank" || slot.touchedUrls.has(url)) return;
    slot.touchedUrls.add(url);
    slot.touched.push({ kind, url, userTab });
  };
  const touchOpened = (pg: Page, how: "open" | "attach"): void => {
    const url = pg.url();
    const w = watched.get(pg.key);
    if (w) w.last = url;
    addTouch(how, url, how === "attach" ? !owned.has(pg.key) : false);
  };
  /** 한 Page 의 주소가 마지막으로 기록한 것과 달라졌으면 이동으로 기록한다. */
  const collectOne = (w: { page: Page; last: string | null; how: "open" | "attach" }, slot?: Slot): void => {
    const url = w.page.url();
    if (url === w.last) return;
    const kind: Touch["kind"] = w.last === null ? w.how : "nav";
    w.last = url;
    addTouch(kind, url, !owned.has(w.page.key), slot);
  };
  const collectNavigations = (slot: Slot): void => {
    for (const w of watched.values()) collectOne(w, slot);
  };
  /** 세션이 Page 를 더 이상 지켜보지 않기 전(closeTab 등)에 그 Page 가 옮겨 간 것을 이번 호출 몫으로 거둔다. */
  const untrack = (key: string): void => {
    const w = watched.get(key);
    if (w) collectOne(w);
    watched.delete(key);
  };

  const track = (p: Page, how: "open" | "attach" = "open") => {
    tabs.push(p);
    watched.set(p.key, { page: p, last: null, how });
    sandbox.page = p;
    return p;
  };

  /**
   * 열린 뒤 더 기다릴 불러오기 상태. 드라이버는 문서를 쓸 수 있게 될 때(domcontentloaded)까지만 기다리고 돌려주므로(commit 도 같다 — 새 탭에는 주소 변화로 알 일이 없다),
   * load · networkidle 만 Page 가 이어서 기다린다.
   */
  const extraWait = (opts: { waitUntil?: WaitUntil } | undefined, who: string): "load" | "networkidle" | null => {
    const w = parseWaitUntil(opts?.waitUntil, who, true);
    return w === "load" || w === "networkidle" ? w : null;
  };

  /**
   * 열기의 기다림 시간(timeout, 기본 15초, 최대 110초)을 한 번에 정한다. 드라이버(호스트)에는 이 시간을 그대로 넘기고,
   * 돌아온 뒤 Page 가 남은 시간으로 이어서 기다린다. timeout 을 직접 줬으면 domcontentloaded 도 한 번 확인해 못 쓰면 시간 초과 오류를 낸다
   * (안 줬으면 예전처럼 호스트 기다림이 끝난 대로 돌려준다).
   */
  const openWait = (opts: { timeout?: number } | undefined) => {
    const t0 = Date.now();
    const budget = normTimeout(opts?.timeout, LOAD_TIMEOUT_MS);
    return {
      budget,
      /** 호스트(사파리 쪽)가 기다리는 시간 — 호출 한 번의 120초 안에 끝나도록 100초까지만. */
      hostBudget: Math.min(budget, MAX_HOST_BUDGET_MS),
      finish: async (pg: Page, more: "load" | "networkidle" | null): Promise<void> => {
        const state = more ?? (opts?.timeout !== undefined && opts?.timeout !== null ? "domcontentloaded" : null);
        if (state) await pg[WAIT_LOAD](state, Math.max(1, budget - (Date.now() - t0)), budget);
      },
    };
  };

  // javascript: · data: · file: · blob: 처럼 웹 주소가 아닌 곳을 여는 일은 이동이 아니라 코드 실행 · 파일 열기일 수 있다 — 관문이 있으면 evaluate(알 수 없음)로 묻는다.
  const gateOpenUrl = async (url: unknown): Promise<void> => {
    const gate = opts.gate;
    const u = String(url);
    if (!gate || !isNonWebDestination(u)) return;
    const resume = aiAccess.gateWait?.();
    let answer;
    try {
      answer = await gate.check({ host: hostOf(u), url: "", action: "evaluate", target: clipTarget(u), value: "", irreversible: null });
    } finally {
      resume?.();
    }
    assertAllowed(answer);
  };

  sandbox.openTab = async (url: string, opts: { waitUntil?: WaitUntil; timeout?: number } = {}): Promise<Page> => {
    if (disposed) throw new Error("openTab: 서버가 끝나는 중이라 탭을 열 수 없음");
    const more = extraWait(opts, "openTab"); // 잘못된 값이면 탭을 열기 전에 알린다
    await gateOpenUrl(url);
    const wait = openWait(opts);
    const backToFront = () => {
      log("고른 창이 닫혀서 맨 앞 창으로 돌아갑니다");
      workWindowId = null;
    };
    let target: number | undefined;
    if (workWindowId !== null) {
      if (await windowExists(workWindowId)) target = workWindowId;
      else backToFront();
    }
    let opened;
    try {
      opened = await driver.openTab(String(url), { windowId: target, loadBudgetMs: wait.hostBudget });
    } catch (e) {
      // 창을 확인한 뒤 열기 전에 닫혔다면 맨 앞 창에 다시 연다. 창이 살아 있으면 원래 오류 그대로.
      if (target === undefined || (await windowExists(target))) throw e;
      backToFront();
      opened = await driver.openTab(String(url), { loadBudgetMs: wait.hostBudget });
    }
    const { tab, frontAppChanged } = opened;
    if (frontAppChanged) log("주의: 사파리가 맨 앞으로 나왔어요");
    if (disposed) {
      // 닫는 도중에 열린 탭도 남기지 않는다.
      await driver.closeTab(tab.key).catch(() => {});
      throw new Error("openTab: 서버가 끝나는 중이라 탭을 열 수 없음");
    }
    owned.add(tab.key);
    const pg = track(new Page(driver, tab.key, aiAccess, pageOpts));
    await wait.finish(pg, more);
    touchOpened(pg, "open");
    return pg;
  };

  sandbox.openAiWindow = async (url: string = "about:blank", opts: { width?: number; height?: number; waitUntil?: WaitUntil; timeout?: number } = {}): Promise<Page> => {
    if (disposed) throw new Error("openAiWindow: 서버가 끝나는 중이라 창을 열 수 없음");
    const more = extraWait(opts, "openAiWindow");
    await gateOpenUrl(url);
    const wait = openWait(opts);
    const explicit = opts?.width !== undefined || opts?.height !== undefined;
    const width = opts?.width ?? 1280;
    const height = opts?.height ?? 800;
    for (const [n, v] of [["width", width], ["height", height]] as const) {
      if (!(typeof v === "number" && Number.isFinite(v) && v > 0)) throw new Error(`openAiWindow: ${n} 는 0 보다 큰 숫자여야 합니다`);
    }
    if (aiWindowId !== null && !(await aiWindowAlive())) log("주의: 이전 AI 전용 창이 닫혀 있어서 새로 열었어요");
    let key: string;
    let front: boolean;
    let winId: number;
    if (aiWindowId === null) {
      const r = await driver.openWindow(String(url), { width: Math.round(width), height: Math.round(height), loadBudgetMs: wait.hostBudget });
      if (disposed) {
        await driver.closeWindow(r.windowId).catch(() => {});
        throw new Error("openAiWindow: 서버가 끝나는 중이라 창을 열 수 없음");
      }
      aiWindowId = winId = r.windowId;
      key = r.tab.key;
      front = r.frontAppChanged;
    } else {
      const id = (winId = aiWindowId);
      const r = await driver.openTab(String(url), { windowId: id, loadBudgetMs: wait.hostBudget });
      if (disposed) {
        await driver.closeTab(r.tab.key).catch(() => {});
        throw new Error("openAiWindow: 서버가 끝나는 중이라 창을 열 수 없음");
      }
      key = r.tab.key;
      front = r.frontAppChanged;
      // 크기를 직접 정했으면 창 크기도 맞춘다(탭은 창 크기를 같이 쓴다).
      if (explicit) await aiAccess.windowFor(key, "화면 크기 바꾸기").then((wid) => driver.setWindowSize(wid, Math.round(width), Math.round(height)));
    }
    if (front) log("주의: 사파리가 맨 앞으로 나왔어요");
    owned.add(key);
    aiKeys.set(key, winId);
    const pg = track(new Page(driver, key, aiAccess, pageOpts));
    await wait.finish(pg, more);
    touchOpened(pg, "open");
    return pg;
  };

  sandbox.closeTab = async (p?: Page): Promise<void> => {
    const pg = needPage(p, "closeTab");
    untrack(pg.key); // 닫기 전에 이번 호출에서 옮겨 간 것을 거둔다(닫으면 더 못 본다)
    try {
      // 우리가 연 탭만 닫는다. 사용자 탭은 떼기만 한다.
      if (owned.has(pg.key)) await driver.closeTab(pg.key);
    } catch (e) {
      if (!(e instanceof SafariError && e.code === "TAB_CLOSED")) throw e; // 이미 닫혔으면 정리만 한다
    }
    owned.delete(pg.key);
    aiKeys.delete(pg.key);
    store.forget(pg.key);
    const i = tabs.findIndex((t) => t.key === pg.key);
    if (i >= 0) tabs.splice(i, 1);
    if (currentPage()?.key === pg.key) sandbox.page = tabs.length ? tabs[tabs.length - 1]! : null;
  };

  // ---- 창 고르기 ----
  const windowIdArg = (id: unknown): number => {
    const n = typeof id === "number" ? id : Number.NaN;
    if (!Number.isInteger(n)) throw noSuchWindow();
    return n;
  };

  sandbox.listWindows = async () =>
    (await driver.listWindows()).map((w) => ({
      id: w.id,
      index: w.index,
      title: w.title,
      tabCount: w.tabCount,
      width: w.bounds.width,
      height: w.bounds.height,
      isAiWindow: w.id === aiWindowId,
      isWorkWindow: w.id === workWindowId,
    }));

  sandbox.useWindow = async (id: number | null): Promise<void> => {
    if (id === null) {
      workWindowId = null;
      return;
    }
    const n = windowIdArg(id);
    if (!(await windowExists(n))) throw noSuchWindow();
    workWindowId = n;
  };

  sandbox.useAiWindow = async (id: number): Promise<void> => {
    if (disposed) throw new Error("useAiWindow: 서버가 끝나는 중이라 창을 고를 수 없음");
    const n = windowIdArg(id);
    if (!(await windowExists(n))) throw noSuchWindow();
    // 고른 창은 우리 창이 아니다: 크기 · 찍기는 되지만 끝나도 닫지 않고, 우리가 그 안에 연 탭만 닫는다.
    await driver.adoptWindow(n);
    aiWindowId = n;
  };

  sandbox.listBrowserTabs = (): Promise<TabInfo[]> => driver.listTabs();

  const attach = (key: string): Page => {
    const existing = tabs.find((t) => t.key === key);
    const pg = existing ?? track(new Page(driver, key, aiAccess, pageOpts), "attach");
    sandbox.page = pg;
    touchOpened(pg, "attach");
    return pg;
  };

  sandbox.attachBrowserTab = async (key: string): Promise<Page> => {
    // 목록에서 본 탭 키면 그대로 쓴다(표시는 처음 쓸 때 레지스트리가 적는다).
    const all = await driver.listTabs();
    if (!all.some((t) => t.key === key)) throw new Error(`attachBrowserTab: 탭 ${key} 을(를) 찾을 수 없음(listBrowserTabs() 로 키를 확인하세요)`);
    return attach(key);
  };

  sandbox.attachActiveBrowserTab = async (): Promise<Page> => {
    const windows = await driver.listWindows();
    const front = windows[0]; // 맨 앞 창부터 온다
    if (!front) throw new SafariError("SAFARI_ERROR", "열린 사파리 창이 없음");
    const t = (await driver.listTabs()).find((x) => x.windowId === front.id && x.isActive);
    if (!t) throw new SafariError("SAFARI_ERROR", "맨 앞 창의 활성 탭을 찾을 수 없음");
    return attach(t.key);
  };

  sandbox.snapshot = async (p?: Page, opts: SnapshotOptions = {}): Promise<SnapshotResult> => {
    const pg = needPage(p, "snapshot");
    const o: SnapshotOptions = { interactive: !!opts.interactive, selector: opts.selector, full: !!opts.full };
    const raw = await driver.runJs(pg.key, buildSnapshotSource(o));
    // 읽기만으로는 기억이 바뀌지 않는다. 결과를 찍을 때(console.log) 「읽은 줄」로 올리고, 호출이 끝날 때 실제로
    // 찍힌 출력(16KB 로 잘렸을 수도 있다)에 맞춰 맞춘다. 찍지 않고 .tree 만 쓰면 아무것도 읽은 것으로 치지 않는다.
    const pending = store.read(pg.key, o, raw);
    const tree = splitSnapshotMeta(raw).tree;
    const read = (): string => {
      pending.commit();
      slots.getStore()?.buf.watch(pending); // 호출이 끝날 때 실제로 찍힌 만큼에 맞춰 잘린 줄을 도로 뺀다
      return pending.text;
    };
    // .diff 를 읽는 것은 찍으려는 것으로 본다(console.log(r.diff)). .tree 는 읽어도 아무것도 올리지 않는다.
    const result = { tree } as SnapshotResult;
    Object.defineProperty(result, "diff", { get: read, enumerable: true });
    // console.log(result) 는 바뀐 곳 글을 찍는다.
    Object.defineProperty(result, inspect.custom, { value: read, enumerable: false });
    return result;
  };

  sandbox.fetch = async (url: string, init: Record<string, unknown> = {}) => {
    const pg = needPage(null, "fetch");
    const clean = JSON.parse(JSON.stringify(init ?? {}));
    const h = (init as { headers?: unknown })?.headers;
    if (h && typeof (h as { forEach?: unknown }).forEach === "function") {
      const o: Record<string, string> = {};
      (h as { forEach(f: (v: string, k: string) => void): void }).forEach((v, k) => (o[k] = v));
      clean.headers = o;
    }
    // GET · HEAD 가 아니면 페이지에 요청을 바꾸는 일이라 관문에 한 번 묻는다. 안쪽 evaluate 는 관문을 거치지 않는 길로 부른다(같은 일을 두 번 묻지 않게).
    const method = String(clean.method ?? "GET").trim() || "GET";
    if (fetchIsIrreversible(method)) await pg[GATE_ASK]("fetch", `${method.toUpperCase()} ${String(url)}`, "", true);
    const r = await pg[RAW_EVALUATE]<{ status: number; ok: boolean; statusText: string; url: string; headers: Record<string, string>; body: string }>(IN_PAGE_FETCH, {
      url: String(url),
      init: clean,
    });
    return {
      status: r.status,
      ok: r.ok,
      statusText: r.statusText,
      url: r.url,
      headers: r.headers,
      text: async () => r.body,
      json: async () => {
        try {
          return vm.runInContext("JSON", ctx).parse(r.body);
        } catch (e) {
          throw new Error(`fetch 응답이 JSON 이 아님: ${(e as Error).message}`);
        }
      },
    };
  };

  // guide(주소?) — 내장 사이트 안내서 전체 글. 인자가 없으면 지금 page 주소. 던지지 않는다. guide.list() 는 있는 안내서 목록.
  // 파일을 읽지 않으니 동기 함수다(guide.list() 와 같게 — await 없이 console.log(guide()) 해도 글이 찍힌다).
  const guide = (target?: unknown): string => guideAnswer(target, () => currentPage()?.url(), guides);
  guide.list = (): string => listGuides(guides);
  sandbox.guide = guide;

  sandbox.display = (img: Buffer): void => {
    const slot = slots.getStore();
    if (!Buffer.isBuffer(img) && !ArrayBuffer.isView(img)) throw new Error("display(buf): page.screenshot() 이 돌려준 이미지(Buffer)만 붙일 수 있습니다");
    if (!slot || slot.closed) return; // 시간 초과로 닫힌 호출은 버려진다
    slot.buf.addImage(Buffer.isBuffer(img) ? img : Buffer.from((img as ArrayBufferView).buffer as ArrayBuffer, (img as ArrayBufferView).byteOffset, (img as ArrayBufferView).byteLength));
  };

  async function exec(code: string, timeoutMs: number): Promise<ReplResult> {
    return execWith((slot) => {
      const script = new vm.Script(hoistTopLevel(code), { filename: "repl.js" });
      return slots.run(slot, () => script.runInContext(ctx, { timeout: timeoutMs }) as Promise<unknown>);
    }, timeoutMs);
  }

  /** 호출 하나의 틀: 출력 칸 · 닿은 곳 모으기 · 시간 초과 · 결과 만들기. start 는 칸을 받아 일을 시작하고 그 일의 Promise 를 돌려준다. */
  async function execWith(start: (slot: Slot) => Promise<unknown>, timeoutMs: number): Promise<ReplResult> {
    const slot: Slot = { buf: new OutputBuffer(), closed: false, touched: [], touchedUrls: new Set() };
    for (const w of watched.values()) w.last = w.page.url(); // 이미 열려 있던 탭의 시작 주소(이번 호출에서 닿은 것이 아니다)
    const buf = slot.buf;
    let timer: NodeJS.Timeout | undefined;
    let error: string | undefined;
    let errorCode: SafariErrorCode | undefined;
    try {
      const done = start(slot);
      done.catch(() => {}); // 시간 초과 뒤에 늦게 거부돼도 처리 안 된 거부로 남지 않게
      // 시간 제한 시계는 관문(사람 답) 기다림 동안 멈춘다: 남은 시간을 적어 두고 멈췄다가 다시 이어 센다.
      const timeout = new Promise<never>((_, reject) => {
        let remaining = timeoutMs;
        let startedAt = Date.now();
        let paused = 0;
        const arm = () => {
          startedAt = Date.now();
          timer = setTimeout(() => reject(new Error(`시간 초과: ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않음(코드는 계속 돌 수 있음)`)), Math.max(1, remaining));
        };
        slot.pauseClock = () => {
          if (paused++ > 0) return;
          clearTimeout(timer);
          remaining -= Date.now() - startedAt;
        };
        slot.resumeClock = () => {
          if (paused > 0 && --paused === 0 && !slot.closed) arm();
        };
        arm();
      });
      await Promise.race([done, timeout]);
    } catch (e) {
      if (e instanceof SafariError) errorCode = e.code;
      error = (e as { code?: string })?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" ? `시간 초과: ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않음` : errorText(e);
    } finally {
      clearTimeout(timer);
      collectNavigations(slot); // 오류 · 시간 초과로 끝나도 그때까지 옮겨 간 탭은 닿은 것으로 센다
      slot.closed = true;
    }
    const result: ReplResult = { output: buf.text() };
    if (error !== undefined) result.error = error;
    if (errorCode) result.errorCode = errorCode;
    if (slot.touched.length > 0) result.touched = slot.touched;
    if (buf.images.length > 0) result.images = buf.images.map((b) => b.toString("base64"));
    return result;
  }

  return {
    run(code, opts = {}) {
      const next = queue.then(() => exec(code, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS));
      queue = next.catch(() => {});
      return next;
    },
    openTabs(urls, opts = {}) {
      const list = urls.slice(0, OPEN_TABS_MAX);
      const run = async (): Promise<void> => {
        const openTab = sandbox.openTab as (url: string) => Promise<Page>;
        const slot = slots.getStore();
        const pageBefore = sandbox.page;
        let opened = 0;
        for (const url of list) {
          // 시간 초과로 닫힌 호출은 남은 주소를 더 열지 않는다(열면 기록에도 없는 탭이 남고 page 가 다음 호출 밑에서 바뀐다).
          if (slot?.closed) break;
          try {
            const pg = await openTab(url);
            // 기다리는 사이 시간 초과로 닫혔으면, 그 탭 때문에 바뀐 page 를 도로 돌려 둔다(그사이 다른 호출이 바꿨다면 그대로).
            if (slot?.closed && sandbox.page === pg) sandbox.page = pageBefore;
            opened++;
            log(`열었어요: ${url}`);
          } catch (e) {
            log(`못 열었어요: ${url} — ${errorText(e)}`);
          }
        }
        if (urls.length > list.length) log(`한 번에 ${OPEN_TABS_MAX}개까지만 열어요 — 앞 ${OPEN_TABS_MAX}개만 열고 ${urls.length - list.length}개는 열지 않았어요.`);
        if (opened === 0) throw new Error("열린 탭이 없어요");
      };
      const next = queue.then(() => execWith((slot) => slots.run(slot, run), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS));
      queue = next.catch(() => {});
      return next;
    },
    heldUrls() {
      const urls: string[] = [];
      for (const w of watched.values()) {
        try {
          const u = w.page.url();
          if (u) urls.push(u);
        } catch {
          // 읽을 수 없는 페이지는 건너뛴다.
        }
      }
      return urls;
    },
    handleStray(reason, kind) {
      const slot = slots.getStore();
      if (!slot) return false;
      // 시간 초과로 닫힌 호출에서 난 것이면 출력은 버려진다(서버는 그대로 산다).
      if (!slot.closed) {
        const what = kind === "rejection" ? "기다리지 않은 비동기 작업(await 빠짐)" : "타이머나 콜백";
        slot.buf.log(`주의: ${what}에서 오류가 났어요 — ${errorText(reason)}`);
      }
      return true;
    },
    async dispose() {
      // 돌고 있는 호출을 기다리지 않는다 — 오래 걸리거나 멈춘 호출 때문에 우리 탭이 남지 않도록 탭부터 닫는다.
      disposed = true;
      try {
        await driver.closeOwned();
      } finally {
        owned.clear();
        aiWindowId = null;
        workWindowId = null;
        aiKeys.clear();
        watched.clear();
        tabs.length = 0;
        sandbox.page = null;
      }
    },
  };
}
