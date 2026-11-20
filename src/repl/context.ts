import { AsyncLocalStorage } from "node:async_hooks";
import vm from "node:vm";
import { inspect } from "node:util";
import { SafariError, type SafariDriver, type SafariErrorCode, type TabInfo } from "../driver/types.js";
import { buildSnapshotSource, type SnapshotOptions } from "../snapshot/inpage.js";
import { SnapshotStore, splitSnapshotMeta } from "../snapshot/store.js";
import { Page, type AiWindowAccess } from "./page.js";
import { OutputBuffer } from "./output.js";
import { hoistTopLevel } from "./transform.js";

/** 한 호출의 결과. images 는 display() 로 붙인 PNG(base64)이고 없으면 빠진다. */
export interface ReplResult {
  output: string;
  error?: string;
  errorCode?: SafariErrorCode;
  images?: string[];
}

export interface ReplSession {
  run(code: string, opts?: { timeoutMs?: number }): Promise<ReplResult>;
  /**
   * 기다리지 않은 거부(Promise.reject · 늦게 던진 오류)나 타이머 · 콜백에서 난 오류가 프로세스 바깥까지 올라왔을 때 부른다.
   * 그 일이 REPL 호출 코드에서 비롯됐으면(AsyncLocalStorage 칸이 따라옴) 살아 있는 호출의 출력에 한국어 한 줄을 남기고 true 를 돌려준다.
   * 서버 자신의 문제거나 어느 호출 것인지 모르면 false.
   */
  handleStray(reason: unknown, kind: "rejection" | "exception"): boolean;
  /** 우리가 연 탭을 닫고 기억을 비운다. 드라이버 자체는 닫지 않는다(부른 쪽 몫). */
  dispose(): Promise<void>;
}

/** 한 호출의 기본 제한 시간. */
export const DEFAULT_TIMEOUT_MS = 120_000;

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
export function createReplSession(driver: SafariDriver): ReplSession {
  const store = new SnapshotStore();
  const owned = new Set<string>();
  // 호출마다 출력 칸(slot)을 따로 둔다. AsyncLocalStorage 가 칸을 await · 타이머 · 드라이버 호출을 건너 따라가므로,
  // 시간 초과로 끝난 호출의 코드가 나중에 찍어도 닫힌 칸에 찍혀 버려진다(다음 호출 출력에 섞이지 않는다).
  type Slot = { buf: OutputBuffer; closed: boolean };
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
  };

  const track = (p: Page) => {
    tabs.push(p);
    sandbox.page = p;
    return p;
  };

  sandbox.openTab = async (url: string): Promise<Page> => {
    if (disposed) throw new Error("openTab: 서버가 끝나는 중이라 탭을 열 수 없음");
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
      opened = await driver.openTab(String(url), target === undefined ? undefined : { windowId: target });
    } catch (e) {
      // 창을 확인한 뒤 열기 전에 닫혔다면 맨 앞 창에 다시 연다. 창이 살아 있으면 원래 오류 그대로.
      if (target === undefined || (await windowExists(target))) throw e;
      backToFront();
      opened = await driver.openTab(String(url));
    }
    const { tab, frontAppChanged } = opened;
    if (frontAppChanged) log("주의: 사파리가 맨 앞으로 나왔어요");
    if (disposed) {
      // 닫는 도중에 열린 탭도 남기지 않는다.
      await driver.closeTab(tab.key).catch(() => {});
      throw new Error("openTab: 서버가 끝나는 중이라 탭을 열 수 없음");
    }
    owned.add(tab.key);
    return track(new Page(driver, tab.key, aiAccess));
  };

  sandbox.openAiWindow = async (url: string = "about:blank", opts: { width?: number; height?: number } = {}): Promise<Page> => {
    if (disposed) throw new Error("openAiWindow: 서버가 끝나는 중이라 창을 열 수 없음");
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
      const r = await driver.openWindow(String(url), { width: Math.round(width), height: Math.round(height) });
      if (disposed) {
        await driver.closeWindow(r.windowId).catch(() => {});
        throw new Error("openAiWindow: 서버가 끝나는 중이라 창을 열 수 없음");
      }
      aiWindowId = winId = r.windowId;
      key = r.tab.key;
      front = r.frontAppChanged;
    } else {
      const id = (winId = aiWindowId);
      const r = await driver.openTab(String(url), { windowId: id });
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
    return track(new Page(driver, key, aiAccess));
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
    const pg = existing ?? track(new Page(driver, key, aiAccess));
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

  sandbox.display = (img: Buffer): void => {
    const slot = slots.getStore();
    if (!Buffer.isBuffer(img) && !ArrayBuffer.isView(img)) throw new Error("display(buf): page.screenshot() 이 돌려준 이미지(Buffer)만 붙일 수 있습니다");
    if (!slot || slot.closed) return; // 시간 초과로 닫힌 호출은 버려진다
    slot.buf.addImage(Buffer.isBuffer(img) ? img : Buffer.from((img as ArrayBufferView).buffer as ArrayBuffer, (img as ArrayBufferView).byteOffset, (img as ArrayBufferView).byteLength));
  };

  async function exec(code: string, timeoutMs: number): Promise<ReplResult> {
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
    const result: ReplResult = { output: buf.text() };
    if (error !== undefined) result.error = error;
    if (errorCode) result.errorCode = errorCode;
    if (buf.images.length > 0) result.images = buf.images.map((b) => b.toString("base64"));
    return result;
  }

  return {
    run(code, opts = {}) {
      const next = queue.then(() => exec(code, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS));
      queue = next.catch(() => {});
      return next;
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
        tabs.length = 0;
        sandbox.page = null;
      }
    },
  };
}
