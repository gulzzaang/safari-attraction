import type { ActivityLog } from "./activity.js";
import { MemoryHome, nfc } from "./home.js";
import { bytes, cutBytes } from "./search.js";

/** 기억 · 프로젝트 도구 한 번 출력 상한(UTF-8 바이트). */
export const OUTPUT_MAX_BYTES = 8192;
const CONFLICT_SHOW = 3;
const CUT_NOTE = "… 8KB 를 넘는 부분은 줄였어요";

export type ToolResult = { text: string; isError?: boolean };

/** iCloud 충돌본(「이름 2.md」) 중 이번 호출이 읽거나 쓴 파일에 딸린 것. 알아낼 수 없으면 빈 목록. */
export async function conflictsOf(home: MemoryHome, files: string[]): Promise<string[]> {
  if (files.length === 0) return [];
  const touched = new Set(files.map(nfc));
  try {
    return (await home.conflicts()).filter((c) => touched.has(c) || touched.has(c.replace(/ \d+\.md$/, ".md")));
  } catch {
    return [];
  }
}

/**
 * 기억 · 프로젝트 도구 결과의 봉투: 열린 프로젝트가 있으면 첫 줄 「열린 프로젝트: 이름」, 끝에 충돌본 줄
 * 「충돌본이 있어요: … — 합쳐 주세요」(이번 호출이 다룬 파일 것만)과 정리 안내 한 줄(대화당 한 번, `skipTidyHint` 면 생략),
 * 전체는 8,192 바이트 이하. 첫 줄 · 끝 줄 몫을 먼저 떼고 본문 끝을 줄이므로 안내는 본문보다 먼저 잘리지 않는다.
 */
export async function composeResult(
  ctx: { home: MemoryHome; activity: ActivityLog },
  body: string,
  opts: { isError?: boolean; files?: string[]; skipTidyHint?: boolean } = {},
): Promise<ToolResult> {
  const head = ctx.activity.state.openProject ? `열린 프로젝트: ${ctx.activity.state.openProject}\n` : "";
  const found = await conflictsOf(ctx.home, opts.files ?? []);
  let tail = "";
  if (found.length > 0) {
    const shown = found.slice(0, CONFLICT_SHOW).join(", ") + (found.length > CONFLICT_SHOW ? ` 외 ${found.length - CONFLICT_SHOW}개` : "");
    tail = `\n충돌본이 있어요: ${shown} — 합쳐 주세요`;
  }
  if (!opts.skipTidyHint) {
    try {
      const hint = await ctx.activity.tidyHint();
      if (hint) tail += `\n${hint}`;
    } catch {
      // 안내를 못 만들어도 결과는 그대로.
    }
  }
  const room = OUTPUT_MAX_BYTES - bytes(head) - bytes(tail);
  let text = body;
  if (bytes(text) > room) {
    const note = `\n${CUT_NOTE}`;
    text = cutBytes(text, Math.max(0, room - bytes(note))) + note;
  }
  const out = head + text + tail;
  return opts.isError ? { text: out, isError: true } : { text: out };
}
