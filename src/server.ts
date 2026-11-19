import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SafariError, type SafariDriver } from "./driver/types.js";
import { GUIDE_KO, toKorean } from "./errors-ko.js";
import { createReplSession } from "./repl/context.js";

export const REPL_DESCRIPTION = `사용자의 진짜 사파리(로그인된 그대로)를 자바스크립트로 조작한다. 새 탭은 뒤쪽 탭으로 열려 사용자 화면을 가로채지 않는다.
Drive the user's real, logged-in Safari with JavaScript. New tabs open in the background and never take the user's screen.

값은 console.log 로 찍어야 보인다(마지막 식의 값은 안 찍힌다). 오류는 isError 로 온다.
Read values with console.log (the last expression is NOT printed). Errors come back with isError.

전역 / Globals:
- openTab(url) → Page. 뒤쪽 탭을 열고 다 뜰 때까지 기다린다. 열린 탭은 \`page\`(현재)와 \`tabs\`(배열)에 들어간다.
- attachActiveBrowserTab() → 사용자가 지금 보고 있는 맨 앞 창의 활성 탭. "내가 보고 있는 페이지" 라고 할 때 쓴다. attachBrowserTab(key) / listBrowserTabs() 로 다른 탭도 고른다. 사용자의 탭은 떼기만 하고 닫지 않는다.
- closeTab(page?) — 우리가 연 탭만 닫는다. 서버가 끝나면 우리가 연 탭은 모두 닫힌다.
- snapshot(page?, {interactive, selector, full}) — 페이지를 읽는다. console.log(await snapshot()) 로 찍으면 "지난번과 바뀐 곳만" 나오고, 처음이거나 같으면 전체 · 「변화 없음」이 나온다. 요소 앞의 e12 같은 ref 를 locator(ref) 에 쓴다. 16KB 를 넘으면 잘린다.
- Page: goto(url), url(), title(), waitForLoadState(), evaluate(fn | 식, arg), locator(ref | CSS).click() / .fill(값) / .textContent(), keyboard.press("Enter") / keyboard.type(글).
- fetch(url, init) → {status, ok, headers(보통 객체), text(), json()}. 현재 page 안에서 돌아 그 페이지의 쿠키로 나가고 CORS · CSP 를 따른다.
- sleep(ms), URL, URLSearchParams, structuredClone, TextEncoder/Decoder, atob/btoa.

규칙 / Rules:
- 최상위 await 가 되고, const · let · 함수는 다음 호출에도 남는다. 그래서 호출마다 새 변수 이름을 쓴다(같은 이름을 다시 쓰면 지난 값이 덮어써져 헷갈린다).
  Top-level await works; declarations persist across calls, so use NEW variable names each call.
- 한 호출에 여러 단계를 넣어도 된다(열기 → 입력 → 읽기). 호출 수를 줄여라.
- 페이지가 바뀐 뒤 같은 snapshot 을 다시 읽으면 바뀐 곳만 찍힌다. 전체가 필요하면 snapshot(page, {full: true}).
- 호출은 120초 안에 끝나야 한다. 입력 · 클릭은 진짜 마우스 · 키보드가 아니라 페이지 안 이벤트로 보내진다.

알려진 한계 / Known limits:
- 읽기(snapshot)는 iframe 안과 shadow DOM 안을 읽지 못한다. Reading skips iframes and shadow DOM.
- evaluate 는 함수 하나나 식 하나만 받는다(여러 문장은 함수로 감싼다). 결과는 JSON 으로 오가 DOM · 함수는 못 받는다. 바깥 변수는 못 쓰고 arg 로 넘긴다.
- await 뒤에서 이벤트 루프를 막는 코드(예: await x; while(true){})는 서버를 멈출 수 있다. 쓰지 말 것.
- 사파리 스크립트는 개인정보 보호 창과 일반 창을 구별하지 못해, 맨 앞 창을 그대로 쓴다. 개인정보 보호 창이 앞에 있으면 거기에 열릴 수 있다.
- 화면 찍기 · display() 는 아직 없다(계획 2). Screenshots and display() come in plan 2.
- 처음 쓸 때 설정이 막히면 오류 글에 안내가 나온다. status 도구로 설정 상태를 볼 수 있다.`;

export const STATUS_DESCRIPTION =
  "사파리 연결 상태를 한국어로 알려 준다 — 사파리 켜짐, 창 수, 「Apple 이벤트의 JavaScript 허용」, 자동화 허락. 막혔을 때 먼저 부른다. 빈 탭을 잠깐 열었다 닫는다. / Reports Safari connection status.";

export interface SafariServer {
  server: McpServer;
  /** 우리가 연 탭을 닫고 기억을 비운다(드라이버 자체는 닫지 않는다). */
  shutdown(): Promise<void>;
  /** REPL 코드에서 비롯된, 아무도 받지 않은 거부 · 오류를 해당 호출 출력에 알린다(ReplSession.handleStray). */
  handleStray(reason: unknown, kind: "rejection" | "exception"): boolean;
}

/** status 도구의 본문: 한국어 줄 목록. 사파리를 켜지 않고, 연 탭은 반드시 닫는다. */
async function statusText(driver: SafariDriver): Promise<string> {
  const lines: string[] = [];
  let windows;
  try {
    windows = await driver.listWindows();
  } catch (e) {
    if (e instanceof SafariError && e.code === "SAFARI_NOT_RUNNING") {
      return ["사파리: 꺼짐", GUIDE_KO.SAFARI_NOT_RUNNING].join("\n");
    }
    if (e instanceof SafariError && e.code === "AUTOMATION_DENIED") {
      return ["사파리: 켜짐(조작 허락 안 됨)", "자동화 허락: 거부", toKorean(e)].join("\n");
    }
    return ["사파리: 알 수 없음", toKorean(e)].join("\n");
  }
  lines.push("사파리: 켜짐", `창: ${windows.length}개`, "자동화 허락: 됨");

  let tabKey: string | undefined;
  try {
    const { tab, frontAppChanged } = await driver.openTab("about:blank");
    tabKey = tab.key;
    const v = await driver.runJs(tab.key, "1+1");
    if (v.trim() === "2") lines.push("Apple 이벤트의 JavaScript 허용: 켜짐");
    else lines.push(`Apple 이벤트의 JavaScript 허용: 알 수 없음(시험 값 ${JSON.stringify(v)})`);
    if (frontAppChanged) lines.push("주의: 탭을 여는 동안 맨 앞 앱이 바뀌었어요.");
  } catch (e) {
    if (e instanceof SafariError && e.code === "JS_FROM_APPLE_EVENTS_OFF") {
      lines.push("Apple 이벤트의 JavaScript 허용: 꺼짐", toKorean(e));
    } else if (e instanceof SafariError && e.code === "AUTOMATION_DENIED") {
      lines[lines.indexOf("자동화 허락: 됨")] = "자동화 허락: 거부";
      lines.push(toKorean(e));
    } else {
      lines.push("Apple 이벤트의 JavaScript 허용: 확인 못 함", toKorean(e));
    }
  } finally {
    if (tabKey) {
      try {
        await driver.closeTab(tabKey);
      } catch (e) {
        if (!(e instanceof SafariError && e.code === "TAB_CLOSED")) lines.push(`주의: 시험용 빈 탭을 닫지 못했어요(${toKorean(e)})`);
      }
    }
  }
  return lines.join("\n");
}

export function createSafariServer(driver: SafariDriver): SafariServer {
  const session = createReplSession(driver);
  const server = new McpServer({ name: "safari-attraction", version: "0.1.0" });

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
    async ({ code }) => {
      const r = await session.run(code);
      if (r.error === undefined) return { content: [{ type: "text", text: r.output }] };
      const err = toKorean(r.error, r.errorCode);
      return { isError: true, content: [{ type: "text", text: r.output ? `${r.output}\n\n오류: ${err}` : `오류: ${err}` }] };
    },
  );

  server.registerTool(
    "status",
    { title: "사파리 연결 상태", description: STATUS_DESCRIPTION, inputSchema: {} },
    async () => ({ content: [{ type: "text", text: await statusText(driver) }] }),
  );

  return { server, shutdown: () => session.dispose(), handleStray: (reason, kind) => session.handleStray(reason, kind) };
}
