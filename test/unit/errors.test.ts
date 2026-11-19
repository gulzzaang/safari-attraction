import { describe, expect, test } from "vitest";
import { opError } from "../../src/driver/jxa-driver.js";
import { HostError, HostTimeoutError } from "../../src/driver/jxa-host.js";

describe("opError(사파리 오류 → SafariError 코드)", () => {
  test("Apple 이벤트 JavaScript 허용이 꺼진 오류(영어 · 한국어 문구)", () => {
    const en = new HostError(
      "Safari got an error: You must enable 'Allow JavaScript from Apple Events' in the Developer section of Safari Settings to use 'do JavaScript'.",
    );
    const ko = new HostError("Safari에서 오류가 발생했습니다: 'do JavaScript'를 사용하려면 Safari 설정의 개발자용 섹션에서 'Apple 이벤트에서 JavaScript 허용'을 켜야 합니다.");
    expect(opError("runJs", en).code).toBe("JS_FROM_APPLE_EVENTS_OFF");
    expect(opError("openTab", ko).code).toBe("JS_FROM_APPLE_EVENTS_OFF");
  });

  test("-1743 은 문구와 상관없이 AUTOMATION_DENIED", () => {
    expect(opError("listTabs", new HostError("알 수 없는 문구", -1743)).code).toBe("AUTOMATION_DENIED");
    expect(opError("listTabs", new HostError("Not authorized to send Apple events to Safari. (-1743)")).code).toBe("AUTOMATION_DENIED");
  });

  test("runJs · closeTab 의 -1728 과 「대상체를 가져올 수 없습니다」는 TAB_CLOSED", () => {
    expect(opError("runJs", new HostError("x", -1728)).code).toBe("TAB_CLOSED");
    expect(opError("closeTab", new HostError("대상체를 가져올 수 없습니다.")).code).toBe("TAB_CLOSED");
    expect(opError("runJs", new HostError("Can't get object.")).code).toBe("TAB_CLOSED");
    expect(opError("listTabs", new HostError("x", -1728)).code).toBe("SAFARI_ERROR");
  });

  test("꺼진 사파리 · 시간 초과 · 그 밖", () => {
    expect(opError("listTabs", new HostError("사파리가 꺼져 있음", undefined, "SAFARI_NOT_RUNNING")).code).toBe("SAFARI_NOT_RUNNING");
    expect(opError("runJs", new HostTimeoutError("runJs", 3000)).code).toBe("ALERT_BLOCKED");
    expect(opError("openTab", new HostTimeoutError("openTab", 3000)).code).toBe("TIMEOUT");
    expect(opError("listTabs", new HostError("뭔가 잘못됨")).code).toBe("SAFARI_ERROR");
  });
});
