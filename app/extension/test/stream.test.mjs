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

test("/info 는 loggedIn · effortLabel 이 null 일 수 있고 모르는 키는 버린다", () => {
  assert.deepEqual(L.toInfoMessage({ cli: "claude", cliName: "클로드", model: null, effortLabel: null, loggedIn: null, token: TOKEN }), {
    t: "info", cli: "claude", cliName: "클로드", model: null, effortLabel: null, loggedIn: null,
  });
  assert.deepEqual(L.toInfoMessage({ cli: "x", cliName: "엑스", model: "M", effortLabel: "높음", loggedIn: false }), {
    t: "info", cli: "x", cliName: "엑스", model: "M", effortLabel: "높음", loggedIn: false,
  });
  assert.deepEqual(L.toInfoMessage(null), { t: "info", cli: null, cliName: null, model: null, effortLabel: null, loggedIn: null });
});

test("status/card/card-closed pass whitelist and scrub token", () => {
  const st = L.toPanelMessage({ t: "status", text: `검색 중 ${TOKEN}`, extra: 1 }, TOKEN);
  assert.deepEqual(st, { t: "status", text: "검색 중 …" });

  const card = L.toPanelMessage({
    t: "card",
    card: {
      id: "c1", kind: "action", title: `허락 ${TOKEN}`, detail: `내용 ${TOKEN}`,
      host: `shop.test/${TOKEN}`, canAlwaysAllow: true, secret: TOKEN,
    },
    extra: 1,
  }, TOKEN);
  assert.deepEqual(card, {
    t: "card",
    card: { id: "c1", kind: "action", title: "허락 …", detail: "내용 …", host: "shop.test/…", canAlwaysAllow: true },
  });
  assert.ok(!JSON.stringify(card).includes(TOKEN));

  // danger · code 카드는 서버가 canAlwaysAllow: true 를 보내도 false 로 내린다.
  const danger = L.toPanelMessage({
    t: "card",
    card: { id: "c2", kind: "danger", title: "위험", detail: "결제", host: "pay.test", canAlwaysAllow: true },
  }, TOKEN);
  assert.equal(danger.card.canAlwaysAllow, false);

  const closed = L.toPanelMessage({ t: "card-closed", id: "c1", result: "allowed", extra: TOKEN }, TOKEN);
  assert.deepEqual(closed, { t: "card-closed", id: "c1", result: "allowed" });
  assert.ok(!JSON.stringify(closed).includes(TOKEN));
});

test("unknown kinds dropped", () => {
  assert.equal(L.toPanelMessage({ t: "unknown", text: "x" }), null);
  assert.equal(L.toPanelMessage({ t: "status", text: "" }), null);
  assert.equal(L.toPanelMessage({ t: "card", card: { id: "c1", kind: "weird", title: "t", detail: "", host: "" } }), null);
  assert.equal(L.toPanelMessage({ t: "card", card: { id: "", kind: "action", title: "t", detail: "", host: "" } }), null);
  assert.equal(L.toPanelMessage({ t: "card-closed", id: "c1", result: "bogus" }), null);
});

test("질문 번호: 지금 번호가 아닌 답 줄은 버린다(멈춘 뒤 · 새 질문 뒤 옛 줄)", () => {
  const A = L.acceptForAsk;
  assert.equal(A({ t: "delta", id: 2, text: "x" }, 2), true);
  assert.equal(A({ t: "status", id: 2, text: "검색 중" }, 2), true);
  assert.equal(A({ t: "card", id: 2, card: { id: "c1" } }, 2), true);
  assert.equal(A({ t: "card-closed", id: 2, result: "allowed" }, 2), true);
  assert.equal(A({ t: "status", id: 1, text: "옛" }, 2), false);
  assert.equal(A({ t: "card", id: 1, card: { id: "c1" } }, 2), false);
  assert.equal(A({ t: "card-closed", id: 1, result: "allowed" }, 2), false);
  assert.equal(A({ t: "delta", id: 1, text: "옛" }, 2), false);
  assert.equal(A({ t: "done", id: 1 }, 2), false);
  assert.equal(A({ t: "error", id: 3, message: "x" }, 2), false);
  assert.equal(A({ t: "delta", id: 2, text: "x" }, null), false); // 멈춤 뒤
  assert.equal(A({ t: "delta", text: "번호 없음" }, 2), false);
  assert.equal(A({ t: "info", cliName: "클로드" }, null), true);
  assert.equal(A({ t: "info-error", message: "x" }, 2), true);
  assert.equal(A(null, 1), false);
});
