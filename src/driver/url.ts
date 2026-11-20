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

const lowerHex = (u: string): string => u.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());

/** 정규화한 주소에서 한글 같은 비 ASCII 글자(UTF-8 바이트가 0x80 이상인 %XX 덩어리)만 글자 그대로로 푼다. 못 풀면(잘못된 UTF-8) 그대로. */
const literalHigh = (u: string): string =>
  u.replace(/(?:%[89A-F][0-9A-F])+/g, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m;
    }
  });

/**
 * 같은 주소가 사파리 쪽에서 보일 수 있는 여러 꼴(기록한 그대로 · 정규화 · 한글을 글자 그대로 푼 것 · %xx 를 소문자로 한 것, 그 조합).
 * 사파리 안(tab.url() · location.href 와 견주는 스크립트 · 호스트)에는 URL 클래스가 없어 글자 비교만 하므로, 관찰한 꼴이 sameUrl 이 같다고 보는 꼴이면
 * 이 후보 안에 들게 한다. 빈 값은 뺀다.
 */
export function urlForms(urls: Array<string | undefined>): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    const n = normalizeUrl(u);
    for (const base of [u, n]) {
      out.add(base);
      out.add(lowerHex(base));
    }
    const lit = literalHigh(n);
    out.add(lit);
    out.add(lowerHex(lit));
  }
  return [...out];
}
