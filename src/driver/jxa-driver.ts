import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { captureWindowPng } from "./capture.js";
import { HostError, HostTimeoutError, JxaHost } from "./jxa-host.js";
import { TabRegistry, type Guarded, type Probe, type RawTab, type RebindResult, type SettleResult, type Spot } from "./tab-registry.js";
import { SafariError, type SafariDriver, type TabInfo, type WindowBounds, type WindowInfo } from "./types.js";

export { SafariError } from "./types.js";
export type { SafariDriver, TabInfo, WindowInfo } from "./types.js";

const execFileP = promisify(execFile);

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const LAUNCH_WAIT_MS = 15_000;
/** 새 창을 찾는 데(최대 10초)와 페이지가 뜨는 데(최대 15초)가 걸린다. */
const OPEN_WINDOW_TIMEOUT_MS = 40_000;

/** 맨 앞 앱을 가리키는 값(`lsappinfo front`). 앱이 바뀌면 값이 바뀐다. */
async function frontAsn(): Promise<string> {
  try {
    const { stdout } = await execFileP("lsappinfo", ["front"]);
    return stdout.trim();
  } catch {
    return "";
  }
}

/** 사파리 오류 문구(로케일에 따라 영어 · 한국어)와 오류 번호로 SafariError 코드를 정한다. */
export function opError(op: string, e: unknown): SafariError {
  if (e instanceof SafariError) return e;
  if (e instanceof HostTimeoutError) {
    return op === "runJs"
      ? new SafariError("ALERT_BLOCKED", "사파리가 답하지 않음 — 그 탭에 경고창이 떠 있을 수 있음(호스트를 다시 띄움)")
      : new SafariError("TIMEOUT", `${e.message} (호스트를 다시 띄움)`);
  }
  if (e instanceof HostError) {
    const msg = e.message;
    if (e.code === "SAFARI_NOT_RUNNING") return new SafariError("SAFARI_NOT_RUNNING", msg);
    if (e.number === -1743 || /-1743/.test(msg)) return new SafariError("AUTOMATION_DENIED", msg);
    if (/Apple Events|Apple 이벤트/i.test(msg) && /JavaScript/i.test(msg)) return new SafariError("JS_FROM_APPLE_EVENTS_OFF", msg);
    if ((op === "runJs" || op === "closeTab") && (e.number === -1728 || /Can't get|Invalid index|가져올 수 없/i.test(msg))) {
      return new SafariError("TAB_CLOSED", msg);
    }
    return new SafariError("SAFARI_ERROR", msg);
  }
  return new SafariError("SAFARI_ERROR", e instanceof Error ? e.message : String(e));
}

/** 드라이버가 호스트에 바라는 것(시험에서는 가짜로 바꿔 끼운다). */
export type HostLike = Pick<JxaHost, "call" | "close">;

export function createJxaDriver(opts: { requestTimeoutMs?: number; host?: HostLike } = {}): SafariDriver {
  const host: HostLike = opts.host ?? new JxaHost(opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

  async function call<T>(op: string, args: object = {}, timeoutMs?: number): Promise<T> {
    try {
      return (await host.call(op, args, timeoutMs)) as T;
    } catch (e) {
      throw opError(op, e);
    }
  }

  const guardArgs = (s: Spot) => ({ windowId: s.windowId, index: s.index, key: s.key, url: s.url, unstamped: s.unstamped });

  // 탭 키(t1, t2 …)와 사파리 안 자리를 이어 주는 기록. 사용자가 탭을 옮겨도 같은 키가 같은 탭을 가리킨다.
  const registry = new TabRegistry({
    list: () => call<RawTab[]>("listTabs"),
    probe: (windowId, index, timeoutMs) => call<Probe>("probe", { windowId, index }, timeoutMs),
    stamp: (windowId, index, key) => call<boolean>("stamp", { windowId, index, key }),
    rebind: (a) => call<RebindResult>("rebind", a),
    settle: (a) => call<SettleResult>("settle", a),
    close: (spot, urlOnly, timeoutMs) => call<Guarded<null>>("closeTab", { ...guardArgs(spot), urlOnly }, timeoutMs),
  });

  // 우리가 openWindow 로 연 창(창 번호). 이 안의 창만 setWindowSize · closeWindow 가 만진다.
  const ownedWindows = new Set<number>();

  type WindowState = { gone: true } | { gone: false; bounds: WindowBounds; inner: { innerWidth: number; innerHeight: number } | null };

  const windowClosed = (id: number) => new SafariError("WINDOW_CLOSED", `창 ${id} 이(가) 이미 닫혔음`);
  function requireOwnedWindow(id: number, what: string): void {
    if (!ownedWindows.has(id)) throw new SafariError("SAFARI_ERROR", `Claude 가 연 창만 ${what}`);
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
      const before = await frontAsn();
      const key = registry.nextKey();
      const args = { url, windowId: o.windowId, key: registry.markerOf(key) }; // 페이지에는 서버마다 다른 표시를 적는다
      let raw: RawTab & { stamped: boolean };
      try {
        raw = await call("openTab", args);
      } catch (e) {
        if (!(e instanceof SafariError && e.code === "SAFARI_NOT_RUNNING")) throw e;
        await launchSafari();
        raw = await call("openTab", args);
      }
      registry.register(key, raw.windowId, raw.index, raw.url, { owned: true, stamped: raw.stamped });
      const { stamped: _stamped, ...rest } = raw;
      const tab = toTab({ raw: rest, key, owned: true });
      const after = await frontAsn();
      return { tab, frontAppChanged: before !== after };
    },

    async openWindow(url, o = {}) {
      const before = await frontAsn();
      const key = registry.nextKey();
      const args = { url, key: registry.markerOf(key) };
      type Opened = { windowId: number; tab: RawTab; stamped: boolean };
      const idsBefore = await windowIdsNow(); // 시간을 넘겨 호스트가 죽어도 새 창을 알아보는 기준
      let raw: Opened;
      try {
        raw = await call<Opened>("openWindow", args, OPEN_WINDOW_TIMEOUT_MS);
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
      const after = await frontAsn();
      return { windowId: raw.windowId, tab: toTab({ raw: raw.tab, key, owned: true }), frontAppChanged: before !== after };
    },

    async setWindowSize(windowId, width, height) {
      requireOwnedWindow(windowId, "크기를 바꿔요");
      return resizeTo(windowId, width, height);
    },

    closeWindow,

    async captureWindow(windowId) {
      if ((await windowState(windowId, false)).gone) throw windowClosed(windowId);
      return captureWindowPng(windowId);
    },

    async showTab(tabKey) {
      await registry.withTab(tabKey, async (s) => {
        // 사용자 창의 현재 탭은 바꾸지 않는다. 우리가 연 창 안에서만.
        if (!ownedWindows.has(s.windowId)) throw new SafariError("SAFARI_ERROR", "Claude 가 연 창 안의 탭만 앞에 보여요");
        return call<Guarded<null>>("showTab", guardArgs(s));
      });
    },

    async screenCaptureAllowed() {
      return (await call<boolean>("screenAccess")) === true;
    },

    runJs(tabKey, source, o = {}) {
      return registry.withTab(tabKey, (s) => call<Guarded<string>>("runJs", { ...guardArgs(s), source }, o.timeoutMs));
    },

    closeTab: (tabKey) => registry.closeTab(tabKey),

    async rebindTab(tabKey) {
      const raw = await registry.rebind(tabKey);
      return toTab({ raw, key: tabKey, owned: registry.isOwned(tabKey) });
    },

    async settleTab(tabKey) {
      const r = await registry.settle(tabKey);
      return { navigated: r.navigated, leaving: r.leaving, tab: toTab({ raw: r.tab, key: tabKey, owned: registry.isOwned(tabKey) }) };
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
      if (firstError) throw firstError;
      return closed;
    },

    close: () => host.close(),
  };
}
