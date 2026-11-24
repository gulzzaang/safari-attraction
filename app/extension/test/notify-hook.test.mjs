import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "notify-hook.js"), "utf8");

class FakeEventTarget {}

/** 가짜 window — 진짜 Notification 처럼 new 없이 부르면 TypeError, 인자 없으면 TypeError, 정적 permission · requestPermission · maxActions. */
function fakeWindow({ postThrows = false } = {}) {
  const state = { permission: "default", constructed: 0, shown: [] };
  class Notification extends FakeEventTarget {
    constructor(title, options) {
      super();
      if (arguments.length === 0) throw new TypeError("Not enough arguments");
      state.constructed++;
      this._title = String(title);
      this._body = options && options.body !== undefined ? String(options.body) : "";
    }
    get title() { return this._title; }
    get body() { return this._body; }
    close() { this.closed = true; }
    static get permission() { return state.permission; }
    static requestPermission(cb) {
      const p = Promise.resolve("granted");
      if (typeof cb === "function") cb("granted");
      return p;
    }
    static get maxActions() { return 2; }
  }
  class ServiceWorkerRegistration {
    showNotification(title, options) {
      if (!(this instanceof ServiceWorkerRegistration)) throw new TypeError("Illegal invocation");
      state.shown.push({ self: this, title, options });
      if (title === "거절") return Promise.reject(new TypeError("No permission"));
      return Promise.resolve(undefined);
    }
  }
  const posted = [];
  const win = {
    Notification,
    ServiceWorkerRegistration,
    postMessage(data, origin) {
      if (postThrows) throw new Error("post 실패");
      posted.push({ data, origin });
    },
  };
  return { win, state, posted, Orig: Notification, OrigSWR: ServiceWorkerRegistration };
}

function install(win) {
  new Function("window", src)(win);
}

test("감싼 뒤에도 new Notification 이 원래 객체를 돌려주고 알림 글을 페이지 메시지로 넘긴다", () => {
  const f = fakeWindow();
  install(f.win);
  assert.notEqual(f.win.Notification, f.Orig);
  const n = new f.win.Notification("새 메일", { body: "안녕하세요" });
  assert.equal(f.state.constructed, 1);
  assert.ok(n instanceof f.win.Notification);
  assert.ok(n instanceof f.Orig);
  assert.equal(Object.getPrototypeOf(n), f.Orig.prototype);
  assert.equal(n.title, "새 메일");
  n.close();
  assert.equal(n.closed, true);
  assert.deepEqual(f.posted, [{ data: { __safariAttractionAlert: 1, title: "새 메일", body: "안녕하세요" }, origin: "*" }]);
});

test("정적 속성 · 메서드가 그대로: permission(살아 있는 값) · requestPermission(콜백 · Promise) · maxActions", async () => {
  const f = fakeWindow();
  install(f.win);
  const N = f.win.Notification;
  assert.equal(N.permission, "default");
  f.state.permission = "granted";
  assert.equal(N.permission, "granted");
  let cbValue = null;
  const result = await N.requestPermission((v) => { cbValue = v; });
  assert.equal(result, "granted");
  assert.equal(cbValue, "granted");
  assert.equal(N.maxActions, 2);
  assert.equal(N.prototype, f.Orig.prototype);
  assert.equal(N.name, "Notification");
  assert.equal(N.length, f.Orig.length);
  assert.equal(N.toString(), Function.prototype.toString.call(f.Orig));
  assert.equal(Object.getPrototypeOf(N), Object.getPrototypeOf(f.Orig));
  assert.equal(new N("x").constructor, N);
});

test("원래 예외가 그대로 난다(new 없이 부름 · 인자 없음) — 그때는 알림을 넘기지 않는다", () => {
  const f = fakeWindow();
  install(f.win);
  assert.throws(() => f.win.Notification("x"), TypeError);
  assert.throws(() => new f.win.Notification(), /Not enough arguments/);
  assert.deepEqual(f.posted, []);
});

test("페이지가 Notification 을 상속해도 그대로 동작한다", () => {
  const f = fakeWindow();
  install(f.win);
  class Mine extends f.win.Notification {
    constructor(t, o) { super(t, o); this.mine = true; }
  }
  const m = new Mine("상속", { body: "b" });
  assert.ok(m instanceof Mine);
  assert.ok(m instanceof f.win.Notification);
  assert.equal(m.mine, true);
  assert.equal(m.title, "상속");
  assert.equal(f.posted.length, 1);
});

test("감싼 쪽 오류(postMessage 실패)는 삼키고 페이지 알림은 그대로", async () => {
  const f = fakeWindow({ postThrows: true });
  install(f.win);
  const n = new f.win.Notification("t", { body: "b" });
  assert.equal(n.title, "t");
  const reg = new f.win.ServiceWorkerRegistration();
  await reg.showNotification("t", { body: "b" });
  assert.equal(f.state.shown.length, 1);
});

test("showNotification 은 원래 것을 같은 this · 인자로 부르고 그 Promise 를 그대로 돌려준다", async () => {
  const f = fakeWindow();
  install(f.win);
  const reg = new f.win.ServiceWorkerRegistration();
  const opts = { body: "푸시 글", tag: "t1" };
  const p = reg.showNotification("서비스 워커 알림", opts);
  assert.ok(p instanceof Promise);
  await p;
  assert.equal(f.state.shown[0].self, reg);
  assert.equal(f.state.shown[0].options, opts);
  assert.deepEqual(f.posted.map((x) => x.data), [{ __safariAttractionAlert: 1, title: "서비스 워커 알림", body: "푸시 글" }]);
  await assert.rejects(reg.showNotification("거절"), /No permission/);
  assert.equal(f.posted.length, 1); // 거절된 showNotification 은 알리지 않는다
  assert.throws(() => f.win.ServiceWorkerRegistration.prototype.showNotification.call({}, "x"), /Illegal invocation/);
  assert.equal(f.win.ServiceWorkerRegistration.prototype.showNotification.name, "showNotification");
});

test("글이 아닌 제목 · 내용은 빈 글로(페이지 객체의 toString 을 부르지 않는다)", async () => {
  const f = fakeWindow();
  install(f.win);
  let called = 0;
  const sneaky = { toString() { called++; return "x"; } };
  await new f.win.ServiceWorkerRegistration().showNotification(sneaky, { body: sneaky });
  assert.equal(called, 0);
  assert.deepEqual(f.posted[0].data, { __safariAttractionAlert: 1, title: "", body: "" });
});

test("두 번 실려도 한 번만 감싼다", () => {
  const f = fakeWindow();
  install(f.win);
  const once = f.win.Notification;
  install(f.win);
  assert.equal(f.win.Notification, once);
  new f.win.Notification("하나");
  assert.equal(f.posted.length, 1);
});

test("Notification · ServiceWorkerRegistration 이 없거나 이상해도 오류 없이 아무 일도 안 한다", () => {
  assert.doesNotThrow(() => install({ postMessage() {} }));
  assert.doesNotThrow(() => install({ Notification: 5, ServiceWorkerRegistration: {} }));
  assert.doesNotThrow(() => install(undefined));
  const frozen = fakeWindow();
  Object.freeze(frozen.win);
  assert.doesNotThrow(() => install(frozen.win));
  assert.equal(frozen.win.Notification, frozen.Orig); // 못 바꾸면 원래 것 그대로
  new frozen.win.Notification("x"); // 원래 것도 멀쩡히 돈다
});

test("이 파일은 확장 API(browser · chrome)를 쓰지 않는다(페이지 세계엔 없음)", () => {
  const code = src.replace(/\/\/.*$/gm, "");
  assert.ok(!/\bbrowser\b|\bchrome\b/.test(code));
});
