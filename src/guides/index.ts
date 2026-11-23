import { domainToUnicode } from "node:url";
import { siteLookupChain } from "../memory/site.js";
import { GUIDES } from "./sites/index.js";
import type { SiteGuide } from "./types.js";

export type { SiteGuide } from "./types.js";
export { GUIDES } from "./sites/index.js";

/** 안내서 요약 글자 수 상한. */
export const GUIDE_SUMMARY_MAX = 400;
/** 안내서 전체(요약 + 본문) UTF-8 바이트 상한. */
export const GUIDE_BYTES_MAX = 6000;

/**
 * 주소나 호스트를 받아 소문자 · 포트 · 앞의 `www.` / `m.` 를 뗀 호스트로. 읽을 수 없으면 null.
 * 스킴이 없어도 된다(`localhost:3000`, `search.naver.com/x`).
 */
export function normalizeHost(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  let host: string;
  try {
    host = new URL(s.includes("://") ? s : `http://${s}`).hostname;
  } catch {
    return null;
  }
  host = host.toLowerCase().replace(/\.$/, "");
  // 글자 · 숫자 · . · - 로 된 호스트만(이모지 · IPv6 · 빈 값은 걸러낸다).
  if (!host || !/^[\p{L}\p{N}.-]+$/u.test(domainToUnicode(host))) return null;
  for (const prefix of ["www.", "m."]) {
    // 떼고 나서도 점이 남을 때만(m.com 이 com 이 되지 않게).
    if (host.startsWith(prefix) && host.slice(prefix.length).includes(".")) host = host.slice(prefix.length);
  }
  return host;
}

/** 정확한 호스트 → 위 도메인 순(`siteLookupChain` 과 같은 두 단계 끝말 규칙)으로 첫 짝. */
export function guideForHost(host: string, guides: SiteGuide[] = GUIDES): SiteGuide | null {
  const h = normalizeHost(host);
  if (!h) return null;
  for (const file of siteLookupChain(h)) {
    const cand = file.replace(/\.md$/, "");
    const hit = guides.find((g) => g.hosts.includes(cand));
    if (hit) return hit;
  }
  return null;
}

/** 주소 · 호스트 아무거나로 안내서를 찾는다. */
export function guideFor(target: string, guides: SiteGuide[] = GUIDES): SiteGuide | null {
  return guideForHost(target, guides);
}

/** 안내서 전체 글. */
export function fullText(g: SiteGuide): string {
  return `# ${g.name}\n\n## 요약\n${g.summary}\n\n${g.body}\n\n확인한 날: ${g.checked}`;
}

/** 안내서 목록: 한 줄에 `이름 — 호스트들`. */
export function listGuides(guides: SiteGuide[] = GUIDES): string {
  return guides.map((g) => `${g.name} — ${g.hosts.join(", ")}`).join("\n");
}
