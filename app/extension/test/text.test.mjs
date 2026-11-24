import test from "node:test";
import assert from "node:assert/strict";
import "../lib/text.js";

const L = globalThis.SAPanelLib;

test("앱이 꺼졌을 때 문구는 고정", () => {
  assert.equal(L.errorText("app_off"), "사파리-어트랙션 앱을 켜 주세요(메뉴 막대 나침반)");
  assert.ok(L.errorText("app_unreachable").startsWith("사파리-어트랙션 앱을 켜 주세요(메뉴 막대 나침반)"));
  assert.ok(L.errorText("host_permission").includes("사파리 설정 → 확장 → 사파리-어트랙션 → 웹사이트에서 127.0.0.1 허락"));
  assert.equal(L.errorText("disconnected"), "연결이 끊겼어요");
});

test("모르는 코드는 서버가 준 한국어 글, 그것도 없으면 일반 안내", () => {
  assert.equal(L.errorText("nope", "서버 글"), "서버 글");
  assert.equal(L.errorText("nope"), "알 수 없는 오류가 났어요");
});

test("HTTP 상태 → 한국어 문구", () => {
  assert.equal(L.httpError(403, "").code, "stale");
  assert.equal(L.httpError(413, "").code, "too_long");
  assert.equal(L.httpError(429, "다른 질문이 끝나면 다시 시도해 주세요").message, "다른 질문이 끝나면 다시 시도해 주세요");
  assert.equal(L.httpError(429, "").message, "다른 질문이 끝나면 다시 시도해 주세요");
  assert.equal(L.httpError(400, "질문이 비었어요").message, "질문이 비었어요");
  assert.equal(L.httpError(500, "").message, "앱이 오류로 답했어요(500)");
  for (const s of [403, 413, 429, 400, 500]) assert.ok(/[가-힣]/.test(L.httpError(s, "").message));
});

const joined = (segs) => segs.map((s) => s.text).join("");

test("맨 주소 · 마크다운 링크를 가른다(http · https 만)", () => {
  const segs = L.splitLinks("보세요 https://example.com/a?b=1. 또 [문서](https://docs.test/x) 끝");
  assert.deepEqual(segs, [
    { text: "보세요 " },
    { text: "https://example.com/a?b=1", href: "https://example.com/a?b=1" },
    { text: ". 또 " },
    { text: "문서", href: "https://docs.test/x" },
    { text: " 끝" },
  ]);
});

test("괄호 · 쉼표 · 한글 조사가 주소에 안 붙는다", () => {
  const a = L.splitLinks("(https://a.test/x)이고");
  assert.equal(a.find((s) => s.href).href, "https://a.test/x");
  const b = L.splitLinks("https://a.test/x를 보세요");
  assert.equal(b.find((s) => s.href).text, "https://a.test/x");
  const c = L.splitLinks("https://en.wikipedia.org/wiki/Foo_(bar) 입니다");
  assert.equal(c.find((s) => s.href).text, "https://en.wikipedia.org/wiki/Foo_(bar)");
});

test("javascript: · data: 같은 것은 링크가 되지 않는다", () => {
  for (const s of ["[클릭](javascript:alert(1))", "javascript:alert(1)", "[x](data:text/html,<script>1</script>)", "[x](ftp://a.test)"]) {
    assert.ok(L.splitLinks(s).every((seg) => !seg.href), s);
  }
});

test("링크가 아닌 글은 그대로 한 조각, 글자는 하나도 잃지 않는다", () => {
  assert.deepEqual(L.splitLinks("그냥 글 <b>굵게</b> & <script>"), [{ text: "그냥 글 <b>굵게</b> & <script>" }]);
  assert.deepEqual(L.splitLinks(""), []);
  const mixed = "a https://x.test/p b [t](https://y.test) c";
  assert.equal(joined(L.splitLinks(mixed)), "a https://x.test/p b t c");
});

test("HTML 처럼 보이는 글이 링크 글에 있어도 그대로 글자", () => {
  const segs = L.splitLinks('[<img src=x onerror=alert(1)>](https://a.test)');
  assert.equal(segs[0].text, "<img src=x onerror=alert(1)>");
  assert.equal(segs[0].href, "https://a.test/");
});
