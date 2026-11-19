import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HostError, HostTimeoutError, JxaHost } from "./jxa-host.js";
import { TabRegistry, type Guarded, type Probe, type RawTab, type RebindResult, type Spot } from "./tab-registry.js";
import { SafariError, type SafariDriver, type TabInfo, type WindowInfo } from "./types.js";

export { SafariError } from "./types.js";
export type { SafariDriver, TabInfo, WindowInfo } from "./types.js";

const execFileP = promisify(execFile);

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const LAUNCH_WAIT_MS = 15_000;

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

export function createJxaDriver(opts: { requestTimeoutMs?: number } = {}): SafariDriver {
  const host = new JxaHost(opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

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
    close: (spot, urlOnly, timeoutMs) => call<Guarded<null>>("closeTab", { ...guardArgs(spot), urlOnly }, timeoutMs),
  });

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

  return {
    listWindows: () => call<WindowInfo[]>("listWindows"),

    async listTabs() {
      const raw = await call<RawTab[]>("listTabs");
      return (await registry.sync(raw)).map(toTab);
    },

    async openTab(url, o = {}) {
      const before = await frontAsn();
      const key = registry.nextKey();
      const args = { url, windowId: o.windowId, key };
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

    runJs(tabKey, source, o = {}) {
      return registry.withTab(tabKey, (s) => call<Guarded<string>>("runJs", { ...guardArgs(s), source }, o.timeoutMs));
    },

    closeTab: (tabKey) => registry.closeTab(tabKey),

    async rebindTab(tabKey) {
      const raw = await registry.rebind(tabKey);
      return toTab({ raw, key: tabKey, owned: registry.isOwned(tabKey) });
    },

    closeOwned: () => registry.closeOwned(),

    close: () => host.close(),
  };
}
