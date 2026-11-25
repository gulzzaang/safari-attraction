import test from "node:test";
import assert from "node:assert/strict";
import "../lib/cards.js";

const L = globalThis.SAPanelLib;

test("danger card has no always-allow button", () => {
  const action = L.cardView({
    id: "c1", kind: "action", title: "사이트에서 할 일 — 허락할까요?",
    detail: "누르기 · 장바구니", host: "shop.example", canAlwaysAllow: true,
  });
  assert.deepEqual(action.buttons.map((b) => b.answer), ["allow", "deny", "always"]);
  assert.equal(action.buttons[0].primary, true);

  const danger = L.cardView({
    id: "c2", kind: "danger", title: "되돌릴 수 없어 보이는 일",
    detail: "누르기 · 결제", host: "pay.example", canAlwaysAllow: true,
  });
  assert.deepEqual(danger.buttons.map((b) => b.answer), ["allow", "deny"]);

  const code = L.cardView({
    id: "c3", kind: "code", title: "이 코드를 실행해도 될까요?",
    detail: "require('child_process')", host: "", canAlwaysAllow: true,
  });
  assert.deepEqual(code.buttons.map((b) => b.answer), ["allow", "deny"]);
  assert.equal(code.isCode, true);
});

test("text is plain (no html)", () => {
  const raw = '<img src=x onerror="alert(1)"><b>클릭</b>';
  const view = L.cardView({
    id: "c4", kind: "action", title: raw, detail: raw, host: raw, canAlwaysAllow: false,
  });
  // 순수 문자열 그대로 넘겨 content.js 가 textContent 로만 그리게 한다(HTML 문자열 조립 없음).
  assert.equal(view.title, raw);
  assert.equal(view.detail, raw);
  assert.equal(view.host, raw);
  assert.equal(typeof view.html, "undefined");
  assert.equal(L.cardResultLabel("allowed"), "허락함");
  assert.equal(L.cardResultLabel("denied"), "거절함");
  assert.equal(L.cardResultLabel("withdrawn"), "거두었어요");
});
