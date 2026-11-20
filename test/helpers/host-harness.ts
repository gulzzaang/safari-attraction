import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/**
 * 사파리 없이 JXA 호스트(host.js)의 op 를 부려 보는 틀. host.js 를 node:vm 안에서 읽고(JXA 전역 `Application` · `ObjC` · `$` 는 가짜),
 * 가짜 사파리의 doJavaScript 는 받은 스크립트를 가짜 페이지(document · location 만 있는 vm 문맥)에서 진짜로 돌린다.
 * 사파리처럼 소스가 던진 오류는 오류로 올리지 않고 null 을 돌려주고, 없는 탭을 가리키면 -1728 오류를 던진다.
 */
const HOST_SRC = readFileSync(fileURLToPath(new URL("../../src/driver/jxa/host.js", import.meta.url)), "utf8");

export interface FakePage {
  /** document.documentElement.dataset */
  dataset: Record<string, string>;
  href: string;
  /** 페이지 전역(소스가 읽을 수 있는 이름). */
  globals: Record<string, unknown>;
  title?: string;
  /** 이 페이지에서 JS 를 못 돈다(null 을 돌려준다). */
  noJs?: boolean;
  /** 사파리가 오류를 올린다(「Apple 이벤트에서 JavaScript 허용」 꺼짐). */
  jsOff?: boolean;
  /** document.documentElement 가 없다. */
  noRoot?: boolean;
  /** 스크립트를 돌린 뒤(부작용은 일어난 뒤) 사파리가 이 오류를 올린다(예: Apple Event 시간 초과 -1712). */
  throwAfterRun?: { message: string; number: number };
  /** 페이지가 돌리는 동안 쌓이는 상태(소스가 `(window.runs = (window.runs || 0) + 1)` 처럼 센다). 한 페이지에 문맥 하나 — 호출을 넘어 이어진다. */
  ctx?: Record<string, any>;
}

export interface FakeTab {
  page: FakePage;
  /** tab.url() 이 돌려주는 값을 page.href 와 다르게 한다(이동 중이면 가는 중인 목적지를 돌려준다). */
  dest?: string;
  closed?: boolean;
  url(): string;
}

export type Event = { kind: "doJavaScript"; script: string } | { kind: "tabUrl" } | { kind: "setCurrentTab"; windowId: number } | { kind: "currentTab" };

export interface Harness {
  ops: Record<string, (args: Record<string, unknown>) => any>;
  events: Event[];
  windows: Map<number, { tabs: FakeTab[]; current?: FakeTab }>;
  addWindow(id: number, ...pages: Array<{ url: string; marker?: string; globals?: Record<string, unknown> }>): FakeTab[];
}

export function createHarness(): Harness {
  const events: Event[] = [];
  const windows = new Map<number, { tabs: FakeTab[]; current?: FakeTab }>();
  const goneError = () => Object.assign(new Error("대상체를 가져올 수 없습니다."), { errorNumber: -1728 });

  const mkTab = (t: FakeTab | undefined) => t;
  const Safari: any = {
    running: () => true,
    windows: {
      byId(id: number) {
        const w = windows.get(id);
        return {
          id: () => id,
          get tabs() {
            return new Proxy([] as unknown[], {
              get(_t, p) {
                if (typeof p === "string" && /^\d+$/.test(p)) return mkTab(w?.tabs[Number(p)]);
                if (p === "length") return w?.tabs.length ?? 0;
                return undefined;
              },
            });
          },
          set currentTab(t: FakeTab) {
            events.push({ kind: "setCurrentTab", windowId: id });
            if (w) w.current = t;
          },
          // win.currentTab() — 호출하면 현재 탭(없으면 첫 탭)의 {index()} 를 돌려준다. Apple Event 한 번으로 센다.
          get currentTab() {
            return () => {
              events.push({ kind: "currentTab" });
              return { index: () => (w ? Math.max(0, w.tabs.indexOf(w.current ?? w.tabs[0]!)) + 1 : 0) };
            };
          },
        };
      },
    },
    doJavaScript(script: string, opts: { in?: FakeTab }) {
      events.push({ kind: "doJavaScript", script });
      const tab = opts?.in;
      if (!tab || tab.closed) throw goneError();
      const p = tab.page;
      if (p.jsOff) throw new Error("Safari에서 Apple 이벤트의 JavaScript를 허용하지 않습니다.");
      if (p.noJs) return null;
      if (!p.ctx) {
        p.ctx = vm.createContext({
          document: {
            get title() {
              return p.title ?? "";
            },
            get documentElement() {
              if (p.noRoot) return null;
              return { dataset: p.dataset };
            },
          },
          location: {
            get href() {
              return p.href;
            },
          },
          ...p.globals,
        });
        p.ctx.window = p.ctx; // window.__saLeaving 처럼 전역을 window 로 읽는 코드용
      }
      const ctx = p.ctx;
      try {
        const v = vm.runInContext(script, ctx);
        if (p.throwAfterRun) throw Object.assign(new Error(p.throwAfterRun.message), { errorNumber: p.throwAfterRun.number, hostError: true });
        return v === undefined ? null : v;
      } catch (e) {
        if ((e as { hostError?: boolean }).hostError) throw e;
        return null; // 사파리는 페이지 안에서 던진 오류(문법 오류 포함)를 오류로 올리지 않는다
      }
    },
  };
  const addWindow: Harness["addWindow"] = (id, ...pages) => {
    const tabs = pages.map((pg): FakeTab => {
      const page: FakePage = { dataset: pg.marker ? { saTab: pg.marker } : {}, href: pg.url, globals: pg.globals ?? {} };
      const tab: FakeTab = {
        page,
        url() {
          events.push({ kind: "tabUrl" }); // tab.url() 도 Apple Event 한 번이다
          if (tab.closed) throw Object.assign(new Error("유효하지 않은 인덱스입니다."), { errorNumber: -1719 });
          return tab.dest ?? page.href;
        },
      };
      return tab;
    });
    windows.set(id, { tabs });
    return tabs;
  };

  const sandbox: Record<string, unknown> = {
    Application: () => Safari,
    ObjC: { import() {}, unwrap: (x: unknown) => x },
    $: {
      NSFileHandle: {
        fileHandleWithStandardInput: { availableData: { length: 0 } },
        fileHandleWithStandardOutput: { writeData() {} },
      },
      getppid: () => 1,
      exit() {},
      NSUTF8StringEncoding: 4,
    },
    delay() {},
    console,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(HOST_SRC + "\n;globalThis.__ops = ops;", ctx);
  return { ops: (ctx as any).__ops, events, windows, addWindow };
}
