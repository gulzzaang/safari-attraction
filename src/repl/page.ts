import { SafariError, type SafariDriver } from "../driver/types.js";
import {
  buildActionSource,
  buildEvalSource,
  buildPendingReadSource,
  type ActionErr,
  type ActionOk,
  type ActionOp,
} from "./inpage-actions.js";

/** 사파리 창이 줄어드는 최소 폭(대략). */
const MIN_WINDOW_WIDTH_PX = 336;
const LOAD_TIMEOUT_MS = 15000;
/** 동작이 이동을 일으킬 것 같은데(expectNav) 문서를 떠나는 낌새(beforeunload)가 없을 때 더 기다리는 시간. */
const EXPECT_NAV_GRACE_MS = 1500;
/** 문서를 떠나는 중(beforeunload)인데 새 문서가 안 뜰 때(느린 서버 · 내려받기) 기다리는 최대 시간. */
const LEAVING_MAX_MS = 8000;
/** 동작 중 페이지가 잡아 둔 setTimeout 이 이 시간 이하면 그만큼 기다렸다가 이동 여부를 본다(타이머 리다이렉트). */
const TIMER_WAIT_MAX_MS = 1000;
/** evaluate 가 돌려준 약속을 기다리는 시간. */
const PENDING_TIMEOUT_MS = 15000;

/** evaluate 소스가 주소를 바꾸는 식인가(대입 · assign · replace · reload · submit · click · history 이동 · open). */
const NAVIGATING_SRC =
  /\blocation\b(\s*\.\s*href)?\s*=(?!=)|\.\s*(assign|replace|reload|submit|click|requestSubmit)\s*\(|\bhistory\s*\.\s*(back|forward|go)\s*\(|\bwindow\s*\.\s*open\s*\(/;

let tokenSeq = 0;
const newToken = () => `sa${Date.now().toString(36)}_${++tokenSeq}`;

/** Page 가 AI 전용 창 일을 할 때 세션에 묻는 것(세션이 AI 창 번호를 하나 들고 있다). */
export interface AiWindowAccess {
  /** 이 탭이 AI 창 안에 있으면 그 창 번호. 아니면 `what` 을 AI 창에서만 된다고 알리는 오류. AI 창이 닫혔으면 WINDOW_CLOSED(상태를 비운다). */
  windowFor(tabKey: string, what: string): Promise<number>;
  /** 드라이버가 창이 닫혔다고 했을 때 세션 상태를 비운다. */
  closed(): void;
  /** 이 호출의 출력에 한 줄 남긴다. */
  note(line: string): void;
}

export interface Locator {
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  textContent(): Promise<string>;
}

/**
 * 사파리 탭 하나를 Playwright 의 Page 처럼 다룬다. 동작은 전부 페이지 안 자바스크립트(이벤트 보내기)로 한다 —
 * 진짜 마우스 · 키보드 입력이 아니고, 사파리를 앞으로 가져오지 않는다.
 *
 * 탭 키 지키기: 문서가 바뀌면 탭 표시가 사라져 runJs 로는 탭을 못 찾는다(레지스트리가 키를 지운다). 그래서 이동을 일으킬
 * 수 있는 동작(goto · click · 글쇠 · evaluate) 뒤에는 runJs 가 아니라 driver.settleTab 으로 확인한다 — 읽기 전용이라 새 문서가
 * 이미 떴어도 키를 지우지 않고 표시를 다시 적어 준다. 이동이 느리거나(떠나는 중) 동작이 이동을 일으킬 게 분명하면 settleTab 을 거듭 부른다.
 * 동작 중 잡힌 짧은 setTimeout(타이머 리다이렉트)도 그만큼 기다렸다가 확인한다.
 */
export class Page {
  constructor(
    private readonly driver: SafariDriver,
    readonly key: string,
    private readonly ai?: AiWindowAccess,
  ) {}

  /** console.log(page) 가 드라이버 안쪽까지 쏟아내지 않게. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `Page { key: '${this.key}' }`;
  }

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
    try {
      // 소스를 스크립트 글에 그대로 끼우므로 문법 오류는 미리 걸러 한국어로 알린다(안 그러면 스크립트 전체가 깨진다).
      new Function(`return (${src}\n)`);
    } catch (e) {
      throw new Error(`evaluate 식의 문법이 잘못됨: ${(e as Error).message} (식 하나나 함수여야 합니다)`);
    }
    const tok = newToken();
    const r = await this.run(buildEvalSource(src, arg, tok), NAVIGATING_SRC.test(src));
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

  /**
   * 창 안 페이지 크기(innerWidth · innerHeight)를 맞추고 실제 크기를 돌려준다. AI 전용 창(openAiWindow)의 탭에서만 된다.
   * 사파리 최소 폭보다 좁게 요청하면 실제 크기가 더 크고, 그때는 출력에 안내가 나온다.
   */
  async setViewportSize(size: { width: number; height: number }): Promise<{ width: number; height: number }> {
    const width = Number(size?.width);
    const height = Number(size?.height);
    if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
      throw new Error("setViewportSize({width, height}): 폭과 높이는 0 보다 큰 숫자여야 합니다");
    }
    const id = await this.aiWindow("화면 크기 바꾸기");
    const r = await this.guardClosed(() => this.driver.setWindowSize(id, Math.round(width), Math.round(height)));
    if (r.innerWidth > Math.round(width)) this.ai!.note(`사파리 창은 약 ${MIN_WINDOW_WIDTH_PX}px 보다 좁게 못 줄여요(지금 ${r.innerWidth} px)`);
    return { width: r.innerWidth, height: r.innerHeight };
  }

  /**
   * 창을 PNG 로 찍는다(긴 변 1568px 이하) — 창 전체(주소창 포함). AI 전용 창의 탭에서만 되고, 찍기 전에 이 탭을 그 창의 현재 탭으로 만든다.
   * 화면 기록 권한이 필요하다. 결과를 보려면 display(buf) 로 붙인다.
   */
  async screenshot(): Promise<Buffer> {
    const id = await this.aiWindow("화면 찍기");
    return this.guardClosed(async () => {
      await this.driver.showTab(this.key);
      return this.driver.captureWindow(id);
    });
  }

  // ---- 안쪽 ----

  private aiWindow(what: string): Promise<number> {
    if (!this.ai) return Promise.reject(new Error(`${what}는 AI 전용 창에서만 돼요 — openAiWindow(url) 로 여세요`));
    return this.ai.windowFor(this.key, what);
  }

  /** 드라이버가 창이 닫혔다고 하면 세션이 AI 창을 잊게 한 뒤 그대로 올린다. */
  private async guardClosed<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (e instanceof SafariError && e.code === "WINDOW_CLOSED") this.ai?.closed();
      throw e;
    }
  }


  /** 페이지 안 동작 하나를 돌리고, 문서가 바뀌었으면 탭 키를 다시 붙인다. */
  private act(op: ActionOp, args: Record<string, unknown>) {
    return this.run(buildActionSource(op, { ...args, tok: newToken() }), false);
  }

  private async run(source: string, expectNav: boolean) {
    const raw = await this.driver.runJs(this.key, source);
    const res = JSON.parse(raw) as ActionOk | ActionErr;
    if (!res.ok) throw new Error(res.err);
    await this.settle(expectNav || !!res.r.expectNav, res.r.timerMs ?? -1);
    return res.r;
  }

  /**
   * 동작 뒤 탭이 이동했는지 settleTab(읽기 전용)으로 보고, 새 문서면 거기서 끝낸다(표시는 settleTab 이 다시 적는다).
   * 아직 옛 문서면: 문서를 떠나는 중이면 더 기다리고, 동작이 이동을 일으킬 게 분명했으면(expectNav) 잠깐 더 기다리고, 아니면 끝.
   */
  private async settle(expectNav: boolean, timerMs: number): Promise<void> {
    if (timerMs >= 0 && timerMs <= TIMER_WAIT_MAX_MS) await sleep(timerMs + 80);
    const t0 = Date.now();
    for (;;) {
      const r = await this.driver.settleTab(this.key);
      if (r.navigated) return;
      const waited = Date.now() - t0;
      if (r.leaving ? waited > LEAVING_MAX_MS : !expectNav || waited > EXPECT_NAV_GRACE_MS) return;
      await sleep(100);
    }
  }

  private async awaitPending(id: string): Promise<string | undefined> {
    const t0 = Date.now();
    for (;;) {
      // 읽기 전에 이동을 확인한다 — 약속을 기다리는 동안 페이지가 이동했으면 runJs 가 탭 키를 지울 수 있다.
      if ((await this.driver.settleTab(this.key)).navigated) throw new Error("evaluate 의 약속이 끝나기 전에 페이지가 이동해 결과를 받을 수 없음(탭 키는 그대로)");
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
