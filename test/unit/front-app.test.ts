import { describe, expect, test } from "vitest";
import { SAFARI_BUNDLE_ID, parseBundleId, safariCameForward } from "../../src/driver/jxa-driver.js";

describe("사파리가 맨 앞으로 나왔는가(safariCameForward)", () => {
  const FINDER = "com.apple.finder";
  const LOCK = "com.apple.loginwindow";
  test("다른 앱 → 사파리면 나온 것", () => {
    expect(safariCameForward(FINDER, SAFARI_BUNDLE_ID)).toBe(true);
    expect(safariCameForward("", SAFARI_BUNDLE_ID)).toBe(true);
  });
  test("사파리가 이미 맨 앞이었다면 아니다", () => {
    expect(safariCameForward(SAFARI_BUNDLE_ID, SAFARI_BUNDLE_ID)).toBe(false);
  });
  test("다른 앱이 앞으로 나온 것(화면 잠금 해제 등)은 사파리가 나온 게 아니다", () => {
    expect(safariCameForward(LOCK, FINDER)).toBe(false);
    expect(safariCameForward(FINDER, LOCK)).toBe(false);
    expect(safariCameForward(SAFARI_BUNDLE_ID, FINDER)).toBe(false);
  });
  test("알 수 없는 값(빈 글)이면 사파리가 나왔다고 하지 않는다", () => {
    expect(safariCameForward(FINDER, "")).toBe(false);
    expect(safariCameForward("", "")).toBe(false);
  });
});

describe("lsappinfo 출력에서 번들 아이디 뽑기(parseBundleId)", () => {
  test("두 가지 출력 모양", () => {
    expect(parseBundleId('"CFBundleIdentifier"="com.apple.Safari"\n')).toBe("com.apple.Safari");
    expect(parseBundleId('[ NULL ]  ASN:0x0-0x1a01a: (in front)\n    bundleID="com.apple.finder"\n')).toBe("com.apple.finder");
  });
  test("없으면 빈 글", () => {
    expect(parseBundleId("")).toBe("");
    expect(parseBundleId('"LSDisplayName"="Finder"')).toBe("");
  });
});
