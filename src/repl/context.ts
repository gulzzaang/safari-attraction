import { AsyncLocalStorage } from "node:async_hooks";
import vm from "node:vm";
import { inspect } from "node:util";
import { SafariError, type SafariDriver, type SafariErrorCode, type TabInfo } from "../driver/types.js";
import { buildSnapshotSource, type SnapshotOptions } from "../snapshot/inpage.js";
import { SnapshotStore } from "../snapshot/store.js";
import { Page } from "./page.js";
import { OutputBuffer } from "./output.js";
import { hoistTopLevel } from "./transform.js";

export interface ReplSession {
  run(code: string, opts?: { timeoutMs?: number }): Promise<{ output: string; error?: string; errorCode?: SafariErrorCode }>;
  /** 우리가 연 탭을 닫고 기억을 비운다. 드라이버 자체는 닫지 않는다(부른 쪽 몫). */
  dispose(): Promise<void>;
}

/** 한 호출의 기본 제한 시간. */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** snapshot() 의 결과. console.log 로 찍으면 바뀐 곳(diff) 글이 나온다(처음이면 전체, 같으면 「변화 없음」). */
export interface SnapshotResult {
  /** 이번에 읽은 전체 글. */
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
export function createReplSession(driver: SafariDriver): ReplSession {
  const store = new SnapshotStore();
  const owned = new Set<string>();
  // 호출마다 출력 칸(slot)을 따로 둔다. AsyncLocalStorage 가 칸을 await · 타이머 · 드라이버 호출을 건너 따라가므로,
  // 시간 초과로 끝난 호출의 코드가 나중에 찍어도 닫힌 칸에 찍혀 버려진다(다음 호출 출력에 섞이지 않는다).
  type Slot = { buf: OutputBuffer; closed: boolean };
  const slots = new AsyncLocalStorage<Slot>();
  let queue: Promise<unknown> = Promise.resolve();

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
  const track = (p: Page) => {
    tabs.push(p);
    sandbox.page = p;
    return p;
  };

  sandbox.openTab = async (url: string): Promise<Page> => {
    const { tab } = await driver.openTab(String(url));
    owned.add(tab.key);
    return track(new Page(driver, tab.key));
  };

  sandbox.closeTab = async (p?: Page): Promise<void> => {
    const pg = needPage(p, "closeTab");
    try {
      // 우리가 연 탭만 닫는다. 사용자 탭은 떼기만 한다.
      if (owned.has(pg.key)) await driver.closeTab(pg.key);
    } catch (e) {
      if (!(e instanceof SafariError && e.code === "TAB_CLOSED")) throw e; // 이미 닫혔으면 정리만 한다
    }
    owned.delete(pg.key);
    store.forget(pg.key);
    const i = tabs.findIndex((t) => t.key === pg.key);
    if (i >= 0) tabs.splice(i, 1);
    if (currentPage()?.key === pg.key) sandbox.page = tabs.length ? tabs[tabs.length - 1]! : null;
  };

  sandbox.listBrowserTabs = (): Promise<TabInfo[]> => driver.listTabs();

  const attach = (key: string): Page => {
    const existing = tabs.find((t) => t.key === key);
    const pg = existing ?? track(new Page(driver, key));
    sandbox.page = pg;
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
    const tree = await driver.runJs(pg.key, buildSnapshotSource(o));
    const d = store.diff(pg.key, o, tree);
    const result: SnapshotResult = { tree, diff: d.text };
    // console.log(result) 는 바뀐 곳 글을 찍는다.
    Object.defineProperty(result, inspect.custom, { value: () => d.text, enumerable: false });
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
    const r = await pg.evaluate<{ status: number; ok: boolean; statusText: string; url: string; headers: Record<string, string>; body: string }>(IN_PAGE_FETCH, {
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

  sandbox.display = () => {
    throw new Error("화면 찍기는 AI 전용 창 방식(계획 2)에서 됩니다");
  };

  async function exec(code: string, timeoutMs: number): Promise<{ output: string; error?: string; errorCode?: SafariErrorCode }> {
    const slot: Slot = { buf: new OutputBuffer(), closed: false };
    const buf = slot.buf;
    let timer: NodeJS.Timeout | undefined;
    let error: string | undefined;
    let errorCode: SafariErrorCode | undefined;
    try {
      const script = new vm.Script(hoistTopLevel(code), { filename: "repl.js" });
      const done = slots.run(slot, () => script.runInContext(ctx, { timeout: timeoutMs }) as Promise<unknown>);
      done.catch(() => {}); // 시간 초과 뒤에 늦게 거부돼도 처리 안 된 거부로 남지 않게
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`시간 초과: ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않음(코드는 계속 돌 수 있음)`)), timeoutMs);
      });
      await Promise.race([done, timeout]);
    } catch (e) {
      if (e instanceof SafariError) errorCode = e.code;
      error = (e as { code?: string })?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" ? `시간 초과: ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않음` : errorText(e);
    } finally {
      clearTimeout(timer);
      slot.closed = true;
    }
    if (error === undefined) return { output: buf.text() };
    return errorCode ? { output: buf.text(), error, errorCode } : { output: buf.text(), error };
  }

  return {
    run(code, opts = {}) {
      const next = queue.then(() => exec(code, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS));
      queue = next.catch(() => {});
      return next;
    },
    async dispose() {
      await queue.catch(() => {});
      owned.clear();
      tabs.length = 0;
      sandbox.page = null;
      await driver.closeOwned();
    },
  };
}
