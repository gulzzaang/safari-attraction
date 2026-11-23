/** 내장 사이트 안내서 한 편. */
export type SiteGuide = {
  /** 영문 소문자 · `-`(예: `coupang`, `naver-search`). 「보였음」 열쇠로도 쓴다. */
  id: string;
  /** 사용자에게 보이는 이름(예: 쿠팡). */
  name: string;
  /** `www.` · `m.` 를 뗀 소문자 호스트들. 위 도메인(`cafe.naver.com` → `naver.com`)으로도 짝지어진다. */
  hosts: string[];
  /** 처음 열 때 붙는 짧은 요약(400자 이하). */
  summary: string;
  /** 요약 뒤 절들(마크다운). */
  body: string;
  /** 확인한 날: `YYYY-MM-DD` 또는 `로그인 화면까지만(미확인) YYYY-MM-DD`. */
  checked: string;
};
