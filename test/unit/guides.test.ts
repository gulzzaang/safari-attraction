import { describe, expect, test } from "vitest";
import { findSecret } from "../../src/memory/guard.js";
import {
  GUIDES,
  GUIDE_BYTES_MAX,
  GUIDE_SUMMARY_MAX,
  fullText,
  guideFor,
  guideForHost,
  listGuides,
  normalizeHost,
  type SiteGuide,
} from "../../src/guides/index.js";

const fake = (id: string, name: string, hosts: string[]): SiteGuide => ({
  id,
  name,
  hosts,
  summary: `${name} 요약`,
  body: `## 화면 구조\n${name} 화면`,
  checked: "2026-11-23",
});

const coupang = fake("coupang", "쿠팡", ["coupang.com"]);
const naver = fake("naver-search", "네이버 첫 화면", ["naver.com", "search.naver.com"]);
const shopping = fake("naver-shopping", "네이버 쇼핑", ["shopping.naver.com"]);
const FAKES = [coupang, naver, shopping];

describe("normalizeHost", () => {
  test("대소문자 · 포트 · m. 를 뗀다", () => {
    expect(normalizeHost("https://M.Coupang.COM:443/np/search?q=x")).toBe("coupang.com");
  });
  test("www. 와 호스트만 준 경우", () => {
    expect(normalizeHost("https://www.youtube.com/watch?v=1")).toBe("youtube.com");
    expect(normalizeHost("WWW.Notion.so")).toBe("notion.so");
  });
  test("스킴 없는 localhost:포트 · IP", () => {
    expect(normalizeHost("localhost:3000")).toBe("localhost");
    expect(normalizeHost("http://127.0.0.1:8765/")).toBe("127.0.0.1");
  });
  test("읽을 수 없으면 null", () => {
    expect(normalizeHost("💥")).toBeNull();
    expect(normalizeHost("")).toBeNull();
    expect(normalizeHost("about:blank")).toBeNull();
    expect(normalizeHost("not a host")).toBeNull();
  });
  test("m.com 처럼 떼면 점이 안 남는 건 그대로", () => {
    expect(normalizeHost("m.com")).toBe("m.com");
  });
});

describe("guideFor / guideForHost", () => {
  test("정확한 호스트가 우선", () => {
    expect(guideFor("https://search.naver.com/search.naver?query=x", FAKES)).toBe(naver);
    expect(guideFor("https://shopping.naver.com/home", FAKES)).toBe(shopping);
  });
  test("위 도메인으로 올라간다", () => {
    expect(guideFor("https://cafe.naver.com/x", FAKES)).toBe(naver);
    expect(guideFor("search.shopping.naver.com", FAKES)).toBe(shopping);
    expect(guideForHost("pay.coupang.com", FAKES)).toBe(coupang);
  });
  test("대소문자 · m. · 포트에 상관없다", () => {
    expect(guideFor("https://M.Coupang.COM:443/np/search?q=x", FAKES)).toBe(coupang);
    expect(guideFor("WWW.COUPANG.COM", FAKES)).toBe(coupang);
  });
  test("짝이 없으면 null", () => {
    expect(guideFor("http://127.0.0.1:8765/", FAKES)).toBeNull();
    expect(guideFor("localhost:3000", FAKES)).toBeNull();
    expect(guideFor("about:blank", FAKES)).toBeNull();
    expect(guideFor("💥", FAKES)).toBeNull();
    expect(guideFor("https://example.org/", FAKES)).toBeNull();
  });
  test("co.kr 같은 두 단계 끝말로는 올라가지 않는다", () => {
    const g = fake("x", "엑스", ["co.kr"]);
    expect(guideFor("https://a.co.kr/", [g])).toBeNull();
    expect(guideFor("https://co.kr/", [g])).toBe(g);
  });
  test("기본 인자는 GUIDES", () => {
    expect(guideFor("http://127.0.0.1:8765/")).toBeNull();
  });
});

describe("fullText / listGuides", () => {
  test("fullText 꼴", () => {
    expect(fullText(coupang)).toBe(
      "# 쿠팡\n\n## 요약\n쿠팡 요약\n\n## 화면 구조\n쿠팡 화면\n\n확인한 날: 2026-11-23",
    );
  });
  test("listGuides 는 한 줄에 하나", () => {
    const lines = listGuides(FAKES).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("네이버 첫 화면 — naver.com, search.naver.com");
    expect(listGuides([])).toBe("");
  });
});

describe("진짜 안내서 목록 검사", () => {
  test("상한 값", () => {
    expect(GUIDE_SUMMARY_MAX).toBe(400);
    expect(GUIDE_BYTES_MAX).toBe(6000);
  });
  test("id 는 영문 소문자 · - 이고 겹치지 않는다", () => {
    const ids = GUIDES.map((g) => g.id);
    for (const id of ids) expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
    expect(new Set(ids).size).toBe(ids.length);
  });
  test("호스트는 정규형이고 두 안내서에 겹치지 않는다", () => {
    const seen = new Map<string, string>();
    for (const g of GUIDES) {
      expect(g.hosts.length).toBeGreaterThan(0);
      for (const h of g.hosts) {
        expect(normalizeHost(h), `${g.id} 호스트 ${h}`).toBe(h);
        expect(seen.get(h), `${h} 가 ${seen.get(h)} 와 ${g.id} 에 겹침`).toBeUndefined();
        seen.set(h, g.id);
      }
    }
  });
  test("요약 400자 · 전체 6000바이트 이하, checked 꼴", () => {
    for (const g of GUIDES) {
      expect([...g.summary].length, `${g.id} 요약`).toBeLessThanOrEqual(GUIDE_SUMMARY_MAX);
      expect(Buffer.byteLength(fullText(g)), `${g.id} 전체`).toBeLessThanOrEqual(GUIDE_BYTES_MAX);
      expect(g.checked, `${g.id} checked`).toMatch(/^(로그인 화면까지만\(미확인\) )?\d{4}-\d{2}-\d{2}$/);
    }
  });
  test("본문 절 순서: 화면 구조 · 찾기와 읽기 · 자주 하는 일 · 함정 · 사용자 확인이 꼭 필요한 일", () => {
    const order = ["## 화면 구조", "## 찾기와 읽기", "## 자주 하는 일", "## 함정", "## 사용자 확인이 꼭 필요한 일"];
    for (const g of GUIDES) {
      const text = fullText(g);
      const at = order.map((h) => text.indexOf(`\n${h}\n`));
      expect(at.every((i) => i >= 0), `${g.id} 절 빠짐`).toBe(true);
      expect([...at].sort((a, b) => a - b), `${g.id} 절 순서`).toEqual(at);
      expect(text.indexOf("## 요약"), `${g.id} 요약이 맨 앞`).toBeLessThan(at[0]);
      expect(text.endsWith(`확인한 날: ${g.checked}`), `${g.id} 확인한 날이 맨 끝`).toBe(true);
    }
  });
  test("쿠팡 · 네이버 안내서 호스트 짝", () => {
    const cases: Array<[string, string]> = [
      ["https://www.coupang.com/np/search?q=x", "coupang"],
      ["https://m.coupang.com/", "coupang"],
      ["https://www.naver.com/", "naver-search"],
      ["https://search.naver.com/search.naver?query=x", "naver-search"],
      ["https://cafe.naver.com/x", "naver-search"],
      ["https://search.shopping.naver.com/search/all?query=x", "naver-shopping"],
      ["https://shopping.naver.com/home", "naver-shopping"],
      ["https://smartstore.naver.com/x", "naver-shopping"],
      ["https://brand.naver.com/x/products/1", "naver-shopping"],
      ["https://map.naver.com/p/search/x", "naver-map"],
    ];
    for (const [url, id] of cases) expect(guideFor(url)?.id, url).toBe(id);
  });
  test("개인 정보 · 민감 값이 없다", () => {
    for (const g of GUIDES) {
      const text = fullText(g);
      const mails = (text.match(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g) ?? []).filter(
        (m) => !/@example\.com$/i.test(m),
      );
      expect(mails, `${g.id} 메일 주소 꼴`).toEqual([]);
      expect(findSecret(text), `${g.id} findSecret`).toBeNull();
      expect(text, `${g.id} 전화번호 꼴`).not.toMatch(/01[016789]-?\d{3,4}-?\d{4}/);
    }
  });
});

describe("검사 자체가 걸리는지(가짜 나쁜 안내서)", () => {
  test("메일 · 전화 · 비밀번호 꼴을 알아본다", () => {
    expect("a@b.com").toMatch(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/);
    expect("010-1234-5678").toMatch(/01[016789]-?\d{3,4}-?\d{4}/);
    expect(findSecret("비밀번호: hunter2")).not.toBeNull();
  });
});
