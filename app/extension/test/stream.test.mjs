import test from "node:test";
import assert from "node:assert/strict";
import "../lib/stream.js";

const L = globalThis.SAPanelLib;
const enc = new TextEncoder();
const TOKEN = "ab".repeat(32);

test("줄 단위로 읽고 빈 줄 · 깨진 줄은 건너뛴다", () => {
  const r = new L.NdjsonReader();
  const out = r.push('{"t":"delta","text":"안"}\n\n깨진 줄\n{"t":"done","usage":null}\n');
  assert.deepEqual(out.map((o) => o.t), ["delta", "done"]);
  assert.equal(r.skipped, 1);
});

test("조각 경계가 줄 가운데에 걸려도 이어 붙인다", () => {
  const r = new L.NdjsonReader();
  assert.deepEqual(r.push('{"t":"delta","te'), []);
  assert.deepEqual(r.push('xt":"하이"}\n{"t":"do'), [{ t: "delta", text: "하이" }]);
  assert.deepEqual(r.push('ne"}\n'), [{ t: "done" }]);
});

test("한글 한 글자(UTF-8 3바이트) 가운데에서 잘린 바이트 조각도 이어 붙인다", () => {
  const bytes = enc.encode('{"t":"delta","text":"가나다 😀"}\n');
  // 모든 가능한 자리에서 둘로 쪼개 본다.
  for (let cut = 1; cut < bytes.length; cut++) {
    const r = new L.NdjsonReader();
    const got = [...r.push(bytes.slice(0, cut)), ...r.push(bytes.slice(cut))];
    assert.deepEqual(got, [{ t: "delta", text: "가나다 😀" }], `cut=${cut}`);
  }
});

test("바이트를 하나씩 보내도 읽힌다", () => {
  const bytes = enc.encode('{"t":"delta","text":"한글"}\n{"t":"done"}\n');
  const r = new L.NdjsonReader();
  const got = [];
  for (const b of bytes) got.push(...r.push(new Uint8Array([b])));
  assert.deepEqual(got.map((o) => o.t), ["delta", "done"]);
});

test("줄바꿈 없이 끝난 마지막 줄은 end() 에서 읽는다", () => {
  const r = new L.NdjsonReader();
  assert.deepEqual(r.push('{"t":"done"}'), []);
  assert.deepEqual(r.end(), [{ t: "done" }]);
  assert.deepEqual(r.end(), []);
});

test("t 가 없거나 객체가 아닌 줄은 버린다", () => {
  assert.equal(L.parseLine("[1,2]"), null);
  assert.equal(L.parseLine('"글"'), null);
  assert.equal(L.parseLine('{"text":"x"}'), null);
  assert.equal(L.parseLine('{"t":5}'), null);
  assert.deepEqual(L.parseLine(' {"t":"done"} '), { t: "done" });
});

test("패널 메시지는 허용 목록 모양만: 모르는 키 · 모르는 종류는 버린다", () => {
  assert.deepEqual(L.toPanelMessage({ t: "delta", text: "안녕", extra: "x" }), { t: "delta", text: "안녕" });
  assert.deepEqual(L.toPanelMessage({ t: "done", usage: { total: 3 }, token: TOKEN }), { t: "done" });
  assert.deepEqual(L.toPanelMessage({ t: "error", message: "실패", secret: 1 }), { t: "error", message: "실패" });
  assert.equal(L.toPanelMessage({ t: "wat" }), null);
  assert.equal(L.toPanelMessage({ t: "delta", text: 5 }), null);
  assert.equal(L.toPanelMessage({ t: "delta", text: "" }), null);
  assert.equal(L.toPanelMessage(null), null);
});

test("토큰 값은 어느 패널 메시지에도 남지 않는다", () => {
  const d = L.toPanelMessage({ t: "delta", text: `앞 ${TOKEN} 뒤` }, TOKEN);
  const e = L.toPanelMessage({ t: "error", message: `실패 ${TOKEN}` }, TOKEN);
  const i = L.toInfoMessage({ cli: "claude", cliName: `클로드${TOKEN}`, model: "m", loggedIn: true }, TOKEN);
  for (const m of [d, e, i]) assert.ok(!JSON.stringify(m).includes(TOKEN), JSON.stringify(m));
});

test("error 에 글이 없으면 일반 안내", () => {
  assert.equal(L.toPanelMessage({ t: "error" }).message, "앱이 오류로 답했어요");
});

test("/info 는 loggedIn 이 null 일 수 있고 모르는 키는 버린다", () => {
  assert.deepEqual(L.toInfoMessage({ cli: "claude", cliName: "클로드", model: null, loggedIn: null, token: TOKEN }), {
    t: "info", cli: "claude", cliName: "클로드", model: null, loggedIn: null,
  });
  assert.deepEqual(L.toInfoMessage({ cli: "x", cliName: "엑스", model: "M", loggedIn: false }).loggedIn, false);
  assert.deepEqual(L.toInfoMessage(null), { t: "info", cli: null, cliName: null, model: null, loggedIn: null });
});
