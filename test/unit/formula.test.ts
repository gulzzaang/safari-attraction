import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { VERSION } from "../../src/version.js";

const formula = readFileSync(new URL("../../Formula/safari-attraction.rb", import.meta.url), "utf8");

describe("홈브루 formula(글 검사)", () => {
  test("태그가 VERSION 과 같다", () => {
    expect(formula).toContain(`tag: "v${VERSION}"`);
  });

  test("node 에 기댄다", () => {
    expect(formula).toContain('depends_on "node"');
  });

  test("등록 경로는 버전이 든 Cellar 경로가 아니라 opt 경로다(업그레이드해도 살아 있음)", () => {
    expect(formula).toContain("opt_bin}/safari-attraction");
    expect(formula).toContain("SAFARI_ATTRACTION_BIN");
  });

  test("번들과 jxa 호스트를 libexec 에 둔다", () => {
    expect(formula).toContain('libexec.install "plugin/server.mjs"');
    expect(formula).toContain('libexec/"jxa"');
    expect(formula).toContain("plugin/jxa/host.js");
  });

  test("한국어 안내와 맥 전용 표시", () => {
    expect(formula).toContain("safari-attraction setup");
    expect(formula).toContain("safari-attraction doctor");
    expect(formula).toContain("depends_on :macos");
  });
});
