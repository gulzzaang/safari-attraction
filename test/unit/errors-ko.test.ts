import { describe, expect, test } from "vitest";
import { toKorean } from "../../src/errors-ko.js";
import { SafariError, type SafariErrorCode } from "../../src/driver/types.js";

describe("toKorean(오류 → 한국어 안내)", () => {
  test("설정 꺼짐 오류를 한국어 안내로 바꾼다", () => {
    expect(toKorean(new SafariError("JS_FROM_APPLE_EVENTS_OFF", "원문"))).toContain("사파리 설정 → 개발자 → 'Apple 이벤트의 JavaScript 허용'");
  });

  test("자동화 거부는 시스템 설정 경로를 알려 준다", () => {
    expect(toKorean(new SafariError("AUTOMATION_DENIED", "원문"))).toContain("시스템 설정 → 개인정보 보호 및 보안 → 자동화");
  });

  test("모든 코드가 안내를 가지고 원문도 함께 남긴다", () => {
    const codes: SafariErrorCode[] = ["TAB_CLOSED", "ALERT_BLOCKED", "JS_FROM_APPLE_EVENTS_OFF", "AUTOMATION_DENIED", "SAFARI_NOT_RUNNING", "TIMEOUT", "SCREEN_CAPTURE_DENIED", "WINDOW_CLOSED", "ACTION_DENIED", "NOT_ALLOWED", "SAFARI_ERROR"];
    for (const c of codes) {
      const t = toKorean(new SafariError(c, "원문-메시지"));
      expect(t).toContain("원문-메시지");
      expect(t.length).toBeGreaterThan("원문-메시지".length + 8);
    }
  });

  test("화면 찍기 권한 · 닫힌 AI 창은 정해 둔 한국어 안내", () => {
    expect(toKorean(new SafariError("SCREEN_CAPTURE_DENIED", "원문"))).toContain(
      "화면 찍기 권한이 없어요. 시스템 설정 → 개인정보 보호 및 보안 → 화면 및 시스템 오디오 녹음에서 Claude 를 띄운 앱(터미널 · Claude 등)을 켜고, 그 앱을 다시 켜 주세요.",
    );
    expect(toKorean(new SafariError("WINDOW_CLOSED", "원문"))).toContain("AI 전용 창이 닫혔어요. openAiWindow() 로 다시 열 수 있어요.");
  });

  test("사람 없이 도는 일의 안내: 사파리 꺼짐 · 새 창 금지", () => {
    expect(toKorean(new SafariError("SAFARI_NOT_RUNNING", "원문"))).toContain("사람 없이 도는 일은 사파리를 켜지 않아요");
    expect(toKorean(new SafariError("NOT_ALLOWED", "원문"))).toContain("사람 없이 도는 일");
  });

  test("사파리 오류가 아니면 메시지를 그대로", () => {
    expect(toKorean(new Error("앗"))).toBe("앗");
    expect(toKorean("그냥 글")).toBe("그냥 글");
  });

  test("코드와 메시지 글로도 부른다(REPL 이 돌려준 오류)", () => {
    expect(toKorean("원문", "AUTOMATION_DENIED")).toContain("자동화");
  });
});
