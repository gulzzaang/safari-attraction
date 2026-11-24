import test from "node:test";
import assert from "node:assert/strict";
import "../lib/page.js";

const L = globalThis.SAPanelLib;

const doc = (over = {}) => ({ title: "제목", body: { innerText: "본문" }, activeElement: null, ...over });
const win = (selected = "", href = "https://example.com/a?b=1") => ({
  location: { href },
  getSelection: () => ({ toString: () => selected }),
});

test("본문은 4,000자로 자르고 제목 · 주소 · 고른 글을 모은다", () => {
  const long = "가".repeat(10_000);
  const p = L.collectPage(doc({ title: "  긴\n 제목 ", body: { innerText: long } }), win("고른 글"));
  assert.equal(p.title, "긴 제목");
  assert.equal(p.url, "https://example.com/a?b=1");
  assert.equal(p.selection, "고른 글");
  assert.equal(Array.from(p.text).length, 4000);
});

test("고른 글은 2,000자로 자른다", () => {
  const p = L.collectPage(doc(), win("나".repeat(5000)));
  assert.equal(Array.from(p.selection).length, 2000);
});

test("자를 때 이모지(서로게이트 쌍)가 반쪽으로 잘리지 않는다", () => {
  const s = L.truncate("😀".repeat(10), 3);
  assert.equal(s, "😀😀😀");
  assert.equal(L.truncate("abc", 10), "abc");
  assert.equal(L.truncate(undefined, 10), "");
});

test("비밀번호 칸에 초점이 있으면 고른 글을 읽지 않는다", () => {
  const pw = { tagName: "INPUT", type: "password", value: "hunter2", selectionStart: 0, selectionEnd: 7 };
  const p = L.collectPage(doc({ activeElement: pw }), win("hunter2"));
  assert.equal(p.selection, "");
  assert.ok(!JSON.stringify(p).includes("hunter2"));
});

test("type 을 대소문자 섞어 써도, getAttribute 로만 알려 줘도 비밀번호 칸으로 본다", () => {
  assert.equal(L.isPasswordField({ tagName: "input", type: "PassWord" }), true);
  assert.equal(L.isPasswordField({ tagName: "INPUT", getAttribute: () => "password" }), true);
  assert.equal(L.isPasswordField({ tagName: "INPUT", type: "text" }), false);
  assert.equal(L.isPasswordField({ tagName: "TEXTAREA", type: "password" }), false);
  assert.equal(L.isPasswordField(null), false);
});

test("일반 입력 칸에서 고른 글은 그 칸의 선택 범위만 쓴다", () => {
  const input = { tagName: "TEXTAREA", value: "앞 고른 뒤", selectionStart: 2, selectionEnd: 5 };
  const p = L.collectPage(doc({ activeElement: input }), win("페이지 쪽 고른 글"));
  assert.equal(p.selection, "고른");
});

test("지금 고른 글이 없으면 패널을 열 때 적어 둔 고른 글을 쓴다", () => {
  assert.equal(L.collectPage(doc(), win(""), "열 때 고른 글").selection, "열 때 고른 글");
  assert.equal(L.collectPage(doc(), win("지금 것"), "열 때 고른 글").selection, "지금 것");
});

test("본문 정리: 줄 끝 공백 · 3줄 넘는 빈 줄을 줄인다", () => {
  const p = L.buildPage({ text: "가  \r\n\r\n\r\n\r\n나\t\n" });
  assert.equal(p.text, "가\n\n나");
});

test("문서가 이상해도(body 없음 · 선택 읽기 오류) 멈추지 않는다", () => {
  const badWin = { location: { href: "https://x.test/" }, getSelection: () => { throw new Error("x"); } };
  const p = L.collectPage({ title: "t", body: null, activeElement: null }, badWin);
  assert.deepEqual(p, { title: "t", url: "https://x.test/", selection: "", text: "" });
});
