import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { captureWindowPng } from "./capture.js";
import { buildGuardedSource, expressionError } from "./guarded-source.js";
import { urlForms } from "./url.js";
import { HostError, HostTimeoutError, JxaHost } from "./jxa-host.js";
import { TabRegistry, type Guarded, type Probe, type RawTab, type RebindResult, type SettleResult, type Spot } from "./tab-registry.js";
import { SafariError, type RunJsDetail, type SafariDriver, type TabInfo, type WindowBounds, type WindowInfo } from "./types.js";

export { SafariError } from "./types.js";
export type { SafariDriver, TabInfo, WindowInfo } from "./types.js";

const execFileP = promisify(execFile);

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const LAUNCH_WAIT_MS = 15_000;
/** 새 창을 찾는 데(최대 10초)와 페이지가 뜨는 데(최대 15초)가 걸린다. */
const OPEN_WINDOW_TIMEOUT_MS = 40_000;
/** 호스트가 페이지를 기다리는 기본 최대 시간(host.js 의 기본값과 같다). */
const DEFAULT_LOAD_BUDGET_MS = 15_000;
/** 호스트가 페이지를 기다리는 시간의 상한(호출 한 번 120초 안에 끝나도록). */
const MAX_LOAD_BUDGET_MS = 100_000;
/** 페이지 기다림 말고 호스트 요청이 더 걸릴 수 있는 여유. */
const LOAD_REQUEST_SLACK_MS = 5_000;
/** 호스트 요청 시간 제한의 상한. */
const MAX_REQUEST_TIMEOUT_MS = 115_000;

/** 호스트가 기다릴 시간을 바로잡는다(상한 100초). 안 주면 undefined. */
const clampBudget = (loadBudgetMs: number | undefined): number | undefined =>
  loadBudgetMs === undefined ? undefined : Math.min(Math.max(1, Math.round(loadBudgetMs)), MAX_LOAD_BUDGET_MS);

/**
 * 페이지 기다림 시간(loadBudgetMs)을 기본(15초)보다 늘렸을 때 호스트 요청 시간 제한(밀리초). 기본이면 base 그대로(undefined 면 호스트 기본값).
 * base 는 그 요청의 원래 제한(안 정했으면 드라이버의 requestTimeoutMs). 늘린 제한도 115초를 넘지 않는다.
 */
export function budgetTimeout(loadBudgetMs: number | undefined, base: number | undefined, requestTimeoutMs: number): number | undefined {
  if (loadBudgetMs === undefined || loadBudgetMs <= DEFAULT_LOAD_BUDGET_MS) return base;
  return Math.min((base ?? requestTimeoutMs) + (loadBudgetMs - DEFAULT_LOAD_BUDGET_MS) + LOAD_REQUEST_SLACK_MS, MAX_REQUEST_TIMEOUT_MS);
}

export const SAFARI_BUNDLE_ID = "com.apple.Safari";

/** `lsappinfo info -only bundleid` 출력에서 번들 아이디를 뽑는다(`bundleID="…"` 또는 `"CFBundleIdentifier"="…"`). 없으면 빈 글. */
export function parseBundleId(out: string): string {
  return /(?:bundleID|CFBundleIdentifier)"?\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? "";
}

/** 사파리가 맨 앞으로 나왔는가: 뒤에 맨 앞 앱이 사파리이고, 앞에는 사파리가 아니었을 때만. 다른 앱이 앞으로 나온 것(화면 잠금 해제 등)은 아니다. */
export function safariCameForward(beforeBundleId: string, afterBundleId: string): boolean {
  return afterBundleId === SAFARI_BUNDLE_ID && beforeBundleId !== SAFARI_BUNDLE_ID;
}

/** 맨 앞 앱의 번들 아이디(`lsappinfo front` → `lsappinfo info -only bundleid`). 알 수 없으면 빈 글. */
async function frontBundleId(): Promise<string> {
  try {
    const asn = (await execFileP("lsappinfo", ["front"])).stdout.trim();
    if (!asn) return "";
    const { stdout } = await execFileP("lsappinfo", ["info", "-only", "bundleid", asn]);
    return parseBundleId(stdout);
  } catch {
    return "";
  }
}

/** 페이지에서 소스를 돌리는 호스트 op(느린 길 runJs · 빠른 길 runJsFast)는 오류를 같게 가른다. */
const isRunJs = (op: string): boolean => op === "runJs" || op === "runJsFast";

/** 사파리 오류 문구(로케일에 따라 영어 · 한국어)와 오류 번호로 SafariError 코드를 정한다. */
export function opError(op: string, e: unknown): SafariError {
  if (e instanceof SafariError) return e;
  if (e instanceof HostTimeoutError) {
    return isRunJs(op)
      ? new SafariError("ALERT_BLOCKED", "사파리가 답하지 않음 — 그 탭에 경고창이 떠 있을 수 있음(호스트를 다시 띄움)")
      : new SafariError("TIMEOUT", `${e.message} (호스트를 다시 띄움)`);
  }
  if (e instanceof HostError) {
    const msg = e.message;
    if (e.code === "SAFARI_NOT_RUNNING") return new SafariError("SAFARI_NOT_RUNNING", msg);
    if (e.number === -1743 || /-1743/.test(msg)) return new SafariError("AUTOMATION_DENIED", msg);
    if (/Apple Events|Apple 이벤트/i.test(msg) && /JavaScript/i.test(msg)) return new SafariError("JS_FROM_APPLE_EVENTS_OFF", msg);
    if ((isRunJs(op) || op === "closeTab") && (e.number === -1728 || /Can't get|Invalid index|가져올 수 없/i.test(msg))) {
      return new SafariError("TAB_CLOSED", msg);
    }
    return new SafariError("SAFARI_ERROR", msg);
  }
  return new SafariError("SAFARI_ERROR", e instanceof Error ? e.message : String(e));
}

/** 드라이버가 호스트에 바라는 것(시험에서는 가짜로 바꿔 끼운다). */
export type HostLike = Pick<JxaHost, "call" | "close">;

export function createJxaDriver(opts: { requestTimeoutMs?: number; host?: HostLike } = {}): SafariDriver {
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const host: HostLike = opts.host ?? new JxaHost(requestTimeoutMs);
  const withBudget = (loadBudgetMs: number | undefined, base?: number) => budgetTimeout(clampBudget(loadBudgetMs), base, requestTimeoutMs);

  async function call<T>(op: string, args: object = {}, timeoutMs?: number): Promise<T> {
    try {
      return (await host.call(op, args, timeoutMs)) as T;
    } catch (e) {
      throw opError(op, e);
    }
  }

  // urls · urlForms: 같은 주소의 여러 꼴(기록한 그대로 · 정규화) — 호스트가 tab.url() 과 견줄 때 후보로 쓴다(urlForms 는 altUrl 을 뺀 것).
  const guardArgs = (s: Spot) => ({
    windowId: s.windowId,
    index: s.index,
    key: s.key,
    url: s.url,
    unstamped: s.unstamped,
    altUrl: s.altUrl,
    urls: urlForms([s.url, s.altUrl]),
    urlForms: urlForms([s.url]),
  });
  const guardSpec = (s: Spot) => ({ key: s.key, unstamped: s.unstamped, url: s.url, altUrl: s.altUrl });

  // 탭 키(t1, t2 …)와 사파리 안 자리를 이어 주는 기록. 사용자가 탭을 옮겨도 같은 키가 같은 탭을 가리킨다.
  const registry = new TabRegistry({
    list: () => call<RawTab[]>("listTabs"),
    probe: (windowId, index, timeoutMs) => call<Probe>("probe", { windowId, index }, timeoutMs),
    stamp: (windowId, index, key) => call<boolean>("stamp", { windowId, index, key }),
    rebind: (a) => call<RebindResult>("rebind", a),
    settle: (a) => call<SettleResult>("settle", { ...a, loadBudgetMs: clampBudget(a.loadBudgetMs) }, withBudget(a.loadBudgetMs)),
    close: (spot, urlOnly, timeoutMs) => call<Guarded<null>>("closeTab", { ...guardArgs(spot), urlOnly }, timeoutMs),
  });

  // 우리가 openWindow 로 연 창(창 번호). 이 안의 창만 setWindowSize · closeWindow 가 만진다.
  const ownedWindows = new Set<number>();

  // 사용자가 AI 전용 창으로 고른 창(adoptWindow). showTab · setWindowSize 는 쓸 수 있지만 닫지는 않는다.
  const adoptedWindows = new Set<number>();

  type WindowState = { gone: true } | { gone: false; bounds: WindowBounds; inner: { innerWidth: number; innerHeight: number } | null };

  const windowClosed = (id: number) => new SafariError("WINDOW_CLOSED", `창 ${id} 이(가) 이미 닫혔음`);
  function requireOwnedWindow(id: number, what: string): void {
    if (!ownedWindows.has(id)) throw new SafariError("SAFARI_ERROR", `Claude 가 연 창만 ${what}`);
  }

  function requireUsableWindow(id: number, what: string): void {
    if (!ownedWindows.has(id) && !adoptedWindows.has(id)) throw new SafariError("SAFARI_ERROR", `Claude 가 연 창이나 AI 전용 창으로 고른 창만 ${what}`);
  }

  const toTab = (e: { raw: RawTab; key: string; owned: boolean }): TabInfo => ({ ...e.raw, key: e.key, owned: e.owned });

  async function launchSafari(): Promise<void> {
    await execFileP("open", ["-g", "-a", "Safari"]);
    const t0 = Date.now();
    while (Date.now() - t0 < LAUNCH_WAIT_MS) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        await call("listWindows");
        return;
      } catch (e) {
        if (!(e instanceof SafariError && e.code === "SAFARI_NOT_RUNNING")) throw e;
      }
    }
    throw new SafariError("SAFARI_NOT_RUNNING", "사파리를 켰지만 뜨지 않음");
  }

  /** 창 바깥 크기 · 페이지 크기. measure=false 면 페이지 크기는 재지 않는다. */
  async function windowState(windowId: number, measure = true): Promise<WindowState> {
    return call<WindowState>("windowState", { windowId, measure });
  }

  function liveState(windowId: number, s: WindowState): Extract<WindowState, { gone: false }> {
    if (s.gone) throw windowClosed(windowId);
    return s;
  }

  /**
   * 페이지 크기(innerWidth · innerHeight)를 요청과 같게 만든다. 지금 창 바깥 크기와 페이지 크기의 차이(테두리 · 도구 막대)를
   * 한 번 재서 바깥 크기를 맞추고, 그래도 어긋나면 남은 차이만큼 한 번 고친다. 최소 폭 · 화면 크기에 막히면 실제 값을 돌려준다.
   */
  async function resizeTo(windowId: number, width: number, height: number): Promise<{ innerWidth: number; innerHeight: number }> {
    const cur = liveState(windowId, await windowState(windowId));
    if (!cur.inner) throw new SafariError("SAFARI_ERROR", "창 안 페이지 크기를 잴 수 없음(이 페이지에서는 자바스크립트를 돌릴 수 없음)");
    const chromeW = cur.bounds.width - cur.inner.innerWidth;
    const chromeH = cur.bounds.height - cur.inner.innerHeight;
    let r = liveState(windowId, await call<WindowState>("setBounds", { windowId, width: width + chromeW, height: height + chromeH }));
    if (r.inner && (r.inner.innerWidth !== width || r.inner.innerHeight !== height)) {
      const dw = width - r.inner.innerWidth;
      const dh = height - r.inner.innerHeight;
      r = liveState(windowId, await call<WindowState>("setBounds", { windowId, width: r.bounds.width + dw, height: r.bounds.height + dh }));
    }
    if (!r.inner) throw new SafariError("SAFARI_ERROR", "창 안 페이지 크기를 잴 수 없음");
    return r.inner;
  }

  /** 지금 사파리의 창 번호 전부. 사파리가 꺼져 있으면 켜 보고 읽는다. */
  async function windowIdsNow(): Promise<number[]> {
    try {
      return await call<number[]>("windowIds");
    } catch (e) {
      if (!(e instanceof SafariError && e.code === "SAFARI_NOT_RUNNING")) throw e;
      await launchSafari();
      return call<number[]>("windowIds");
    }
  }

  /**
   * openWindow 가 시간을 넘겼다(호스트는 죽었다). 만들기 전에 없던 창 가운데 우리 표시가 있는 것을 닫는다.
   * 표시를 확인하지 못한 새 창이 있거나 치우지 못하면, 창이 남았을 수 있다고 오류에 덧붙인다.
   */
  async function cleanupAfterTimeout(err: SafariError, beforeIds: number[], key: string): Promise<SafariError> {
    let leftover = true;
    try {
      const r = await call<{ closed: number; unconfirmed: number }>("closeStamped", { beforeIds, key });
      leftover = r.unconfirmed > 0;
    } catch {
      leftover = true;
    }
    return leftover ? new SafariError(err.code, `${err.message} — 새 창이 남았을 수 있음(사파리 창을 확인)`) : err;
  }

  async function closeWindow(windowId: number): Promise<void> {
    requireOwnedWindow(windowId, "닫아요");
    const r = await call<{ gone: boolean; closed?: boolean }>("closeWindow", { windowId });
    if (!r.gone && r.closed === false) throw new SafariError("SAFARI_ERROR", `창 ${windowId} 이(가) 닫히지 않음`); // 우리 창으로 남겨 둔다
    ownedWindows.delete(windowId);
    registry.forgetWindow(windowId);
    if (r.gone) throw windowClosed(windowId);
  }

  async function runJsDetailed(tabKey: string, source: string, o: { timeoutMs?: number } = {}): Promise<RunJsDetail> {
    // 소스는 식 하나여야 한다(탭 확인과 함께 한 스크립트에 `(소스)` 로 끼운다). 문장이면 사파리가 조용히 빈 값을 돌려주므로 미리 오류로 알린다.
    const bad = expressionError(source);
    if (bad !== null) throw new SafariError("SAFARI_ERROR", `runJs 소스는 식 하나여야 합니다(문장 · 선언은 즉시 실행 함수로 감싸세요): ${bad}`);
    const r = await registry.withTabDetail(tabKey, async (s) => {
      // 빠른 길: 탭 확인 · 표시 · 일이 doJavaScript 한 번. 자리를 못 읽었거나 표시가 안 맞으면 호스트가 {fallback}, 느린 길(runJs)이 예전처럼 확인한다.
      const fast = await call<Guarded<string> | { fallback: true }>("runJsFast", { ...guardArgs(s), script: buildGuardedSource(guardSpec(s), source) }, o.timeoutMs);
      if (!("fallback" in fast)) return fast;
      return call<Guarded<string>>("runJs", { ...guardArgs(s), source }, o.timeoutMs); // 느린 길은 떠나는 중인지 모른다(leaving 없음)
    });
    return { value: r.value, url: r.url, urlBefore: r.urlBefore, leaving: r.leaving, owned: r.owned };
  }

  return {
    async listWindows() {
      const raw = await call<Omit<WindowInfo, "owned">[]>("listWindows");
      return raw.filter((w) => w.visible).map((w) => ({ ...w, owned: ownedWindows.has(w.id) }));
    },

    async listTabs() {
      const raw = await call<RawTab[]>("listTabs");
      return (await registry.sync(raw)).map(toTab);
    },

    async openTab(url, o = {}) {
      const before = await frontBundleId();
      const key = registry.nextKey();
      const args = { url, windowId: o.windowId, key: registry.markerOf(key), loadBudgetMs: clampBudget(o.loadBudgetMs) }; // 페이지에는 서버마다 다른 표시를 적는다
      let raw: RawTab & { stamped: boolean };
      try {
        raw = await call("openTab", args, withBudget(o.loadBudgetMs));
      } catch (e) {
        if (!(e instanceof SafariError && e.code === "SAFARI_NOT_RUNNING")) throw e;
        await launchSafari();
        raw = await call("openTab", args, withBudget(o.loadBudgetMs));
      }
      registry.register(key, raw.windowId, raw.index, raw.url, { owned: true, stamped: raw.stamped });
      const { stamped: _stamped, ...rest } = raw;
      const tab = toTab({ raw: rest, key, owned: true });
      const after = await frontBundleId();
      return { tab, frontAppChanged: safariCameForward(before, after) };
    },

    async openWindow(url, o = {}) {
      const before = await frontBundleId();
      const key = registry.nextKey();
      const args = { url, key: registry.markerOf(key), loadBudgetMs: clampBudget(o.loadBudgetMs) };
      type Opened = { windowId: number; tab: RawTab; stamped: boolean };
      const idsBefore = await windowIdsNow(); // 시간을 넘겨 호스트가 죽어도 새 창을 알아보는 기준
      let raw: Opened;
      try {
        raw = await call<Opened>("openWindow", args, withBudget(o.loadBudgetMs, OPEN_WINDOW_TIMEOUT_MS));
      } catch (e) {
        if (e instanceof SafariError && e.code === "TIMEOUT") throw await cleanupAfterTimeout(e, idsBefore, args.key);
        throw e;
      }
      ownedWindows.add(raw.windowId);
      registry.register(key, raw.windowId, raw.tab.index, raw.tab.url, { owned: true, stamped: raw.stamped });
      if (o.width !== undefined || o.height !== undefined) {
        try {
          const cur = liveState(raw.windowId, await windowState(raw.windowId));
          await resizeTo(raw.windowId, o.width ?? cur.inner?.innerWidth ?? 0, o.height ?? cur.inner?.innerHeight ?? 0);
        } catch (e) {
          await closeWindow(raw.windowId).catch(() => undefined); // 크기를 못 맞추면 연 창을 치우고 알린다
          throw e;
        }
      }
      const after = await frontBundleId();
      return { windowId: raw.windowId, tab: toTab({ raw: raw.tab, key, owned: true }), frontAppChanged: safariCameForward(before, after) };
    },

    async setWindowSize(windowId, width, height) {
      requireUsableWindow(windowId, "크기를 바꿔요");
      return resizeTo(windowId, width, height);
    },

    closeWindow,

    async adoptWindow(windowId) {
      if ((await windowState(windowId, false)).gone) throw windowClosed(windowId);
      if (!ownedWindows.has(windowId)) adoptedWindows.add(windowId);
    },

    async captureWindow(windowId) {
      if ((await windowState(windowId, false)).gone) throw windowClosed(windowId);
      return captureWindowPng(windowId);
    },

    async showTab(tabKey) {
      await registry.withTab(tabKey, async (s) => {
        // 사용자 창의 현재 탭은 바꾸지 않는다. 우리가 연 창과 사용자가 AI 전용 창으로 고른 창 안에서만.
        if (!ownedWindows.has(s.windowId) && !adoptedWindows.has(s.windowId)) throw new SafariError("SAFARI_ERROR", "Claude 가 연 창(또는 AI 전용 창으로 고른 창) 안의 탭만 앞에 보여요");
        // 확인을 doJavaScript 한 번으로(빠른 길). 안 되면 호스트가 예전 확인으로 돌아간다.
        return call<Guarded<null>>("showTab", { ...guardArgs(s), script: buildGuardedSource(guardSpec(s), "null") });
      });
    },

    async screenCaptureAllowed() {
      return (await call<boolean>("screenAccess")) === true;
    },

    runJs: async (tabKey, source, o = {}) => (await runJsDetailed(tabKey, source, o)).value,

    runJsDetailed,

    lastUrl: (tabKey) => registry.urlOf(tabKey),

    closeTab: (tabKey) => registry.closeTab(tabKey),

    async rebindTab(tabKey) {
      const raw = await registry.rebind(tabKey);
      return toTab({ raw, key: tabKey, owned: registry.isOwned(tabKey) });
    },

    async settleTab(tabKey, o = {}) {
      const r = await registry.settle(tabKey, o);
      return { navigated: r.navigated, leaving: r.leaving, tab: toTab({ raw: r.tab, key: tabKey, owned: registry.isOwned(tabKey) }) };
    },

    async noteNavTimeout(tabKey) {
      await registry.navTimedOut(tabKey);
    },

    async closeOwned() {
      // 우리 창부터(그 안의 탭도 함께 닫힌다), 남은 우리 탭을 닫는다. 창 안의 탭은 따로 세지 않는다.
      let closed = 0;
      let firstError: unknown;
      for (const id of [...ownedWindows]) {
        try {
          await closeWindow(id);
          closed++;
        } catch (err) {
          if (err instanceof SafariError && err.code === "WINDOW_CLOSED") continue; // 이미 없다
          firstError ??= err;
        }
      }
      try {
        closed += await registry.closeOwned();
      } catch (err) {
        firstError ??= err;
      }
      adoptedWindows.clear(); // 고른 창은 닫지 않고 그저 놓아 준다
      if (firstError) throw firstError;
      return closed;
    },

    close: () => host.close(),
  };
}
