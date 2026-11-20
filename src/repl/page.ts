import { SafariError, type SafariDriver } from "../driver/types.js";
import {
  buildActionSource,
  buildEvalSource,
  buildPendingReadSource,
  type ActionErr,
  type ActionOk,
  type ActionOp,
} from "./inpage-actions.js";
import { IdleWatch, LOAD_TIMEOUT_MS, loadPollSource, loadTimeoutMessage, parseLoadReading, parseLoadStateArgs, parseWaitUntil, reached, type LoadState, type WaitUntil } from "./load-state.js";
import { DEFAULT_ACTION_WAIT_MS, LocatorImpl, globToRegExp, isRegExp, normTimeout, parseSelector, roleStep, textStep, toMatcher, type ActOpts, type Locator, type LocatorHost, type RoleOpts, type Step, type WaitCond, type WaitState } from "./locator.js";

export type { Locator } from "./locator.js";

/** waitFor · waitForSelector · waitForURL 이 조건을 다시 확인하는 간격. */
const WAIT_POLL_MS = 100;
const DEFAULT_WAIT_MS = 30000;
/** 「아직 아님」일 때 다시 확인하는 간격. 기다림은 Node 쪽에서 돈다 — 뒤쪽 탭에서는 사파리가 페이지의 타이머를 멈추기 때문이다. */
const ACTION_POLL_MS = 150;

/** 이동 하나의 기다림: 무엇을 기다리고(wait) 얼마 안에(timeoutMs, 시작 t0 부터) 끝내야 하는지. 호스트가 기다리는 시간도 남은 만큼으로 맞춘다. */
class NavWait {
  private readonly t0 = Date.now();
  constructor(
    readonly wait: WaitUntil,
    readonly timeoutMs: number,
  ) {}
  /** 남은 시간(밀리초, 최소 1). */
  remaining(): number {
    return Math.max(1, Math.round(this.timeoutMs - (Date.now() - this.t0)));
  }
  /** settleTab 에 줄 인자. */
  settleOpts(): { waitUntil?: "commit"; loadBudgetMs: number } {
    return this.wait === "commit" ? { waitUntil: "commit", loadBudgetMs: this.remaining() } : { loadBudgetMs: this.remaining() };
  }
}

/** 사파리 창이 줄어드는 최소 폭(대략). */
const MIN_WINDOW_WIDTH_PX = 336;
/** 동작이 이동을 일으킬 것 같은데(expectNav) 문서를 떠나는 낌새(beforeunload)가 없을 때 더 기다리는 시간. */
const EXPECT_NAV_GRACE_MS = 1500;
/** 문서를 떠나는 중(beforeunload)인데 새 문서가 안 뜰 때(느린 서버 · 내려받기) 기다리는 최대 시간. */
const LEAVING_MAX_MS = 8000;
/** 동작 중 페이지가 잡아 둔 setTimeout 이 이 시간 이하면 그만큼 기다렸다가 이동 여부를 본다(타이머 리다이렉트). */
const TIMER_WAIT_MAX_MS = 1000;
/** evaluate 가 돌려준 약속을 기다리는 시간. */
const PENDING_TIMEOUT_MS = 15000;
/** 찍기 전에 새로 현재가 된 탭이 그려지길(visibilityState) 기다리는 최대 시간과 확인 간격. */
/** 찍기 전에 load 를 더 기다리는 최대 시간. */
const CAPTURE_LOAD_WAIT_MS = 3000;
const PAINT_WAIT_MS = 1000;
const PAINT_POLL_MS = 100;
/** 보이게 된 뒤 한 번 더 그려지도록 두는 시간(프레임 한두 장). */
const PAINT_SETTLE_MS = 120;

/** evaluate 소스가 주소를 바꾸는 식인가(대입 · assign · replace · reload · submit · click · history 이동 · open). */
const NAVIGATING_SRC =
  /\blocation\b(\s*\.\s*href)?\s*=(?!=)|\.\s*(assign|replace|reload|submit|click|requestSubmit)\s*\(|\bhistory\s*\.\s*(back|forward|go)\s*\(|\bwindow\s*\.\s*open\s*\(/;

let tokenSeq = 0;
const newToken = () => `sa${Date.now().toString(36)}_${++tokenSeq}`;

/** Page 가 AI 전용 창 일을 할 때 세션에 묻는 것(세션이 AI 창 번호를 하나 들고 있다). */
export interface AiWindowAccess {
  /** 이 탭이 AI 창 안에 있으면 그 창 번호. 아니면 `what` 을 AI 창에서만 된다고 알리는 오류. AI 창이 닫혔으면 WINDOW_CLOSED(상태를 비운다). */
  windowFor(tabKey: string, what: string): Promise<number>;
  /** 드라이버가 그 창(windowId)이 닫혔다고 했을 때 세션 상태를 비운다. 그사이 AI 창이 다른 창으로 바뀌었으면 건드리지 않는다. */
  closed(windowId: number): void;
  /** 이 호출의 출력에 한 줄 남긴다. */
  note(line: string): void;
  /** 이 코드가 도는 repl 호출이 끝났거나 시간 초과로 닫혔나. 그러면 기다림 · 재시도는 더 이상 페이지에 아무것도 하지 않고 멈춘다. */
  aborted?(): boolean;
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
  private knownUrl = "";

  constructor(
    private readonly driver: SafariDriver,
    readonly key: string,
    private readonly ai?: AiWindowAccess,
  ) {}

  /** console.log(page) 가 드라이버 안쪽까지 쏟아내지 않게. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `Page { key: '${this.key}' }`;
  }

  /**
   * 주소로 이동하고 새 문서를 쓸 수 있게 될 때까지 기다린다(기본 waitUntil 'domcontentloaded' — load 이벤트까지 기다리지 않는다).
   * waitUntil: 'commit'(주소가 바뀌는 즉시) · 'domcontentloaded' · 'load' · 'networkidle'. timeout 은 밀리초(기본 15초, 최대 110초).
   */
  async goto(url: string, opts: { waitUntil?: WaitUntil; timeout?: number } = {}): Promise<void> {
    const nav = new NavWait(parseWaitUntil(opts?.waitUntil, "goto", true), normTimeout(opts?.timeout, LOAD_TIMEOUT_MS));
    await this.act("goto", { url }, nav);
    await this.afterNav(nav);
  }

  /**
   * 불러오기 상태를 기다린다. state 를 안 주면 'load'(readyState 가 complete — Playwright 와 같다).
   * 'domcontentloaded': 문서를 쓸 수 있을 때(interactive 이상 + body). 'networkidle': load 뒤 새 리소스 요청이 500ms 없을 때.
   * 옛 꼴 waitForLoadState(밀리초) 도 받는다. 기다림은 Node 쪽에서 돈다(뒤쪽 탭에서는 사파리가 페이지 타이머를 멈춘다).
   */
  async waitForLoadState(state?: LoadState | number | { timeout?: number }, opts?: { timeout?: number }): Promise<void> {
    const p = parseLoadStateArgs(state, opts);
    await this.waitLoad(p.state, p.timeoutMs);
  }

  /**
   * 남은 시간(remainingMs) 안에 상태가 되길 기다린다. 시간 초과 오류에는 부른 쪽이 처음 정한 전체 시간(totalMs, 안 주면 remainingMs)을 적는다.
   * @internal 열기(openTab)가 호스트 기다림 뒤에 이어서 기다릴 때 쓴다.
   */
  async waitLoad(state: LoadState, remainingMs: number, totalMs: number = remainingMs): Promise<void> {
    const source = loadPollSource(state);
    const idle = state === "networkidle" ? new IdleWatch() : null;
    const t0 = Date.now();
    for (;;) {
      this.checkAbort();
      const r = parseLoadReading(await this.driver.runJs(this.key, source));
      if (idle ? idle.feed(r, Date.now()) : reached(state as Exclude<LoadState, "networkidle">, r)) return;
      if (Date.now() - t0 > remainingMs) throw new SafariError("TIMEOUT", loadTimeoutMessage(state, totalMs));
      await sleep(100);
    }
  }

  /** 이동 뒤 기다림. commit 은 이미 주소가 바뀐 것을 settleTab 이 봤으니 더 기다리지 않는다. */
  private async afterNav(nav: NavWait): Promise<void> {
    if (nav.wait === "commit") return;
    await this.waitLoad(nav.wait, nav.remaining(), nav.timeoutMs);
  }

  /**
   * 마지막으로 알려진 주소를 바로 돌려준다(Playwright · 어사이드처럼 await 없이 쓴다). 드라이버가 탭을 열 때 · 페이지 안 코드를 돌린 뒤 ·
   * 이동을 확인한 뒤마다 새로 해 두므로, goto · 클릭 · evaluate 뒤에는 새 주소다. 탭이 닫혔으면 마지막 값이 남는다.
   */
  url(): string {
    const u = this.driver.lastUrl(this.key);
    if (u !== undefined) this.knownUrl = u;
    return this.knownUrl;
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

  /**
   * ref(`e12`) · CSS · Playwright 식 선택자(`text=글` · `text=/정규식/i` · `role=button[name="저장"]` · `css=…` · `button:has-text("저장")` · `a >> nth=0`, `>>` 로 이어 좁힘)로
   * 요소를 가리킨다. 요소는 동작할 때 찾는다. xpath 는 지원하지 않는다.
   */
  locator(selector: string): Locator {
    return new LocatorImpl(this.host, parseSelector(selector, true));
  }
  getByRole(role: string, opts: RoleOpts = {}): Locator {
    return this.rootLocator(roleStep(role, opts));
  }
  getByText(text: string | RegExp, opts: { exact?: boolean } = {}): Locator {
    return this.rootLocator(textStep("getByText", "text", text, opts));
  }
  getByLabel(text: string | RegExp, opts: { exact?: boolean } = {}): Locator {
    return this.rootLocator(textStep("getByLabel", "label", text, opts));
  }
  getByPlaceholder(text: string | RegExp, opts: { exact?: boolean } = {}): Locator {
    return this.rootLocator(textStep("getByPlaceholder", "placeholder", text, opts));
  }
  getByTestId(id: string | RegExp): Locator {
    return this.rootLocator({ k: "testid", m: toMatcher(id) });
  }

  // 선택자를 먼저 받는 줄임 동작(Playwright 의 page.click(sel) 꼴).
  click = async (sel: string, o?: ActOpts) => this.locator(sel).click(o);
  fill = async (sel: string, value: string, o?: ActOpts) => this.locator(sel).fill(value, o);
  press = async (sel: string, key: string, o?: ActOpts) => this.locator(sel).press(key, o);
  type = async (sel: string, text: string, o?: ActOpts) => this.locator(sel).type(text, o);
  check = async (sel: string, o?: ActOpts) => this.locator(sel).check(o);
  uncheck = async (sel: string, o?: ActOpts) => this.locator(sel).uncheck(o);
  selectOption = async (sel: string, value: Parameters<Locator["selectOption"]>[0], o?: ActOpts) => this.locator(sel).selectOption(value, o);
  textContent = async (sel: string, o?: ActOpts) => this.locator(sel).textContent(o);
  innerText = async (sel: string, o?: ActOpts) => this.locator(sel).innerText(o);
  inputValue = async (sel: string, o?: ActOpts) => this.locator(sel).inputValue(o);
  getAttribute = async (sel: string, name: string, o?: ActOpts) => this.locator(sel).getAttribute(name, o);
  isVisible = async (sel: string) => this.locator(sel).isVisible();

  /** 처음 맞는 요소가 조건(state, 기본 visible)이 될 때까지. 돌려주는 Locator 는 그 선택자를 가리킨다. */
  async waitForSelector(selector: string, opts: { state?: WaitState; timeout?: number } = {}): Promise<Locator> {
    const loc = this.locator(selector);
    await loc.waitFor({ state: opts?.state, timeout: opts?.timeout });
    return loc;
  }

  async waitForTimeout(ms: number): Promise<void> {
    await sleep(Number(ms) || 0);
  }

  /**
   * 주소가 맞을 때까지 기다린다. 글은 정확히(또는 `*` · `**` · `?` · `{a,b}` 글 패턴), RegExp, 함수(URL 을 받는다) 모두 된다.
   * 확인은 settleTab 으로 한다(이동 중에도 탭 키를 지키고 page.url() 도 새로 한다). 맞으면 새 문서를 쓸 수 있을 때까지 기다린다(waitUntil, 기본 'domcontentloaded').
   */
  async waitForURL(url: string | RegExp | ((u: URL) => boolean), opts: { timeout?: number; waitUntil?: WaitUntil } = {}): Promise<void> {
    const test = urlTester(url);
    const loadNav = () => new NavWait(parseWaitUntil(opts?.waitUntil, "waitForURL", true), normTimeout(opts?.timeout, LOAD_TIMEOUT_MS));
    loadNav(); // 잘못된 waitUntil 은 기다리기 전에 알린다
    const commit = opts?.waitUntil === "commit";
    const timeoutMs = normTimeout(opts?.timeout, DEFAULT_WAIT_MS);
    const t0 = Date.now();
    for (;;) {
      this.checkAbort();
      const cur = (await this.driver.settleTab(this.key, commit ? { waitUntil: "commit" } : undefined)).tab.url;
      this.knownUrl = cur;
      if (test(cur)) break;
      if (Date.now() - t0 > timeoutMs) {
        const what = typeof url === "function" ? "함수 조건" : String(url);
        throw new Error(`${showSeconds(timeoutMs)}초 안에 주소가 ${what} 와(과) 맞지 않았어요 (지금 주소: ${cur})`);
      }
      await sleep(WAIT_POLL_MS);
    }
    await this.afterNav(loadNav()); // 주소가 맞은 뒤부터 센다
  }

  /** 지금 문서를 다시 불러온다(같은 탭 · 같은 키). waitUntil 은 goto 와 같다(기본 'domcontentloaded'). */
  async reload(opts: { waitUntil?: WaitUntil; timeout?: number } = {}): Promise<void> {
    await this.navigate("reload", opts);
  }
  /** 뒤로 간다. 갈 곳이 없으면 잠깐 기다린 뒤 아무 일 없이 끝난다. */
  async goBack(opts: { waitUntil?: WaitUntil; timeout?: number } = {}): Promise<void> {
    await this.navigate("back", opts);
  }
  async goForward(opts: { waitUntil?: WaitUntil; timeout?: number } = {}): Promise<void> {
    await this.navigate("forward", opts);
  }

  /** 문서 전체 HTML 글(doctype 포함, 안쪽 iframe · shadow 는 들어 있지 않다). */
  content(): Promise<string> {
    return this.evaluate<string>(
      "(function(){var d=document.doctype;return (d?new XMLSerializer().serializeToString(d):'')+document.documentElement.outerHTML})()",
    );
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
    const r = await this.guardClosed(id, () => this.driver.setWindowSize(id, Math.round(width), Math.round(height)));
    if (r.innerWidth > Math.round(width)) this.ai!.note(`사파리 창은 약 ${MIN_WINDOW_WIDTH_PX}px 보다 좁게 못 줄여요(지금 ${r.innerWidth} px)`);
    return { width: r.innerWidth, height: r.innerHeight };
  }

  /**
   * 창을 PNG 로 찍는다(긴 변 1568px 이하) — 창 전체(주소창 포함). AI 전용 창의 탭에서만 되고, 찍기 전에 이 탭을 그 창의 현재 탭으로 만든다.
   * 화면 기록 권한이 필요하다. 결과를 보려면 display(buf) 로 붙인다.
   */
  async screenshot(): Promise<Buffer> {
    const id = await this.aiWindow("화면 찍기");
    return this.guardClosed(id, async () => {
      await this.driver.showTab(this.key);
      await this.waitForPaint();
      return this.driver.captureWindow(id);
    });
  }

  // ---- 안쪽 ----

  private aiWindow(what: string): Promise<number> {
    if (!this.ai) return Promise.reject(new Error(`${what}는 AI 전용 창에서만 돼요 — openAiWindow(url) 로 여세요`));
    return this.ai.windowFor(this.key, what);
  }

  /** 드라이버가 창(windowId)이 닫혔다고 하면 세션이 그 AI 창을 잊게 한 뒤 그대로 올린다. */
  private async guardClosed<T>(windowId: number, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (e instanceof SafariError && e.code === "WINDOW_CLOSED") this.ai?.closed(windowId);
      throw e;
    }
  }

  /**
   * showTab 뒤 새로 현재가 된 탭이 그려지길 잠깐 기다린다 — 안 그러면 이전 탭이 찍힌다. 탭이 보이는 상태(visibilityState)가 될 때까지
   * 최대 1초 확인하고, 한 번 더 그려지도록 잠깐 둔다. 확인이 실패하거나 끝내 안 보여도 막지 않는다(찍기가 알아서 오류를 낸다).
   */
  private async waitForPaint(): Promise<void> {
    await this.waitLoadedForCapture();
    const t0 = Date.now();
    for (;;) {
      let state = "";
      try {
        state = await this.driver.runJs(this.key, "document.visibilityState");
      } catch {
        break; // 읽지 못하면(자바스크립트를 못 돌리는 문서 등) 기다리지 않고 찍는다
      }
      if (state !== "hidden" || Date.now() - t0 >= PAINT_WAIT_MS) break;
      await sleep(PAINT_POLL_MS);
    }
    await sleep(PAINT_SETTLE_MS);
  }

  /**
   * 열기 · 이동이 문서를 쓸 수 있을 때(domcontentloaded) 돌아오므로, 찍기 전에 load 를 잠깐(최대 3초) 더 기다려 그림이 들어온 모습을 찍는다.
   * 그 안에 안 끝나거나 읽지 못해도 막지 않고 그대로 찍는다.
   */
  private async waitLoadedForCapture(): Promise<void> {
    const t0 = Date.now();
    try {
      for (;;) {
        this.checkAbort();
        const st = parseLoadReading(await this.driver.runJs(this.key, loadPollSource("load"))).readyState;
        if ((st !== "loading" && st !== "interactive") || Date.now() - t0 >= CAPTURE_LOAD_WAIT_MS) return; // 알 수 없는 값도 기다리지 않는다
        await sleep(100);
      }
    } catch (e) {
      if (/이미 끝나서/.test((e as Error)?.message ?? "")) throw e; // 호출이 끝났으면 멈춘다
    }
  }

  /** 페이지 안 동작 하나를 돌리고, 문서가 바뀌었으면 탭 키를 다시 붙인다. */
  private async act(op: ActionOp, args: Record<string, unknown>, nav?: NavWait) {
    this.checkAbort();
    return this.run(buildActionSource(op, { ...args, tok: newToken() }), false, nav);
  }

  /** 읽기만 하는 동작 하나(이동을 일으키지 않으니 settleTab 확인은 하지 않는다). */
  private async read(op: ActionOp, args: Record<string, unknown>) {
    this.checkAbort();
    const res = JSON.parse(await this.driver.runJs(this.key, buildActionSource(op, { ...args, tok: newToken() }))) as ActionOk | ActionErr;
    if (!res.ok) throw new Error(res.err);
    return res.r;
  }

  private readonly host: LocatorHost = {
    act: (op, args) => this.act(op, args),
    read: (op, args) => this.read(op, args),
    waitState: (chain, desc, state, timeoutMs) => this.waitState(chain, desc, state, timeoutMs),
    until: (kind, op, args, cond, desc, timeoutMs) => this.until(kind, op, args, cond, desc, timeoutMs),
  };
  private rootLocator(step: Step): Locator {
    return new LocatorImpl(this.host, [step]);
  }

  /**
   * 동작 하나를 대상이 준비될 때까지(없음 · 안 보임 · 비활성이 아닐 때까지) 다시 시도한다. 한 번 시도 = 페이지 안에서 찾고 되면 동작하는 runJs 하나,
   * 준비 전이면 동작 없이 「아직 아님」만 돌려받아 150ms 뒤 Node 쪽에서 다시 부른다. 이미 준비돼 있으면 정확히 한 번으로 끝난다.
   */
  private async until(kind: "act" | "read", op: ActionOp, args: Record<string, unknown>, cond: WaitCond, desc: string, timeout: number | undefined) {
    const timeoutMs = normTimeout(timeout, DEFAULT_ACTION_WAIT_MS);
    const full = { ...args, wait: { visible: cond.visible, enabled: cond.enabled } };
    const t0 = Date.now();
    for (;;) {
      const r = await (kind === "act" ? this.act(op, full) : this.read(op, full)); // act · read 가 호출이 끝났는지 먼저 본다
      if (!r.notReady) return r;
      if (Date.now() - t0 >= timeoutMs) {
        const why = { missing: "아직 없음", hidden: "있지만 안 보임", disabled: "있지만 비활성", option: "고를 선택지가 아직 없음" }[r.notReady];
        const chain = args.chain as Step[] | undefined;
        const hint =
          r.notReady !== "missing" ? "" : chain?.length === 1 && chain[0]!.k === "ref" ? " — 페이지가 바뀌었을 수 있으니 snapshot 을 다시 찍어 새 ref 를 쓰세요" : " — snapshot 으로 지금 화면을 확인하세요";
        throw new Error(`${showSeconds(timeoutMs)}초 기다렸지만 ${cond.phrase} 요소가 없어요: ${desc} (마지막 확인: ${why})${hint}`);
      }
      await sleep(ACTION_POLL_MS);
    }
  }

  /**
   * 제자리 이동(reload · back · forward) 뒤 새 문서를 쓸 수 있을 때까지(waitUntil). 되살아난(bfcache) 문서는 표시가 그대로라 새 문서로 보이지 않으므로,
   * 주소가 바뀌었는지도 함께 본다. 갈 곳이 없으면(뒤로 갈 이력이 없음) 잠깐 기다린 뒤 그대로 끝낸다.
   */
  private async navigate(dir: "reload" | "back" | "forward", opts: { waitUntil?: WaitUntil; timeout?: number } = {}): Promise<void> {
    const nav = new NavWait(parseWaitUntil(opts?.waitUntil, dir === "reload" ? "reload" : dir === "back" ? "goBack" : "goForward", true), normTimeout(opts?.timeout, LOAD_TIMEOUT_MS));
    // 이동하기 전 주소는 이동을 시키는 그 runJs 가 알려 준다(캐시가 한 박자 늦을 수 있다).
    const sent = await this.read("nav", { dir });
    const before = typeof sent.v === "string" ? sent.v : (this.driver.lastUrl?.(this.key) ?? this.knownUrl);
    const t0 = Date.now();
    for (;;) {
      this.checkAbort();
      const r = await this.driver.settleTab(this.key, nav.settleOpts());
      this.knownUrl = r.tab.url;
      if (r.navigated || (dir !== "reload" && r.tab.url !== before && !r.leaving)) break;
      if (Date.now() - t0 > (r.leaving ? LEAVING_MAX_MS : EXPECT_NAV_GRACE_MS + 500)) break;
      await sleep(100);
    }
    await this.afterNav(nav);
  }

  /**
   * 요소 상태가 될 때까지 다시 확인한다. 한 번 확인할 때마다 settleTab 으로 이동을 먼저 확인한다(이동 중에도 키를 지킨다).
   * hidden · detached 는 요소가 아예 없어도 된 것으로 친다.
   */
  private async waitState(chain: Step[], desc: string, state: WaitState, timeout: number | undefined): Promise<void> {
    const timeoutMs = normTimeout(timeout, DEFAULT_WAIT_MS);
    const t0 = Date.now();
    for (;;) {
      this.checkAbort();
      await this.driver.settleTab(this.key);
      const v = (await this.read("state", { chain, desc })).v as { n: number; vis: boolean } | undefined;
      const n = v?.n ?? 0;
      const vis = !!v?.vis;
      const done = state === "visible" ? vis : state === "attached" ? n > 0 : state === "hidden" ? !vis : n === 0;
      if (done) return;
      if (Date.now() - t0 > timeoutMs) {
        const ko = { visible: "보이게", hidden: "숨겨지게", attached: "나타나게", detached: "없어지게" }[state];
        throw new Error(`${showSeconds(timeoutMs)}초 안에 ${desc} 가 ${ko} 되지 않았어요`);
      }
      await sleep(WAIT_POLL_MS);
    }
  }

  /** 이 코드가 도는 repl 호출이 이미 끝났으면(시간 초과 포함) 더 이상 페이지에 아무것도 하지 않도록 멈춘다. */
  private checkAbort(): void {
    if (this.ai?.aborted?.()) throw new Error("repl 호출이 이미 끝나서 기다림을 멈췄어요(이 코드는 더 이상 페이지에 아무것도 하지 않아요)");
  }

  private async run(source: string, expectNav: boolean, nav?: NavWait) {
    const raw = await this.driver.runJs(this.key, source);
    const res = JSON.parse(raw) as ActionOk | ActionErr;
    if (!res.ok) throw new Error(res.err);
    if (res.r.notReady) return res.r; // 동작하지 않았으니 이동도 없다
    await this.settle(expectNav || !!res.r.expectNav, res.r.timerMs ?? -1, nav);
    return res.r;
  }

  /**
   * 동작 뒤 탭이 이동했는지 settleTab(읽기 전용)으로 보고, 새 문서면 거기서 끝낸다(표시는 settleTab 이 다시 적는다).
   * 아직 옛 문서면: 문서를 떠나는 중이면 더 기다리고, 동작이 이동을 일으킬 게 분명했으면(expectNav) 잠깐 더 기다리고, 아니면 끝.
   */
  private async settle(expectNav: boolean, timerMs: number, nav?: NavWait): Promise<void> {
    if (timerMs >= 0 && timerMs <= TIMER_WAIT_MAX_MS) await sleep(timerMs + 80);
    const t0 = Date.now();
    for (;;) {
      this.checkAbort();
      const r = await this.driver.settleTab(this.key, nav?.settleOpts());
      if (r.navigated) return;
      const waited = Date.now() - t0;
      if (r.leaving ? waited > LEAVING_MAX_MS : !expectNav || waited > EXPECT_NAV_GRACE_MS) return;
      await sleep(100);
    }
  }

  private async awaitPending(id: string): Promise<string | undefined> {
    const t0 = Date.now();
    for (;;) {
      this.checkAbort();
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

const showSeconds = (ms: number) => String(Math.round(ms) / 1000);

/** waitForURL 의 인자(글 · 글 패턴 · RegExp · 함수)를 「주소 글 → 맞나」 함수로. */
function urlTester(url: string | RegExp | ((u: URL) => boolean)): (cur: string) => boolean {
  if (typeof url === "function") {
    return (cur) => {
      try {
        return !!url(new URL(cur));
      } catch {
        return false;
      }
    };
  }
  if (isRegExp(url)) {
    const re = new RegExp(url.source, url.flags.replace(/[gy]/g, ""));
    return (cur) => re.test(cur);
  }
  const want = String(url);
  const glob = /[*?{]/.test(want) ? globToRegExp(want) : null;
  return (cur) => {
    if (cur === want) return true;
    if (glob) return glob.test(cur);
    try {
      return new URL(cur).href === new URL(want, cur).href; // 끝 / 처럼 같은 주소의 다른 꼴
    } catch {
      return false;
    }
  };
}
