import { describe, expect, test } from "vitest";
import { formatDoctor, runDoctor } from "../../src/doctor.js";
import { GUIDE_KO } from "../../src/errors-ko.js";
import { SafariError } from "../../src/driver/types.js";
import { createFakeDriver } from "../helpers/fake-driver.js";

const NAMES = ["사파리 실행", "자동화 허락", "Apple 이벤트의 JavaScript 허용", "화면 기록(찍기용)"];
const FIX_RUN = "사파리를 켜 두세요. 꺼져 있으면 Claude 가 처음 쓸 때 뒤에서 켭니다.";
const FIX_AUTOMATION = "시스템 설정 → 개인정보 보호 및 보안 → 자동화 → (Claude 를 띄운 앱) 아래 Safari 켜기";
const FIX_JS_1 = "사파리 → 설정 → 고급 → '웹 개발자용 기능 보기' 켜기 → 메뉴 막대 개발 → 'Apple 이벤트의 JavaScript 허용' 켜기";
const FIX_JS_2 = "이 설정은 이 맥의 다른 프로그램도 Apple 이벤트로 사파리 페이지에 자바스크립트를 넣을 수 있게 합니다. 믿는 프로그램만 자동화를 허락하세요.";

function okDriver() {
  const d = createFakeDriver();
  d.answer = () => "2";
  return d;
}

describe("점검(runDoctor)", () => {
  test("모두 됨: 네 항목 순서와 이름, 모두 ok, 시험 탭은 닫는다", async () => {
    const d = okDriver();
    const r = await runDoctor(d);
    expect(r.items.map((i) => i.name)).toEqual(NAMES);
    expect(r.items.map((i) => i.state)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(d.calls.openTab).toEqual([{ url: "about:blank", windowId: undefined }]);
    expect(d.calls.closeTab).toEqual(["t1"]);
    const t = formatDoctor(r);
    expect(t.split("\n").slice(0, 4).map((l) => l.slice(0, 1))).toEqual(["✓", "✓", "✓", "✓"]);
    for (const n of NAMES) expect(t).toContain(n);
    expect(t.trimEnd().split("\n").at(-1)).toBe("준비 끝 — 바로 쓰면 됩니다");
  });

  test("사파리 꺼짐: 실행 off + 안내, 사파리가 필요한 둘은 unknown, 켜지 않는다, 화면 기록은 확인한다", async () => {
    const d = okDriver();
    d.listWindows = async () => {
      throw new SafariError("SAFARI_NOT_RUNNING", "꺼짐");
    };
    const r = await runDoctor(d);
    expect(r.items.map((i) => i.state)).toEqual(["off", "unknown", "unknown", "ok"]);
    expect(r.items[0]!.fix).toBe(FIX_RUN);
    expect(r.items[1]!.detail).toBe("사파리가 꺼져 있어 확인 못 함");
    expect(r.items[2]!.detail).toBe("사파리가 꺼져 있어 확인 못 함");
    expect(d.calls.openTab).toHaveLength(0);
    const t = formatDoctor(r);
    expect(t.split("\n")[0]!.startsWith("✗ 사파리 실행")).toBe(true);
    expect(t.split("\n")[2]!.startsWith("? 자동화 허락")).toBe(true);
    expect(t).toContain(`  ${FIX_RUN}`);
    expect(t).not.toContain("준비 끝");
  });

  test("자동화 거부(창 목록에서): 자동화 off + 안내, JS 는 unknown, 탭을 열지 않는다", async () => {
    const d = okDriver();
    d.listWindows = async () => {
      throw new SafariError("AUTOMATION_DENIED", "원문");
    };
    const r = await runDoctor(d);
    expect(r.items.map((i) => i.state)).toEqual(["ok", "off", "unknown", "ok"]);
    expect(r.items[1]!.fix).toBe(FIX_AUTOMATION);
    expect(d.calls.openTab).toHaveLength(0);
    expect(formatDoctor(r)).toContain(`  ${FIX_AUTOMATION}`);
  });

  test("자동화 거부(탭 열기에서): 자동화 off", async () => {
    const d = okDriver();
    d.openTab = async () => {
      throw new SafariError("AUTOMATION_DENIED", "원문");
    };
    const r = await runDoctor(d);
    expect(r.items.map((i) => i.state)).toEqual(["ok", "off", "unknown", "ok"]);
  });

  test("JS 꺼짐: 항목 off + 안내 두 문장, 열었던 탭은 닫는다", async () => {
    const d = createFakeDriver();
    d.answer = () => {
      throw new SafariError("JS_FROM_APPLE_EVENTS_OFF", "원문");
    };
    const r = await runDoctor(d);
    expect(r.items.map((i) => i.state)).toEqual(["ok", "ok", "off", "ok"]);
    expect(r.items[2]!.fix).toContain(FIX_JS_1);
    expect(r.items[2]!.fix).toContain(FIX_JS_2);
    expect(d.calls.closeTab).toEqual(["t1"]);
    const t = formatDoctor(r);
    expect(t).toContain(`  ${FIX_JS_1}`);
    expect(t).toContain(`  ${FIX_JS_2}`);
  });

  test("시험 값이 2 가 아니면 unknown", async () => {
    const d = createFakeDriver();
    d.answer = () => "엉뚱";
    const r = await runDoctor(d);
    expect(r.items[2]!.state).toBe("unknown");
    expect(d.calls.closeTab).toEqual(["t1"]);
  });

  test("화면 기록 없음: off + 오류 안내와 같은 글 + 꺼 둬도 된다는 말", async () => {
    const d = okDriver();
    d.screenAllowed = false;
    const r = await runDoctor(d);
    expect(r.items.map((i) => i.state)).toEqual(["ok", "ok", "ok", "off"]);
    expect(r.items[3]!.fix).toBe(`${GUIDE_KO.SCREEN_CAPTURE_DENIED} 찍기를 안 쓰면 꺼 둬도 됩니다.`);
    const t = formatDoctor(r);
    expect(t.split("\n")[3]!.startsWith("✗ 화면 기록(찍기용)")).toBe(true);
    expect(t).toContain("찍기를 안 쓰면 꺼 둬도 됩니다.");
    expect(t).not.toContain("준비 끝");
  });

  test("화면 기록 확인이 throw 하면 unknown", async () => {
    const d = okDriver();
    d.screenCaptureAllowed = async () => {
      throw new Error("호스트 응답 없음");
    };
    const r = await runDoctor(d);
    expect(r.items[3]!.state).toBe("unknown");
    expect(r.items[3]!.detail).toContain("호스트 응답 없음");
  });

  test("이 맥 상태(화면 기록만 없음): ✓ 셋 ✗ 하나", async () => {
    const d = okDriver();
    d.screenAllowed = false;
    const t = formatDoctor(await runDoctor(d));
    const marks = t.split("\n").filter((l) => /^[✓✗?]/.test(l)).map((l) => l[0]);
    expect(marks).toEqual(["✓", "✓", "✓", "✗"]);
  });

  test("시험 탭을 닫다 TAB_CLOSED 가 나도 오류 없이 끝난다", async () => {
    const d = okDriver();
    d.closeTab = async () => {
      throw new SafariError("TAB_CLOSED", "이미 닫힘");
    };
    const r = await runDoctor(d);
    expect(r.items[2]!.state).toBe("ok");
  });
});
