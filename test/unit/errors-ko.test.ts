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
    const codes: SafariErrorCode[] = ["TAB_CLOSED", "ALERT_BLOCKED", "JS_FROM_APPLE_EVENTS_OFF", "AUTOMATION_DENIED", "SAFARI_NOT_RUNNING", "TIMEOUT", "SCREEN_CAPTURE_DENIED", "WINDOW_CLOSED", "SAFARI_ERROR"];
    for (const c of codes) {
      const t = toKorean(new SafariError(c, "원문-메시지"));
      expect(t).toContain("원문-메시지");
      expect(t.length).toBeGreaterThan("원문-메시지".length + 8);
    }
  });

  test("사파리 오류가 아니면 메시지를 그대로", () => {
    expect(toKorean(new Error("앗"))).toBe("앗");
    expect(toKorean("그냥 글")).toBe("그냥 글");
  });

  test("코드와 메시지 글로도 부른다(REPL 이 돌려준 오류)", () => {
    expect(toKorean("원문", "AUTOMATION_DENIED")).toContain("자동화");
  });
});
