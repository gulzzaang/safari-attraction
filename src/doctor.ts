import { SafariError, type SafariDriver } from "./driver/types.js";
import { GUIDE_KO, toKorean } from "./errors-ko.js";

/** 점검 항목 하나. fix 는 사용자가 직접 할 일(여러 줄이면 줄바꿈으로 나눈다). */
export interface DoctorItem {
  name: string;
  state: "ok" | "off" | "unknown";
  detail?: string;
  fix?: string;
}

export interface DoctorReport {
  items: DoctorItem[];
}

const FIX_SAFARI_RUN = "사파리를 켜 두세요. 꺼져 있으면 Claude 가 처음 쓸 때 뒤에서 켭니다.";
const FIX_AUTOMATION = "시스템 설정 → 개인정보 보호 및 보안 → 자동화 → (Claude 를 띄운 앱) 아래 Safari 켜기";
const FIX_JS_FROM_APPLE_EVENTS =
  "사파리 → 설정 → 고급 → '웹 개발자용 기능 보기' 켜기 → 메뉴 막대 개발 → 'Apple 이벤트의 JavaScript 허용' 켜기\n" +
  "이 설정은 이 맥의 다른 프로그램도 Apple 이벤트로 사파리 페이지에 자바스크립트를 넣을 수 있게 합니다. 믿는 프로그램만 자동화를 허락하세요.";
const FIX_SCREEN_CAPTURE = `${GUIDE_KO.SCREEN_CAPTURE_DENIED} 찍기를 안 쓰면 꺼 둬도 됩니다.`;
const SAFARI_OFF_DETAIL = "사파리가 꺼져 있어 확인 못 함";

const N_RUN = "사파리 실행";
const N_AUTOMATION = "자동화 허락";
const N_JS = "Apple 이벤트의 JavaScript 허용";
const N_SCREEN = "화면 기록(찍기용)";

const isCode = (e: unknown, code: SafariError["code"]) => e instanceof SafariError && e.code === code;

/**
 * 빠진 준비를 점검한다. 사파리를 켜지 않고, 빈 탭을 잠깐 열어 1+1 을 시험한 뒤 어떤 길로 끝나든 그 탭을 닫는다.
 * MCP 서버에 기대지 않는다(계획 3 의 `safari-attraction doctor` 명령이 같은 함수를 쓴다).
 */
export async function runDoctor(driver: SafariDriver): Promise<DoctorReport> {
  const run: DoctorItem = { name: N_RUN, state: "ok" };
  const automation: DoctorItem = { name: N_AUTOMATION, state: "ok" };
  const js: DoctorItem = { name: N_JS, state: "unknown" };
  const screen: DoctorItem = { name: N_SCREEN, state: "ok" };

  const deniedAutomation = () => {
    automation.state = "off";
    automation.fix = FIX_AUTOMATION;
    js.state = "unknown";
    js.detail = "자동화 허락이 없어 확인 못 함";
  };

  let windows: number | undefined;
  try {
    windows = (await driver.listWindows()).length;
    run.detail = `창 ${windows}개`;
  } catch (e) {
    if (isCode(e, "SAFARI_NOT_RUNNING")) {
      run.state = "off";
      run.detail = "꺼져 있음";
      run.fix = FIX_SAFARI_RUN;
      automation.state = "unknown";
      automation.detail = SAFARI_OFF_DETAIL;
      js.detail = SAFARI_OFF_DETAIL;
    } else if (isCode(e, "AUTOMATION_DENIED")) {
      deniedAutomation();
    } else {
      automation.state = "unknown";
      automation.detail = toKorean(e);
      js.detail = "사파리 상태를 확인하지 못해 확인 못 함";
    }
  }

  if (windows !== undefined) {
    let tabKey: string | undefined;
    try {
      const { tab, frontAppChanged } = await driver.openTab("about:blank");
      tabKey = tab.key;
      const v = await driver.runJs(tab.key, "1+1");
      if (v.trim() === "2") {
        js.state = "ok";
        if (frontAppChanged) js.detail = "주의: 탭을 여는 동안 사파리가 맨 앞으로 나왔어요";
      } else {
        js.detail = `시험 값이 예상과 달라 확인 못 함(${JSON.stringify(v)})`;
      }
    } catch (e) {
      if (isCode(e, "JS_FROM_APPLE_EVENTS_OFF")) {
        js.state = "off";
        js.fix = FIX_JS_FROM_APPLE_EVENTS;
      } else if (isCode(e, "AUTOMATION_DENIED")) {
        deniedAutomation();
      } else {
        js.detail = toKorean(e);
      }
    } finally {
      if (tabKey) {
        try {
          await driver.closeTab(tabKey);
        } catch (e) {
          if (!isCode(e, "TAB_CLOSED")) {
            const note = `주의: 시험용 빈 탭을 닫지 못했어요(${toKorean(e)})`;
            js.detail = js.detail ? `${js.detail} / ${note}` : note;
          }
        }
      }
    }
  }

  try {
    if (!(await driver.screenCaptureAllowed())) {
      screen.state = "off";
      screen.fix = FIX_SCREEN_CAPTURE;
    }
  } catch (e) {
    screen.state = "unknown";
    screen.detail = `확인하지 못했어요(${e instanceof Error ? e.message : String(e)})`;
  }

  return { items: [run, automation, js, screen] };
}

const MARK: Record<DoctorItem["state"], string> = { ok: "✓", off: "✗", unknown: "?" };

/** 줄마다 ✓ / ✗ / ? + 이름 + (설명), 아래에 들여쓴 고칠 곳. 모두 ok 면 마지막에 「준비 끝」 한 줄. */
export function formatDoctor(r: DoctorReport): string {
  const lines: string[] = [];
  for (const it of r.items) {
    lines.push(`${MARK[it.state]} ${it.name}${it.detail ? ` (${it.detail})` : ""}`);
    if (it.fix) for (const f of it.fix.split("\n")) lines.push(`  ${f}`);
  }
  if (r.items.every((i) => i.state === "ok")) lines.push("준비 끝 — 바로 쓰면 됩니다");
  return lines.join("\n");
}
