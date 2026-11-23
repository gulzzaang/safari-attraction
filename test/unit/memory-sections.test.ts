import { describe, expect, test } from "vitest";
import { appendToSection, readSection, replaceSection } from "../../src/memory/sections.js";

const DOC = `# 이사 준비

## 요약
집 알아보기

## 조건
- 예산 5억
- 역세권

## 메모
- 2026-11-01 첫 메모

## 상태
진행 중
`;

describe("readSection", () => {
  test("절 본문을 앞뒤 빈 줄 없이 돌려준다", () => {
    expect(readSection(DOC, "조건")).toBe("- 예산 5억\n- 역세권");
    expect(readSection(DOC, "상태")).toBe("진행 중");
  });
  test("없는 절은 null", () => {
    expect(readSection(DOC, "사이트")).toBeNull();
  });
  test("### 작은 제목은 절을 끊지 않는다", () => {
    const md = "## 메모\n가\n### 세부\n나\n## 상태\n끝\n";
    expect(readSection(md, "메모")).toBe("가\n### 세부\n나");
  });
  test("제목 앞뒤 공백 · 한글 정규화(NFD) 무시", () => {
    const md = "## 메모 \n내용\n";
    expect(readSection(md, " 메모 ")).toBe("내용");
    expect(readSection("## " + "메모".normalize("NFD") + "\nx\n", "메모")).toBe("x");
  });
  test("빈 절은 빈 글", () => {
    expect(readSection("## 메모\n\n## 상태\n끝\n", "메모")).toBe("");
  });
  test("같은 제목이 여럿이면 처음 것", () => {
    expect(readSection("## 메모\n하나\n## 메모\n둘\n", "메모")).toBe("하나");
  });
});

describe("replaceSection", () => {
  test("그 절만 바꾸고 다른 절은 그대로", () => {
    const out = replaceSection(DOC, "조건", "- 예산 6억");
    expect(readSection(out, "조건")).toBe("- 예산 6억");
    expect(readSection(out, "요약")).toBe("집 알아보기");
    expect(readSection(out, "메모")).toBe("- 2026-11-01 첫 메모");
    expect(readSection(out, "상태")).toBe("진행 중");
    expect(out).toContain("- 예산 6억\n\n## 메모");
  });
  test("마지막 절도 바꾼다", () => {
    const out = replaceSection(DOC, "상태", "보관");
    expect(out.endsWith("## 상태\n보관\n")).toBe(true);
  });
  test("없는 절은 글 끝에 만든다", () => {
    const out = replaceSection("# 이름\n\n## 요약\n가\n", "사이트", "- https://a.example");
    expect(out).toBe("# 이름\n\n## 요약\n가\n\n## 사이트\n- https://a.example\n");
  });
  test("빈 글에도 만든다", () => {
    expect(replaceSection("", "메모", "x")).toBe("## 메모\nx\n");
  });
});

describe("appendToSection", () => {
  test("절 맨 끝에 한 줄을 붙인다(다음 절 앞 빈 줄 유지)", () => {
    const out = appendToSection(DOC, "메모", "- 2026-11-23 둘째 메모");
    expect(readSection(out, "메모")).toBe("- 2026-11-01 첫 메모\n- 2026-11-23 둘째 메모");
    expect(out).toContain("- 2026-11-23 둘째 메모\n\n## 상태");
    expect(readSection(out, "상태")).toBe("진행 중");
  });
  test("파일 끝 절에도 붙인다", () => {
    const out = appendToSection(DOC, "상태", "보관 예정");
    expect(out.endsWith("## 상태\n진행 중\n보관 예정\n")).toBe(true);
  });
  test("끝 줄 바꿈이 없어도 된다", () => {
    expect(appendToSection("## 메모\n가", "메모", "나")).toBe("## 메모\n가\n나\n");
  });
  test("빈 절에는 제목 바로 아래", () => {
    expect(appendToSection("## 메모\n\n## 상태\n끝\n", "메모", "가")).toBe("## 메모\n가\n\n## 상태\n끝\n");
  });
  test("없는 절은 글 끝에 만든다", () => {
    expect(appendToSection("# 이름\n", "메모", "- 가")).toBe("# 이름\n\n## 메모\n- 가\n");
  });
});
