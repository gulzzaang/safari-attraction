import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HostError, HostTimeoutError, JxaHost } from "./jxa-host.js";
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

function opError(op: string, e: unknown): SafariError {
  if (e instanceof SafariError) return e;
  if (e instanceof HostTimeoutError) {
    return op === "runJs"
      ? new SafariError("ALERT_BLOCKED", "사파리가 답하지 않음 — 그 탭에 경고창이 떠 있을 수 있음(호스트를 다시 띄움)")
      : new SafariError("TIMEOUT", `${e.message} (호스트를 다시 띄움)`);
  }
  if (e instanceof HostError) {
    const msg = e.message;
    if (e.code === "SAFARI_NOT_RUNNING") return new SafariError("SAFARI_NOT_RUNNING", msg);
    if (/Apple Events/i.test(msg) && /JavaScript/i.test(msg)) return new SafariError("JS_FROM_APPLE_EVENTS_OFF", msg);
    if (e.number === -1743 || /-1743/.test(msg)) return new SafariError("AUTOMATION_DENIED", msg);
    if ((op === "runJs" || op === "closeTab") && (e.number === -1728 || /Can't get|Invalid index/i.test(msg))) {
      return new SafariError("TAB_CLOSED", msg);
    }
    return new SafariError("SAFARI_ERROR", msg);
  }
  return new SafariError("SAFARI_ERROR", e instanceof Error ? e.message : String(e));
}

function parseKey(key: string): { windowId: number; index: number } {
  const m = /^(\d+):(\d+)$/.exec(key);
  if (!m) throw new SafariError("TAB_CLOSED", `탭 키 모양이 아님: ${key}`);
  return { windowId: Number(m[1]), index: Number(m[2]) };
}

export function createJxaDriver(opts: { requestTimeoutMs?: number } = {}): SafariDriver {
  const host = new JxaHost(opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  // openTab 으로 연 탭의 키. 우리가 닫을 때는 뒤 탭 번호를 당겨 맞춘다.
  const owned = new Set<string>();

  async function call<T>(op: string, args: object = {}, timeoutMs?: number): Promise<T> {
    try {
      return (await host.call(op, args, timeoutMs)) as T;
    } catch (e) {
      throw opError(op, e);
    }
  }

  const keyOf = (windowId: number, index: number) => `${windowId}:${index}`;

  function toTab(raw: Omit<TabInfo, "key" | "owned">): TabInfo {
    const key = keyOf(raw.windowId, raw.index);
    return { ...raw, key, owned: owned.has(key) };
  }

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
      const raw = await call<Omit<TabInfo, "key" | "owned">[]>("listTabs");
      return raw.map(toTab);
    },

    async openTab(url, o = {}) {
      const before = await frontAsn();
      const args = { url, windowId: o.windowId };
      let raw: Omit<TabInfo, "key" | "owned">;
      try {
        raw = await call("openTab", args);
      } catch (e) {
        if (!(e instanceof SafariError && e.code === "SAFARI_NOT_RUNNING")) throw e;
        await launchSafari();
        raw = await call("openTab", args);
      }
      const tab = toTab(raw);
      owned.add(tab.key);
      tab.owned = true;
      const after = await frontAsn();
      return { tab, frontAppChanged: before !== after };
    },

    async runJs(tabKey, source, o = {}) {
      const { windowId, index } = parseKey(tabKey);
      return call<string>("runJs", { windowId, index, source }, o.timeoutMs);
    },

    async closeTab(tabKey) {
      const { windowId, index } = parseKey(tabKey);
      await call("closeTab", { windowId, index });
      owned.delete(tabKey);
      // 같은 창에서 뒤에 있던 우리 탭은 번호가 하나 당겨진다.
      for (const k of [...owned]) {
        const p = parseKey(k);
        if (p.windowId === windowId && p.index > index) {
          owned.delete(k);
          owned.add(keyOf(windowId, p.index - 1));
        }
      }
    },

    close: () => host.close(),
  };
}
