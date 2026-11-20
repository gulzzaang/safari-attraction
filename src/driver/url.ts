/**
 * 주소 비교용 정규화. 기록한 주소는 출처에 따라 꼴이 조금 다를 수 있다 — 사파리 목록의 tab.url() · 문서 자신의 location.href ·
 * 우리가 적어 둔 값. `https://a.com` 과 `https://a.com/`, 한글 그대로와 %EA… 로 인코딩한 꼴, %ea 와 %EA 를 같은 주소로 본다.
 * 해석할 수 없는 글(about:blank 처럼 URL 이 되는 건 그대로 정규화되고, 그 밖의 이상한 글)은 글 그대로 둔다.
 */
export function normalizeUrl(u: string): string {
  let out = u;
  try {
    out = new URL(u).href;
  } catch {
    // 해석 못 하면 그대로
  }
  return out.replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase());
}

/** 두 주소가 같은 주소인가(정규화해서). */
export function sameUrl(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a === b || normalizeUrl(a) === normalizeUrl(b);
}

/** 같은 주소의 여러 꼴(기록한 그대로 · 정규화) — 사파리 쪽 비교(tab.url() · location.href)에 후보로 보낸다. 빈 값은 뺀다. */
export function urlForms(urls: Array<string | undefined>): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    out.add(u);
    out.add(normalizeUrl(u));
  }
  return [...out];
}
