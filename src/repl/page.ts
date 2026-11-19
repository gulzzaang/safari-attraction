import { SafariError, type SafariDriver } from "../driver/types.js";
import {
  buildActionSource,
  buildPendingReadSource,
  buildTokenCheckSource,
  type ActionErr,
  type ActionOk,
  type ActionOp,
} from "./inpage-actions.js";

const LOAD_TIMEOUT_MS = 15000;
/** 이동이 시작됐는데 아직 새 문서가 안 떴을 때 rebindTab 을 다시 부르는 최대 횟수(한 번에 1.5~5초씩 기다린다). */
const MAX_REBINDS = 4;
/** evaluate 가 돌려준 약속을 기다리는 시간. */
const PENDING_TIMEOUT_MS = 15000;

/** evaluate 소스가 주소를 바꾸는 식인가(대입 · assign · replace · reload · submit · click · history 이동 · open). */
const NAVIGATING_SRC =
  /\blocation\b(\s*\.\s*href)?\s*=(?!=)|\.\s*(assign|replace|reload|submit|click|requestSubmit)\s*\(|\bhistory\s*\.\s*(back|forward|go)\s*\(|\bwindow\s*\.\s*open\s*\(/;

let tokenSeq = 0;
const newToken = () => `sa${Date.now().toString(36)}_${++tokenSeq}`;

export interface Locator {
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  textContent(): Promise<string>;
}

/**
 * 사파리 탭 하나를 Playwright 의 Page 처럼 다룬다. 동작은 전부 페이지 안 자바스크립트(이벤트 보내기)로 한다 —
 * 진짜 마우스 · 키보드 입력이 아니고, 사파리를 앞으로 가져오지 않는다.
 *
 * 탭 키 지키기: 문서가 바뀌면 탭 표시가 사라져 레지스트리가 탭을 잃으므로, 이동을 일으킬 수 있는 동작은
 * 페이지에 표시(window.__saTok)를 심고, 동작 뒤에 문서가 바뀌었다고 판단되면 바로 driver.rebindTab 을 부른다.
 * 이동이 없으면 rebindTab 을 부르지 않는다(1.5초 이상 걸린다).
 */
export class Page {
  constructor(
    private readonly driver: SafariDriver,
    readonly key: string,
  ) {}

  /** 이동한 뒤 새 문서가 다 뜰 때까지(waitForLoadState)까지 기다린다. */
  async goto(url: string): Promise<void> {
    await this.act("goto", { url });
    await this.waitForLoadState();
  }

  /** document.readyState 가 complete 가 될 때까지(기본 15초). */
  async waitForLoadState(timeoutMs = LOAD_TIMEOUT_MS): Promise<void> {
    const t0 = Date.now();
    for (;;) {
      if ((await this.driver.runJs(this.key, "document.readyState")) === "complete") return;
      if (Date.now() - t0 > timeoutMs) throw new SafariError("TIMEOUT", `페이지가 ${timeoutMs}ms 안에 다 뜨지 않음`);
      await sleep(100);
    }
  }

  url(): Promise<string> {
    return this.driver.runJs(this.key, "location.href");
  }

  title(): Promise<string> {
    return this.driver.runJs(this.key, "document.title");
  }

  /**
   * 페이지 안에서 식(문자열)이나 함수를 돌려 결과를 받는다. 결과는 JSON 으로 오간다(DOM · 함수는 못 받는다).
   * 함수는 소스 글로 보내므로 바깥 변수를 쓸 수 없고, 필요한 값은 arg(JSON 으로 오간다)로 넘긴다. 약속은 기다린다.
   */
  async evaluate<T = unknown>(fn: string | ((arg: any) => T), arg?: unknown): Promise<Awaited<T>> {
    const src = typeof fn === "function" ? `(${fn.toString()})` : fn;
    const r = await this.act("eval", { src, arg }, { expectNav: NAVIGATING_SRC.test(src) });
    let s = r.s;
    if (r.pending) s = await this.awaitPending(r.pending);
    return (s === undefined ? undefined : JSON.parse(s)) as Awaited<T>;
  }

  /** ref(`e12`, snapshot 에서 본 것) 또는 CSS 선택자로 요소를 가리킨다. 요소는 동작할 때 찾는다. */
  locator(ref: string): Locator {
    return {
      click: async () => void (await this.act("click", { ref })),
      fill: async (value: string) => void (await this.act("fill", { ref, value: String(value) })),
      textContent: async () => (await this.act("text", { ref })).text ?? "",
    };
  }

  keyboard = {
    /** 글쇠 하나(`Enter`, `Tab`, `Escape`, `Backspace`, `ArrowDown`, `a` …). 포커스된 요소가 받는다. */
    press: async (key: string): Promise<void> => void (await this.act("press", { key })),
    /** 글자를 한 자씩 쳐 넣는다(`\n` 은 Enter). 포커스된 입력칸에 들어간다. */
    type: async (text: string): Promise<void> => void (await this.act("type", { text })),
  };

  // ---- 안쪽 ----

  /** 페이지 안 동작 하나를 돌리고, 문서가 바뀌었으면 탭 키를 다시 붙인다. */
  private async act(op: ActionOp, args: Record<string, unknown>, o: { expectNav?: boolean } = {}) {
    const tok = newToken();
    const raw = await this.driver.runJs(this.key, buildActionSource(op, { ...args, tok }));
    const res = JSON.parse(raw) as ActionOk | ActionErr;
    if (!res.ok) throw new Error(res.err);
    await this.settle(tok, !!res.r.expectNav || !!o.expectNav);
    return res.r;
  }

  private async tokenState(tok: string): Promise<{ tok: boolean; leaving: boolean }> {
    try {
      return JSON.parse(await this.driver.runJs(this.key, buildTokenCheckSource(tok)));
    } catch (e) {
      if (e instanceof SafariError && e.code === "TAB_CLOSED") {
        throw new SafariError(
          "TAB_CLOSED",
          `동작은 했지만 그 사이 페이지가 바뀌어 탭 ${this.key} 의 표시를 잃음(이동이 끝나기 전에 확인함). 탭을 다시 확인하세요`,
        );
      }
      throw e;
    }
  }

  /**
   * 동작 뒤 문서가 바뀌었는지 보고 바뀌었으면 rebindTab(불러오기가 끝나길 기다린다)을 부른다.
   * expectNav 면(동작이 이동을 일으킨 게 분명) 바로 부른다. 아니면 표시를 한 번 보고, 표시가 사라졌거나
   * 문서를 떠나는 중(beforeunload)일 때만 부른다. 이동이 없으면 아무것도 안 부른다.
   */
  private async settle(tok: string, expectNav: boolean): Promise<void> {
    if (!expectNav) {
      const st = await this.tokenState(tok);
      if (st.tok && !st.leaving) return; // 같은 문서
    }
    for (let i = 0; i < MAX_REBINDS; i++) {
      await this.driver.rebindTab(this.key);
      // 새 문서에는 rebindTab 이 표시를 다시 적어 둔 뒤라 읽어도 안전하다. 표시가 사라졌으면 새 문서다.
      const st = await this.tokenState(tok);
      if (!st.tok) return;
      // 아직 옛 문서: 떠나는 중이면(이동이 느림) 더 기다리고, 아니면 이동이 일어나지 않은 것이다.
      if (!st.leaving) return;
    }
  }

  private async awaitPending(id: string): Promise<string | undefined> {
    const t0 = Date.now();
    for (;;) {
      const p = JSON.parse(await this.driver.runJs(this.key, buildPendingReadSource(id))) as {
        state: "pending" | "ok" | "err" | "lost";
        s?: string;
        err?: string;
      };
      if (p.state === "ok") return p.s;
      if (p.state === "err") throw new Error(p.err ?? "evaluate 가 거부됨");
      if (p.state === "lost") throw new Error("evaluate 결과를 찾을 수 없음(페이지가 바뀜)");
      if (Date.now() - t0 > PENDING_TIMEOUT_MS) throw new SafariError("TIMEOUT", `evaluate 의 약속이 ${PENDING_TIMEOUT_MS}ms 안에 끝나지 않음`);
      await sleep(50);
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
