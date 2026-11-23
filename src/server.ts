import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SafariDriver } from "./driver/types.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { toKorean } from "./errors-ko.js";
import { ActivityLog, type Touch } from "./memory/activity.js";
import { MemoryHome, resolveHome } from "./memory/home.js";
import { createReplSession } from "./repl/context.js";
import { SNAPSHOT_LIMIT_BYTES } from "./snapshot/diff.js";
import { VERSION } from "./version.js";

export const REPL_DESCRIPTION = `사용자의 진짜 사파리(로그인된 그대로)를 자바스크립트로 조작한다. 새 탭은 뒤쪽 탭으로 열려 사용자 화면을 가로채지 않는다.
Drive the user's real, logged-in Safari with JavaScript. New tabs open in the background and never take the user's screen.

값은 console.log 로 찍어야 보인다(마지막 식의 값은 안 찍힌다). 오류는 isError 로 온다.
Read values with console.log (the last expression is NOT printed). Errors come back with isError.

전역 / Globals:
- openTab(url) → Page. 뒤쪽 탭을 열고 페이지를 쓸 수 있게 되면(domcontentloaded) 돌려준다(load 까지는 waitForLoadState('load'|'networkidle')). 열린 탭은 \`page\`(현재)와 \`tabs\`(배열)에 들어간다.
- attachActiveBrowserTab() → 사용자가 지금 보고 있는 맨 앞 창의 활성 탭. "내가 보고 있는 페이지" 라고 할 때 쓴다. attachBrowserTab(key) / listBrowserTabs() 로 다른 탭도 고른다. 사용자의 탭은 떼기만 하고 닫지 않는다.
- openAiWindow(url = "about:blank", {width = 1280, height = 800}) → Page. Claude 전용 사파리 창(사용자 창 맨 뒤, 앞 앱을 안 바꿈)을 열고 그 안의 탭을 돌려준다. 창은 세션에 하나라 다시 부르면 같은 창에 새 탭이 열린다. 사용자가 창을 닫았으면 WINDOW_CLOSED 안내가 나오고, openAiWindow() 를 다시 부르면 새 창이 열린다.
- page.setViewportSize({width, height}) → {width, height}(실제 값) — 창 안 페이지 크기를 맞춘다(휴대폰 폭이면 390×844). 사파리 창은 약 336px 보다 좁게 못 줄인다. AI 창의 탭에서만.
- page.screenshot() → Buffer(PNG, 긴 변 1568px 이하) — AI 창 전체(주소창 포함)를 찍는다. AI 창의 탭에서만(그 탭을 창의 현재 탭으로 만든 뒤 찍는다). 화면 기록 권한이 필요하다(시스템 설정 → 개인정보 보호 및 보안 → 화면 및 시스템 오디오 녹음) — 없으면 오류 글에 안내가 나온다. 찍은 걸 보려면 display(buf) 로 붙인다.
- display(buf) — 이 호출의 결과에 이미지를 붙인다. 한 호출에 4장까지.
  Screenshots: openAiWindow() opens a Claude-only Safari window (behind the user's windows, never activates Safari); page.setViewportSize / page.screenshot work only on tabs in that window and need Screen Recording permission; display(buf) attaches a PNG to the result (max 4 per call).
- listWindows() → [{id, index, title, tabCount, width, height, isAiWindow, isWorkWindow}] — 열린 사파리 창 목록. 사용자가 "두 번째 창", "그 창" 이라고 하면 title(그 창 현재 탭 이름) · tabCount · 크기로 골라 id 를 얻는다.
- useWindow(id) — 이후 openTab 이 그 창에 뒤쪽 탭을 연다(그 창의 프로필을 따른다). useWindow(null) 이면 맨 앞 일반 창(기본). 없는 id 는 오류. 고른 창이 닫히면 다음 openTab 에서 안내 한 줄과 함께 맨 앞 창으로 돌아간다. 사용자 탭 · 창은 떼기만 하고 닫지 않는다.
- useAiWindow(id) — 사용자가 이미 열어 둔 창(예: 다른 프로필 창)을 AI 전용 창으로 쓴다. 이후 openAiWindow(url) 은 그 창에 새 탭을 열고, page.setViewportSize · page.screenshot 도 된다(setViewportSize 는 그 창 크기를 실제로 바꾼다). 이 창은 우리 창이 아니라서 끝나도 닫지 않고, 우리가 그 안에 연 탭만 닫는다.
  Windows: listWindows() lists Safari windows so the user can say "the second window"; useWindow(id) makes openTab open background tabs in that window (follows its profile), useWindow(null) goes back to the frontmost normal window; useAiWindow(id) uses an already-open window as the AI window (never closed by us; only tabs we opened in it are closed).
- closeTab(page?) — 우리가 연 탭만 닫는다. 서버가 끝나면 우리가 연 탭과 AI 창은 모두 닫힌다.
- snapshot(page?, {interactive, selector, full}) — 페이지를 읽는다. console.log(await snapshot()) 로 찍으면 "지난번과 바뀐 곳만" 나오고, 처음이거나 같으면 전체 · 「변화 없음」이 나온다. 기본은 지금 화면에 보이는 곳만 읽고, 끝에 「… 아래에 더 있음(약 N줄)」 줄이 있으면 화면 아래에 더 있다는 뜻이다. 내린(스크롤한) 뒤에는 새로 보이게 된 줄만 나온다(전부 보려면 {full: true}). 요소 앞의 e12 같은 ref 를 locator(ref) 에 쓴다. 16KB 를 넘으면 잘린다.
  By default only the visible screen is read; a final "… 아래에 더 있음(약 N줄)" line means there is more content below. After scrolling, snapshot prints only the newly visible lines (use {full: true} for everything).
- Page: goto(url), url(), title(), waitForLoadState(), evaluate(fn | 식, arg), locator(ref | CSS).click() / .fill(값) / .textContent(), keyboard.press("Enter") / keyboard.type(글).
  url() 은 await 없이 바로 마지막으로 알려진 주소(글)를 돌려준다 — goto · 클릭 · evaluate 뒤에는 새 주소다. title() 은 페이지에 물어야 하므로 await 가 필요하다.
  Page.url() returns the last known address immediately (a string, no await; updated after goto / clicks / evaluate); title() is async and needs await. openTab / goto return once the page is usable (domcontentloaded); add waitForLoadState('load' | 'networkidle') if needed.
- Playwright 식도 된다 / Playwright-style API: page.waitForURL(글·glob·RegExp·함수)/waitForSelector/waitForTimeout/reload/goBack/goForward/content, page.click·fill·check·selectOption·textContent 등 Locator 동작은 page.동작(선택자,…) 로도, getByRole/getByText/getByLabel/getByPlaceholder/getByTestId. Locator: first/last/nth/count/all/locator/filter({hasText})/getBy…/innerText/inputValue/getAttribute/isVisible/isChecked/isEnabled/check/uncheck/selectOption/press/type/pressSequentially/hover/focus/scrollIntoViewIfNeeded/waitFor. 엄격하지 않다: 동작은 보이는 첫 번째에(first()/nth() 는 글자 그대로), count()/all() 은 전부, 요소가 나타날 때까지 최대 10초 기다린다({timeout}). 선택자 text= role= :has-text >> 도 된다. Non-strict: actions use the first visible match (first()/nth() literal), count()/all() see all; they wait up to 10 s ({timeout}).
- fetch(url, init) → {status, ok, headers(보통 객체), text(), json()}. 현재 page 안에서 돌아 그 페이지의 쿠키로 나가고 CORS · CSP 를 따른다.
- sleep(ms), URL, URLSearchParams, structuredClone, TextEncoder/Decoder, atob/btoa.

규칙 / Rules:
- 최상위 await 가 되고, const · let · 함수는 다음 호출에도 남는다. 그래서 호출마다 새 변수 이름을 쓴다(같은 이름을 다시 쓰면 지난 값이 덮어써져 헷갈린다).
  Top-level await works; declarations persist across calls, so use NEW variable names each call.
- 한 호출에 여러 단계를 넣어도 된다(열기 → 입력 → 읽기). 호출 수를 줄여라.
- 페이지가 바뀐 뒤 같은 snapshot 을 다시 읽으면 바뀐 곳만 찍힌다. 전체가 필요하면 snapshot(page, {full: true}).
- 호출은 120초 안에 끝나야 한다. 입력 · 클릭은 진짜 마우스 · 키보드가 아니라 페이지 안 이벤트로 보내진다.

알려진 한계 / Known limits:
- 읽기(snapshot)는 열린 shadow DOM 과 같은 사이트 iframe 안쪽까지 읽고 클릭도 된다. 닫힌 shadow root 와 다른 사이트(또는 sandbox 된) iframe 은 한 줄로만 보이고 안쪽은 못 읽는다. 그 안에서 Enter 로 제출해 이동하는 것은 이동으로 감지되지 않을 수 있다.
  Open shadow DOM and same-origin iframes are read (and clickable); closed shadow roots and other-site or sandboxed iframes show as one line and are not read inside; Enter-submits inside shadow DOM/iframes may not be detected as navigation.
- evaluate 는 함수 하나나 식 하나만 받는다(여러 문장은 함수로 감싼다). 결과는 JSON 으로 오가 DOM · 함수는 못 받는다. 바깥 변수는 못 쓰고 arg 로 넘긴다.
- await 뒤에서 이벤트 루프를 막는 코드(예: await x; while(true){})는 서버를 멈출 수 있다. 쓰지 말 것.
- 사파리 스크립트는 개인정보 보호 창과 일반 창을 구별하지 못해, 맨 앞 창을 그대로 쓴다. 개인정보 보호 창이 앞에 있으면 거기에 열릴 수 있다.
- 내린 뒤 읽기는 새로 보이는 줄만 내므로, 내리는 같은 사이에 내용이 바뀐 것(무한 스크롤 등)에서 사라진 줄은 알려 주지 않는다. 내렸는지는 창과 화면에 보이는 안쪽 스크롤 영역(입력칸 제외)의 위치로 알아본다. 모달이 body 를 고정해 창 위치가 바뀌는 경우에도 내린 것으로 보이니, 그때는 {full: true}. 찍지 않은 읽기는 읽은 것으로 치지 않는다. 화면 안에서 저절로 움직이는 목록 · 캐러셀도 내린 것으로 본다.
  After a scroll, snapshot lists only new lines, so lines genuinely removed in the same step (e.g. infinite scroll) are not reported; scrolling is detected from the window and visible inner scroll areas (not form fields), so a modal that fixes the body can look like a scroll (use {full: true}); a snapshot you never print does not count as read; an on-screen auto-moving list/carousel also counts as a scroll.
- 처음 쓸 때 설정이 막히면 오류 글에 안내가 나온다. status 도구로 설정 상태를 볼 수 있다.`;

export const STATUS_DESCRIPTION =
  "빠진 준비를 한국어로 점검한다 — 사파리 실행, 자동화 허락, 「Apple 이벤트의 JavaScript 허용」, 화면 기록(찍기용). 항목마다 ✓ / ✗ / ? 와 고칠 곳을 보여 준다. 막혔을 때 먼저 부른다. 빈 탭을 잠깐 열었다 닫는다. / Reports Safari connection status.";

/**
 * repl 한 번이 끝난 뒤의 기억 쪽 일: 하루 기록을 쓰고, 응답 끝에 붙일 글(사이트 메모 → 정리 안내 → 쓰기 실패 안내)을 모은다.
 * 기억 쪽이 어떻게 실패해도 repl 결과를 바꾸지 않는다 — 쓰기 실패는 대화당 한 번 한 줄로만 알린다.
 */
async function memoryExtras(
  activity: ActivityLog,
  entry: { title: string; touched: Touch[]; ok: boolean; error?: string },
): Promise<string[]> {
  const extras: string[] = [];
  let failed: { error: unknown } | undefined;
  try {
    await activity.record(entry);
  } catch (error) {
    failed = { error };
  }
  for (const part of [() => activity.siteNoteFor(entry.touched), () => activity.tidyHint()]) {
    try {
      const t = await part();
      if (t) extras.push(t);
    } catch {
      // 메모 · 안내를 못 읽어도 repl 결과는 그대로.
    }
  }
  if (failed) {
    try {
      const line = await activity.writeFailureNotice(failed.error);
      if (line) extras.push(line);
    } catch {
      // 안내조차 못 만들면 조용히 넘어간다.
    }
  }
  return extras;
}

/** 붙일 글을 하나씩 빈 줄로 이어 붙이되, 붙인 결과가 기존 출력 상한(16KB, 바이트)을 넘게 되는 것은 붙이지 않는다. */
function attachWithinCap(base: string, extras: string[]): string {
  let text = base;
  for (const extra of extras) {
    const next = text ? `${text}\n\n${extra}` : extra;
    if (Buffer.byteLength(next, "utf8") <= SNAPSHOT_LIMIT_BYTES) text = next;
  }
  return text;
}

export interface SafariServer {
  server: McpServer;
  /** 우리가 연 탭을 닫고 기억을 비운다(드라이버 자체는 닫지 않는다). */
  shutdown(): Promise<void>;
  /** REPL 코드에서 비롯된, 아무도 받지 않은 거부 · 오류를 해당 호출 출력에 알린다(ReplSession.handleStray). */
  handleStray(reason: unknown, kind: "rejection" | "exception"): boolean;
  /** 기억 폴더(하루 기록 · 사이트 메모 · 프로젝트 …). */
  home: MemoryHome;
  /** 대화 상태 · 하루 기록 · 사이트 메모 붙이기 · 정리 안내. 도구 호출이 시작될 때 touch() 를 부른다. */
  activity: ActivityLog;
}

/**
 * home · now 는 시험에서 임시 폴더 · 가짜 시계를 끼우는 자리다. 기본은 resolveHome() 의 기억 폴더와 진짜 시계.
 */
export function createSafariServer(driver: SafariDriver, opts: { home?: MemoryHome; now?: () => Date } = {}): SafariServer {
  const home = opts.home ?? new MemoryHome(resolveHome().dir);
  const activity = new ActivityLog(home, opts.now);
  const session = createReplSession(driver);
  const server = new McpServer({ name: "safari-attraction", version: VERSION });

  server.registerTool(
    "repl",
    {
      title: "사파리 자바스크립트 실행",
      description: REPL_DESCRIPTION,
      inputSchema: {
        title: z.string().describe("이 호출이 하는 일을 한 줄로(예: '서울특별시 문서 읽기')"),
        code: z.string().describe("실행할 자바스크립트(최상위 await 가능)"),
      },
    },
    async ({ title, code }) => {
      activity.touch();
      const r = await session.run(code);
      // display() 로 붙인 이미지는 글 뒤에 붙는다(오류로 끝나도 그 전에 붙인 것은 남는다).
      const images = (r.images ?? []).map((data) => ({ type: "image" as const, data, mimeType: "image/png" }));
      const err = r.error === undefined ? undefined : toKorean(r.error, r.errorCode);
      const base = err === undefined ? r.output : r.output ? `${r.output}\n\n오류: ${err}` : `오류: ${err}`;
      const extras = await memoryExtras(activity, { title, touched: r.touched ?? [], ok: err === undefined, error: err });
      const text = attachWithinCap(base, extras);
      if (err === undefined) return { content: [{ type: "text" as const, text }, ...images] };
      return { isError: true, content: [{ type: "text" as const, text }, ...images] };
    },
  );

  server.registerTool(
    "status",
    { title: "사파리 연결 상태", description: STATUS_DESCRIPTION, inputSchema: {} },
    async () => {
      activity.touch();
      return { content: [{ type: "text", text: formatDoctor(await runDoctor(driver)) }] };
    },
  );

  return { server, home, activity, shutdown: () => session.dispose(), handleStray: (reason, kind) => session.handleStray(reason, kind) };
}
