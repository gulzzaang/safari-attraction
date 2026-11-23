import { describe, expect, test } from "vitest";
import { planGuideNotes } from "../../src/guides/notes.js";
import type { SiteGuide } from "../../src/guides/index.js";
import type { Touch } from "../../src/memory/activity.js";

const fake = (id: string, name: string, hosts: string[]): SiteGuide => ({
  id,
  name,
  hosts,
  summary: `${name} 요약`,
  body: `## 화면 구조\n${name} 화면`,
  checked: "2026-11-23",
});

const A = fake("aa", "에이", ["a.example"]);
const B = fake("bb", "비", ["b.example"]);
const C = fake("cc", "씨", ["c.example"]);
const D = fake("dd", "디", ["d.example"]);
const N = fake("naver", "네이버", ["naver.com", "search.naver.com"]);
const FAKES = [A, B, C, D, N];

const t = (url: string, kind: Touch["kind"] = "open"): Touch => ({ url, userTab: false, kind });

describe("planGuideNotes", () => {
  test("안내서가 있는 사이트는 요약 한 줄, commit 하면 같은 대화에서 다시 안 붙는다", () => {
    const seen = new Set<string>();
    const plan = planGuideNotes([t("https://a.example/x")], seen, FAKES);
    expect(plan?.text).toBe("… 이 사이트 안내(에이): 에이 요약 — 자세히는 guide()");
    expect(seen.size).toBe(0); // commit 전에는 보였음이 아니다
    plan!.commit();
    expect([...seen]).toEqual(["aa"]);
    expect(planGuideNotes([t("https://a.example/y")], seen, FAKES)).toBeNull();
  });

  test("안내서 없는 사이트 · 주소 아닌 곳 · 닿은 곳 없음은 null", () => {
    expect(planGuideNotes([t("https://z.example/")], new Set(), FAKES)).toBeNull();
    expect(planGuideNotes([t("about:blank"), t("file:///tmp/x.html"), t("data:text/html,hi")], new Set(), FAKES)).toBeNull();
    expect(planGuideNotes([], new Set(), FAKES)).toBeNull();
  });

  test("같은 안내서의 다른 호스트는 한 번만(열쇠는 안내서 id)", () => {
    const seen = new Set<string>();
    const first = planGuideNotes([t("https://cafe.naver.com/x")], seen, FAKES);
    expect(first?.text).toContain("네이버");
    first!.commit();
    expect(planGuideNotes([t("https://search.naver.com/?q=1")], seen, FAKES)).toBeNull();
  });

  test("한 호출에 같은 안내서를 두 번 닿아도 요약은 한 줄", () => {
    const plan = planGuideNotes([t("https://cafe.naver.com/x"), t("https://search.naver.com/?q=1")], new Set(), FAKES);
    expect(plan!.text.split("\n")).toHaveLength(1);
  });

  test("네 사이트 한 번에: 앞 두 편은 요약, 나머지는 「안내서 있음」 한 줄, commit 은 요약한 두 편만", () => {
    const seen = new Set<string>();
    const plan = planGuideNotes([t("https://a.example/"), t("https://b.example/"), t("https://c.example/"), t("https://d.example/")], seen, FAKES);
    expect(plan!.text.split("\n")).toEqual([
      "… 이 사이트 안내(에이): 에이 요약 — 자세히는 guide()",
      "… 이 사이트 안내(비): 비 요약 — 자세히는 guide()",
      '… 안내서 있음: 씨 · 디 — guide("주소")',
    ]);
    plan!.commit();
    expect([...seen].sort()).toEqual(["aa", "bb"]);
    // 다음 호출에 셋째 사이트를 다루면 붙는다
    const next = planGuideNotes([t("https://c.example/z")], seen, FAKES);
    expect(next!.text).toBe("… 이 사이트 안내(씨): 씨 요약 — 자세히는 guide()");
  });

  test("이미 본 안내서는 건너뛰고 안 본 것 중에서 앞 두 편", () => {
    const seen = new Set<string>(["aa"]);
    const plan = planGuideNotes([t("https://a.example/"), t("https://b.example/"), t("https://c.example/"), t("https://d.example/")], seen, FAKES);
    expect(plan!.text.split("\n")).toEqual([
      "… 이 사이트 안내(비): 비 요약 — 자세히는 guide()",
      "… 이 사이트 안내(씨): 씨 요약 — 자세히는 guide()",
      '… 안내서 있음: 디 — guide("주소")',
    ]);
  });

  test("요약은 줄을 한 줄로 펴고 400자로 자른다", () => {
    const long: SiteGuide = { ...A, summary: "가나\n다라 " + "마".repeat(500) };
    const plan = planGuideNotes([t("https://a.example/")], new Set(), [long]);
    const m = /^… 이 사이트 안내\(에이\): (.*) — 자세히는 guide\(\)$/.exec(plan!.text)!;
    expect(m).not.toBeNull();
    expect([...m[1]!].length).toBeLessThanOrEqual(400);
    expect(m[1]).not.toContain("\n");
    expect(m[1]!.startsWith("가나 다라 ")).toBe(true);
  });
});
