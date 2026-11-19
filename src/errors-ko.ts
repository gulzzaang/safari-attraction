import { SafariError, type SafariErrorCode } from "./driver/types.js";

/** 사용자가 직접 해야 하는 일을 한국어로 알려 주는 안내(코드별). 원문 오류는 뒤에 덧붙인다. */
export const GUIDE_KO: Record<SafariErrorCode, string> = {
  JS_FROM_APPLE_EVENTS_OFF:
    "사파리가 페이지에서 자바스크립트를 돌리는 것을 막고 있어요. 사파리 설정 → 개발자 → 'Apple 이벤트의 JavaScript 허용' 을 켜 주세요. " +
    "(개발자 항목이 안 보이면 사파리 설정 → 고급 → '웹 개발자용 기능 보기' 를 먼저 켜세요.)",
  AUTOMATION_DENIED:
    "이 앱이 사파리를 조작하도록 허락받지 못했어요. 시스템 설정 → 개인정보 보호 및 보안 → 자동화 에서 이 서버를 실행한 앱(터미널 · Claude 등)의 Safari 를 켜 주세요. " +
    "허락 창이 한 번 떴는데 거부했다면 이 목록에서 다시 켜야 해요.",
  SAFARI_NOT_RUNNING: "사파리가 꺼져 있어요. 사파리를 켜 주세요(openTab 은 사파리를 뒤에서 켜 보지만, 켜지 못하면 직접 켜야 해요).",
  TAB_CLOSED: "그 탭이 이미 닫혔거나 사라졌어요. listBrowserTabs() 로 지금 있는 탭을 보고 openTab · attachBrowserTab 으로 다시 여세요.",
  ALERT_BLOCKED: "그 탭에 경고창(alert · confirm · 인쇄 창 등)이 떠서 사파리가 답하지 못해요. 사파리에서 그 창을 닫아 주세요.",
  TIMEOUT: "시간 안에 끝나지 않았어요. 페이지가 느리거나 사파리가 바쁜 것일 수 있으니 잠시 뒤 다시 해 보세요.",
  SCREEN_CAPTURE_DENIED:
    "화면 찍기 권한이 없어요. 시스템 설정 → 개인정보 보호 및 보안 → 화면 및 시스템 오디오 녹음에서 Claude 를 띄운 앱(터미널 · Claude 등)을 켜고, 그 앱을 다시 켜 주세요.",
  WINDOW_CLOSED: "AI 전용 창이 닫혔어요. openAiWindow() 로 다시 열 수 있어요.",
  SAFARI_ERROR: "사파리가 오류를 돌려줬어요.",
};

/**
 * 오류를 Claude 와 사용자가 읽을 한국어 안내로 바꾼다. SafariError 는 「안내 + 원문」, 그 밖의 오류는 메시지 그대로.
 * 두 번째 인자 code 는 이미 글로 바뀐 오류(REPL 결과의 error 글)에 코드만 따로 올 때 쓴다.
 */
export function toKorean(err: unknown, code?: SafariErrorCode): string {
  const c: SafariErrorCode | undefined = err instanceof SafariError ? err.code : code;
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
  if (!c) return msg;
  return `${GUIDE_KO[c]}\n(원문: ${msg})`;
}
