import { nfc } from "./home.js";

/** 두 단계 끝말(co.kr 같은). 사이트 메모를 찾을 때 이 아래로는 내려가지 않는다. */
const TWO_LEVEL_SUFFIXES = new Set([
  "co.kr",
  "go.kr",
  "or.kr",
  "ne.kr",
  "ac.kr",
  "re.kr",
  "co.jp",
  "ne.jp",
  "or.jp",
  "co.uk",
  "org.uk",
  "ac.uk",
  "com.au",
  "net.au",
  "com.cn",
  "com.tw",
  "com.br",
]);

/** 이 길이(글자 수) 이상이면서 영숫자 · - _ 로만 된 경로 조각은 토큰 · 아이디일 수 있어 …로 가린다. */
const OPAQUE_SEGMENT_MIN = 24;
/** 주소가 아닌 글 · file: 은 이 길이로 짧게 자른다. */
const SHORT_MAX = 80;

function shorten(s: string): string {
  const chars = [...s];
  return chars.length > SHORT_MAX ? chars.slice(0, SHORT_MAX - 1).join("") + "…" : s;
}

/**
 * 기록에 남겨도 되는 모양으로 주소를 다듬는다.
 * 쿼리 · # · 사용자 정보는 버리고, 24자 이상 영숫자 · -_ 조각은 …로 바꾼다. domainOnly 면 호스트만.
 * about: · file: 은 쿼리 · # 만 버리고 짧게 남긴다.
 */
export function sanitizeUrl(url: string, opts: { domainOnly: boolean }): string {
  const cut = (s: string) => shorten(s.split(/[?#]/, 1)[0]!);
  if (/^(about|file):/i.test(url)) return cut(url);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return cut(url);
  }
  if (!u.host) return cut(url);
  if (opts.domainOnly) return u.hostname;
  const path = u.pathname
    .split("/")
    .map((seg) => ([...seg].length >= OPAQUE_SEGMENT_MIN && /^[A-Za-z0-9_-]+$/.test(seg) ? "…" : seg))
    .join("/");
  return `${u.protocol}//${u.host}${path}`;
}

/** 호스트를 파일 이름용으로: 소문자, 포트 · 앞의 www. · m. 떼기, 안전하지 않은 글자는 -. */
function normalizeHost(host: string): string {
  let h = nfc(host).trim().toLowerCase().replace(/\.$/, "");
  h = h.replace(/:\d+$/, "");
  for (const prefix of ["www.", "m."]) {
    // 떼고 나서도 점이 남을 때만(m.com 이 com 이 되지 않게).
    if (h.startsWith(prefix) && h.slice(prefix.length).includes(".")) h = h.slice(prefix.length);
  }
  return h.replace(/[^\p{L}\p{N}.-]/gu, "-");
}

/** 사이트 메모 파일 이름. `www.Coupang.com` → `coupang.com.md`. */
export function siteFileName(host: string): string {
  const h = normalizeHost(host);
  return `${h || "호스트-없음"}.md`;
}

/**
 * 사이트 메모를 찾을 파일 이름들: 호스트 그대로부터 위 도메인 순.
 * 두 단계 끝말(co.kr 등) 아래로는 내려가지 않는다.
 */
export function siteLookupChain(host: string): string[] {
  const h = normalizeHost(host) || "호스트-없음";
  if (/^\d+(\.\d+){3}$/.test(h)) return [`${h}.md`]; // IP 는 위 도메인이 없다.
  const labels = h.split(".");
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) {
    const cand = labels.slice(i).join(".");
    if (i > 0 && TWO_LEVEL_SUFFIXES.has(cand)) break;
    out.push(`${cand}.md`);
  }
  return out.length > 0 ? out : [`${h}.md`];
}
