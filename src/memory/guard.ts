import { sanitizeUrl } from "./site.js";

/** 카드 번호 길이(숫자 수). */
const CARD_MIN = 13;
const CARD_MAX = 19;

/** 룬(Luhn) 검사. */
function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/**
 * 숫자 덩어리(공백 · 하이픈 하나로 이어진 숫자 묶음들) 안에서, 묶음 단위로 이은 13~19자리가 룬을 통과하면 카드 번호.
 * 한 묶음 안을 쪼개 보지는 않는다(긴 숫자 하나는 카드 번호가 아니다).
 */
function hasCardNumber(text: string): boolean {
  for (const chunk of text.match(/\d+(?:[ -]\d+)*/g) ?? []) {
    const groups = chunk.split(/[ -]/);
    for (let i = 0; i < groups.length; i++) {
      let digits = "";
      for (let j = i; j < groups.length; j++) {
        digits += groups[j];
        if (digits.length > CARD_MAX) break;
        if (digits.length >= CARD_MIN && luhn(digits)) return true;
      }
    }
  }
  return false;
}

const NOT_ALNUM_BEFORE = "(?<![A-Za-z0-9])";
const TOKEN_PATTERNS: RegExp[] = [
  new RegExp(`${NOT_ALNUM_BEFORE}sk-[A-Za-z0-9_-]{20,}`),
  new RegExp(`${NOT_ALNUM_BEFORE}gh[pousr]_[A-Za-z0-9]{20,}`),
  new RegExp(`${NOT_ALNUM_BEFORE}github_pat_[A-Za-z0-9_]{20,}`),
  new RegExp(`${NOT_ALNUM_BEFORE}ntn_[A-Za-z0-9]{20,}`),
  new RegExp(`${NOT_ALNUM_BEFORE}xox[abp]-[A-Za-z0-9-]{10,}`),
  new RegExp(`${NOT_ALNUM_BEFORE}AIza[A-Za-z0-9_-]{30,}`),
];
const PRIVATE_KEY = /-----BEGIN/;
/** 「비밀번호:」 · 「password:」 처럼 라벨 뒤에 값이 이어지는 줄. 값 없는 라벨은 걸지 않는다. */
const PASSWORD_LINE = /(?:비밀번호|비번|패스워드|password|passwd)["']?[ \t]*[:：=][ \t]*\S/i;

/**
 * 기억 · 문서에 저장하면 안 되는 민감한 값이 있으면 걸린 종류 이름(「카드 번호」 · 「토큰」 · 「개인 키」 · 「비밀번호」)을, 없으면 null.
 */
export function findSecret(text: string): string | null {
  if (PRIVATE_KEY.test(text)) return "개인 키";
  if (TOKEN_PATTERNS.some((re) => re.test(text))) return "토큰";
  if (PASSWORD_LINE.test(text)) return "비밀번호";
  if (hasCardNumber(text)) return "카드 번호";
  return null;
}

/**
 * 하루 기록(repl 제목 · 오류 글 등)에 남길 한 줄로 다듬는다.
 * 줄 바꿈은 공백으로, 글 속 주소는 쿼리 · 긴 토큰 조각을 빼고, 민감한 값이 걸리면 통째로 「(가림)」,
 * 마지막에 max 자 안으로 자른다(넘으면 끝이 …).
 */
export function scrubText(text: string, max: number): string {
  const oneLine = text
    .replace(/[\r\n]+/g, " ")
    .replace(/https?:\/\/\S+/g, (u) => sanitizeUrl(u, { domainOnly: false }));
  if (findSecret(oneLine) !== null) return "(가림)";
  const chars = [...oneLine];
  if (chars.length <= max) return oneLine;
  if (max <= 1) return max === 1 ? "…" : "";
  return chars.slice(0, max - 1).join("") + "…";
}
