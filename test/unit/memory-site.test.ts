import { describe, expect, test } from "vitest";
import { sanitizeUrl, siteFileName, siteLookupChain } from "../../src/memory/site.js";

describe("sanitizeUrl", () => {
  test("쿼리 · # 를 버리고 긴 영숫자 조각은 …", () => {
    expect(sanitizeUrl("https://a.com/reset/AbCdEf1234567890AbCdEf12?x=1#y", { domainOnly: false })).toBe(
      "https://a.com/reset/…",
    );
  });

  test("domainOnly 면 호스트만", () => {
    expect(sanitizeUrl("https://a.com/reset/AbCdEf1234567890AbCdEf12?x=1#y", { domainOnly: true })).toBe("a.com");
    expect(sanitizeUrl("https://user:pw@www.a.com:8443/x", { domainOnly: true })).toBe("www.a.com");
  });

  test("사용자 이름 · 비밀번호 부분은 버린다", () => {
    expect(sanitizeUrl("https://user:pw@a.com:8443/x/y", { domainOnly: false })).toBe("https://a.com:8443/x/y");
  });

  test("23자 이하 · 기호가 든 조각은 그대로", () => {
    expect(sanitizeUrl("https://a.com/products/12345?ref=x", { domainOnly: false })).toBe("https://a.com/products/12345");
    expect(sanitizeUrl("https://a.com/AbCdEf1234567890AbCdEf1", { domainOnly: false })).toBe("https://a.com/AbCdEf1234567890AbCdEf1");
    expect(sanitizeUrl("https://a.com/abcdefghij.klmnopqrstuv", { domainOnly: false })).toBe("https://a.com/abcdefghij.klmnopqrstuv"); // 23자
  });

  test("24자 이상이면 . = + % ~ 가 섞인 조각도 …(base64 끝의 ==, 점으로 이은 토큰)", () => {
    expect(sanitizeUrl("https://a.com/abcdefghij.klmnopqrstuvwxyz", { domainOnly: false })).toBe("https://a.com/…");
    expect(sanitizeUrl("https://a.com/dXNlcjpzZWNyZXQtdG9rZW4xMjM0NTY==", { domainOnly: false })).toBe("https://a.com/…");
    expect(sanitizeUrl("https://a.com/auth/eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4", { domainOnly: false })).toBe("https://a.com/auth/…");
    expect(sanitizeUrl("https://a.com/x/aaaa+bbbb~cccc%2Fdddd-eeee_ffff", { domainOnly: false })).toBe("https://a.com/x/…");
  });

  test("한글 제목처럼 퍼센트로 부호화된 글은 토큰이 아니니 그대로(찾기에 걸리도록)", () => {
    expect(sanitizeUrl("https://ko.example.org/wiki/서울특별시_행정구역", { domainOnly: false })).toBe(
      "https://ko.example.org/wiki/%EC%84%9C%EC%9A%B8%ED%8A%B9%EB%B3%84%EC%8B%9C_%ED%96%89%EC%A0%95%EA%B5%AC%EC%97%AD",
    );
  });

  test(";params(예: ;jsessionid=…)는 버린다", () => {
    expect(sanitizeUrl("https://a.com/cart;jsessionid=ABC123?x=1", { domainOnly: false })).toBe("https://a.com/cart");
    expect(sanitizeUrl("https://a.com/a;x=1/b;y=2", { domainOnly: false })).toBe("https://a.com/a/b");
  });

  test("http · https · about · file 이 아닌 주소(data: · javascript: · blob: …)는 스킴만 남긴다", () => {
    expect(sanitizeUrl("data:text/html;base64,PGh0bWw+c2VjcmV0", { domainOnly: false })).toBe("data:…");
    expect(sanitizeUrl("data:text/html;base64,PGh0bWw+c2VjcmV0", { domainOnly: true })).toBe("data:…");
    expect(sanitizeUrl("javascript:alert(document.cookie)", { domainOnly: false })).toBe("javascript:…");
    expect(sanitizeUrl("blob:https://a.com/5f1d3c2e-aaaa-bbbb-cccc-1234567890ab", { domainOnly: false })).toBe("blob:…");
    expect(sanitizeUrl("ftp://user:pw@a.com/x", { domainOnly: false })).toBe("ftp:…");
    expect(sanitizeUrl("https://a.com/x", { domainOnly: false })).toBe("https://a.com/x");
  });

  test("24자 이상이어도 -_ 영숫자만이면 …(하이픈 · 밑줄 포함)", () => {
    expect(sanitizeUrl("https://a.com/x/abcd-efgh_ijkl-mnop_qrst-uvwx", { domainOnly: false })).toBe("https://a.com/x/…");
  });

  test("about: · file: 은 그대로 짧게(쿼리 · # 버림)", () => {
    expect(sanitizeUrl("about:blank", { domainOnly: false })).toBe("about:blank");
    expect(sanitizeUrl("about:blank", { domainOnly: true })).toBe("about:blank");
    expect(sanitizeUrl("file:///Users/x/a.html?q=1#z", { domainOnly: false })).toBe("file:///Users/x/a.html");
    const long = "file:///" + "a/".repeat(100);
    expect(sanitizeUrl(long, { domainOnly: false }).length).toBeLessThanOrEqual(80);
  });

  test("주소가 아닌 글은 쿼리 · # 만 버리고 짧게", () => {
    expect(sanitizeUrl("그냥 글?x=1", { domainOnly: false })).toBe("그냥 글");
  });
});

describe("siteFileName", () => {
  test("www. · m. 만 떼고 소문자 + .md", () => {
    expect(siteFileName("www.Coupang.com")).toBe("coupang.com.md");
    expect(siteFileName("m.naver.com")).toBe("naver.com.md");
    expect(siteFileName("cafe.naver.com")).toBe("cafe.naver.com.md");
  });

  test("떼고 나면 점이 없어지는 이름은 그대로", () => {
    expect(siteFileName("m.com")).toBe("m.com.md");
    expect(siteFileName("localhost")).toBe("localhost.md");
  });

  test("포트 · 이상한 글자는 파일 이름에 안전하게", () => {
    expect(siteFileName("localhost:3000")).toBe("localhost.md");
    expect(siteFileName("a/b.com")).toBe("a-b.com.md");
  });
});

describe("siteLookupChain", () => {
  test("호스트부터 위 도메인 순", () => {
    expect(siteLookupChain("cafe.naver.com")).toEqual(["cafe.naver.com.md", "naver.com.md"]);
    expect(siteLookupChain("www.coupang.com")).toEqual(["coupang.com.md"]);
    expect(siteLookupChain("a.b.c.example.com")).toEqual([
      "a.b.c.example.com.md",
      "b.c.example.com.md",
      "c.example.com.md",
      "example.com.md",
    ]);
  });

  test("두 단계 끝말(co.kr 등) 아래로는 내려가지 않는다", () => {
    expect(siteLookupChain("shop.example.co.kr")).toEqual(["shop.example.co.kr.md", "example.co.kr.md"]);
    expect(siteLookupChain("www.bbc.co.uk")).toEqual(["bbc.co.uk.md"]);
    expect(siteLookupChain("co.kr")).toEqual(["co.kr.md"]);
  });

  test("점이 없는 이름 · IP 는 자기 자신만", () => {
    expect(siteLookupChain("localhost")).toEqual(["localhost.md"]);
    expect(siteLookupChain("192.168.0.1")).toEqual(["192.168.0.1.md"]);
  });
});
