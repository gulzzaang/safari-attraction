import { describe, expect, test } from "vitest";
import { findSecret, scrubText } from "../../src/memory/guard.js";

describe("findSecret", () => {
  test("유효한 카드 번호(룬 통과)는 「카드 번호」", () => {
    expect(findSecret("카드 4111 1111 1111 1111 로 결제")).toBe("카드 번호");
    expect(findSecret("4111-1111-1111-1111")).toBe("카드 번호");
    expect(findSecret("4111111111111111")).toBe("카드 번호");
    expect(findSecret("378282246310005")).toBe("카드 번호"); // 15자리
    expect(findSecret("6011111111111117")).toBe("카드 번호");
  });

  test("룬 검사에 실패하는 16자리 · 너무 짧거나 긴 숫자는 통과", () => {
    expect(findSecret("4111 1111 1111 1112")).toBeNull();
    expect(findSecret("주문번호 1234567890123456")).toBeNull();
    expect(findSecret("전화 010-1234-5678")).toBeNull();
    expect(findSecret("411111111111")).toBeNull(); // 12자리
    expect(findSecret("4".repeat(20))).toBeNull(); // 20자리 한 덩어리
  });

  test("긴 숫자 줄 사이에 낀 진짜 카드 번호도 찾는다", () => {
    expect(findSecret("1 2 4111 1111 1111 1111 9")).toBe("카드 번호");
  });

  test("서비스 토큰 꼴은 「토큰」", () => {
    expect(findSecret("ghp_" + "a1B2c3D4e5".repeat(3) + "abcdef")).toBe("토큰");
    expect(findSecret("키는 sk-ant-api03-abcdefghijklmnopqrstuvwxyz 야")).toBe("토큰");
    expect(findSecret("github_pat_" + "A1b2C3d4E5".repeat(3))).toBe("토큰");
    expect(findSecret("ntn_" + "a1B2c3D4e5".repeat(3))).toBe("토큰");
    expect(findSecret("xoxb-123456789012-abcdefghij")).toBe("토큰");
    expect(findSecret("xoxp-123456789012-abcdefghij")).toBe("토큰");
    expect(findSecret("xoxa-123456789012-abcdefghij")).toBe("토큰");
    expect(findSecret("AIza" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6")).toBe("토큰");
  });

  test("토큰 꼴이 아닌 비슷한 글은 통과", () => {
    expect(findSecret("task-force-of-the-united-nations-members")).toBeNull();
    expect(findSecret("sk-short")).toBeNull();
    expect(findSecret("ghp_짧음")).toBeNull();
  });

  test("-----BEGIN 은 「개인 키」", () => {
    expect(findSecret("-----BEGIN RSA PRIVATE KEY-----\nMIIE")).toBe("개인 키");
    expect(findSecret("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe("개인 키");
  });

  test("비밀번호: · password: 줄은 「비밀번호」", () => {
    expect(findSecret("비밀번호: abc")).toBe("비밀번호");
    expect(findSecret("로그인\n비밀번호 : hunter2\n끝")).toBe("비밀번호");
    expect(findSecret("Password: abc")).toBe("비밀번호");
    expect(findSecret('{"password": "abc"}')).toBe("비밀번호");
    expect(findSecret("passwd=abc")).toBe("비밀번호");
  });

  test("값 없는 라벨 · 평범한 문장은 null", () => {
    expect(findSecret("비밀번호 입력창이 있다")).toBeNull();
    expect(findSecret("비밀번호:")).toBeNull();
    expect(findSecret("쿠팡 로그인은 오른쪽 위 버튼, 검색창은 가운데")).toBeNull();
    expect(findSecret("")).toBeNull();
  });
});

describe("scrubText", () => {
  test("줄 바꿈은 공백으로, URL 의 쿼리는 버린다", () => {
    const out = scrubText("실패: https://a.com/p?token=x\n둘째 줄", 80);
    expect(out).not.toMatch(/[\r\n]/);
    expect(out).not.toContain("token");
    expect(out).toBe("실패: https://a.com/p 둘째 줄");
  });

  test("긴 영숫자 경로 조각은 …", () => {
    expect(scrubText("가 https://a.com/reset/AbCdEf1234567890AbCdEf12#y 나", 100)).toBe("가 https://a.com/reset/… 나");
  });

  test("민감 값이 걸리면 통째로 (가림)", () => {
    expect(scrubText("카드 4111 1111 1111 1111", 80)).toBe("(가림)");
    expect(scrubText("비밀번호: abc\n다음", 80)).toBe("(가림)");
    expect(scrubText("ghp_" + "a".repeat(36), 80)).toBe("(가림)");
  });

  test("max 를 넘으면 max 자 안에서 …로 끝낸다", () => {
    const out = scrubText("가".repeat(50), 10);
    expect([...out]).toHaveLength(10);
    expect(out.endsWith("…")).toBe(true);
    expect(scrubText("짧아요", 10)).toBe("짧아요");
    expect(scrubText("가나다라마", 5)).toBe("가나다라마");
  });

  test("이모지를 반으로 자르지 않는다", () => {
    const out = scrubText("😀".repeat(20), 5);
    expect([...out]).toHaveLength(5);
    expect(out).toBe("😀😀😀😀…");
  });
});
