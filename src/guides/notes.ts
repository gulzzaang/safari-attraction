import type { Touch } from "../memory/activity.js";
import { GUIDES, GUIDE_SUMMARY_MAX, fullText, guideFor, listGuides, type SiteGuide } from "./index.js";

/** 한 호출에 요약을 붙이는 안내서 수(나머지는 이름만 한 줄로). */
export const GUIDE_NOTES_MAX = 2;

const oneLine = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= max ? flat : chars.slice(0, max - 1).join("") + "…";
};

/**
 * 이번 호출에서 닿은 곳(`touched` 순서)의 안내서 중 이번 대화에 아직 안 보인 것을 응답 끝에 붙일 글로.
 * 앞 두 편은 `… 이 사이트 안내(<이름>): <요약> — 자세히는 guide()` 한 줄씩, 셋째부터는 한 줄 `… 안내서 있음: <이름> · <이름> — guide("주소")`.
 * 글만 만들고 「보였음」(`seen`, 열쇠는 안내서 id)은 commit() 이 한다 — 요약을 실제로 붙인 편만. 붙일 것이 없으면 null.
 * 파일을 읽지 않으니 기억 폴더 · 2초 상한과 무관하다.
 */
export function planGuideNotes(
  touched: Touch[],
  seen: Set<string>,
  guides: SiteGuide[] = GUIDES,
): { text: string; commit: () => void } | null {
  const fresh: SiteGuide[] = [];
  for (const t of touched) {
    if (/^(about|file|data|blob):/i.test(t.url)) continue;
    const g = guideFor(t.url, guides);
    if (!g || seen.has(g.id) || fresh.some((f) => f.id === g.id)) continue;
    fresh.push(g);
  }
  if (fresh.length === 0) return null;
  const shown = fresh.slice(0, GUIDE_NOTES_MAX);
  const rest = fresh.slice(GUIDE_NOTES_MAX);
  const lines = shown.map((g) => `… 이 사이트 안내(${g.name}): ${oneLine(g.summary, GUIDE_SUMMARY_MAX)} — 자세히는 guide()`);
  if (rest.length > 0) lines.push(`… 안내서 있음: ${rest.map((g) => g.name).join(" · ")} — guide("주소")`);
  return {
    text: lines.join("\n"),
    commit: () => {
      for (const g of shown) seen.add(g.id);
    },
  };
}

/** 목록 글. 안내서가 하나도 없으면 빈 줄 대신 한 마디. */
function listOrNone(guides: SiteGuide[]): string {
  return guides.length > 0 ? listGuides(guides) : "(아직 안내서가 하나도 없어요)";
}

/**
 * repl 의 `guide(target?)` 가 돌려주는 글. 던지지 않는다.
 * target 이 없으면(undefined · null · 빈 글) `currentUrl`(지금 page 주소)을 쓴다.
 */
export function guideAnswer(target: unknown, currentUrl: () => string | null | undefined, guides: SiteGuide[] = GUIDES): string {
  try {
    let addr = target === undefined || target === null ? "" : String(target).trim();
    if (addr === "") {
      let url: string | null | undefined;
      try {
        url = currentUrl();
      } catch {
        url = null;
      }
      addr = (url ?? "").trim();
      if (addr === "" || /^about:blank/i.test(addr)) {
        return `지금 열린 사이트가 없어요 — guide("coupang.com") 처럼 주소를 넣어 주세요\n${listOrNone(guides)}`;
      }
    }
    const g = guideFor(addr, guides);
    if (g) return fullText(g);
    return `이 사이트 안내서는 아직 없어요 — 있는 곳:\n${listOrNone(guides)}`;
  } catch {
    return `이 사이트 안내서는 아직 없어요 — 있는 곳:\n${listOrNone(guides)}`;
  }
}
