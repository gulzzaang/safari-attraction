// 사파리-어트랙션 — 사이트 알림 엿듣기(페이지 세계 · MAIN world · document_start).
// 페이지의 `Notification` 생성자와 `ServiceWorkerRegistration.prototype.showNotification` 을 감싸,
// 원래 것을 그대로 부른 뒤 알림 제목 · 내용을 `window.postMessage({ __safariAttractionAlert: 1, title, body }, "*")` 로
// 같은 탭의 content script 에게 넘긴다. **페이지 동작은 바꾸지 않는다**: 원래 생성자 · 메서드를 같은 인자로 부르고
// 그 결과(객체 · Promise · 예외)를 그대로 돌려주며, 감싼 쪽의 오류는 모두 삼킨다.
// 이 파일은 확장 API 를 쓰지 않는다(페이지 세계엔 없다). 사파리가 world 설정을 무시해 격리 세계에서 돌면
// 페이지의 알림을 못 감쌀 뿐 아무 해가 없다(그 세계의 Notification 을 부르는 코드가 없으니 아무 일도 안 생긴다).
(function (win) {
  "use strict";
  try {
    if (!win || (typeof win !== "object" && typeof win !== "function")) return;

    // 두 번 실려도 한 번만 감싼다.
    const MARK = Symbol.for("safariAttraction.notifyHook");
    if (win[MARK]) return;
    try {
      Object.defineProperty(win, MARK, { value: true, enumerable: false, configurable: false, writable: false });
    } catch (_) {
      return; // 표시를 못 남기는 이상한 window 면 아무것도 안 한다
    }

    const fnToString = Function.prototype.toString;
    const LIMIT = 1000;

    function post(title, body) {
      try {
        // 글이 아닌 값은 빈 글 — 페이지 객체의 toString 을 부르지 않는다(부작용 없음).
        const t = typeof title === "string" ? title.slice(0, LIMIT * 2) : "";
        const b = typeof body === "string" ? body.slice(0, LIMIT * 2) : "";
        win.postMessage({ __safariAttractionAlert: 1, title: t, body: b }, "*");
      } catch (_) { /* 삼킨다 */ }
    }

    /** 감싼 함수의 이름 · 길이 · toString 을 원래 것과 같게. */
    function mask(fake, real) {
      try { Object.defineProperty(fake, "name", { value: real.name, configurable: true }); } catch (_) { /* 무시 */ }
      try { Object.defineProperty(fake, "length", { value: real.length, configurable: true }); } catch (_) { /* 무시 */ }
      try {
        Object.defineProperty(fake, "toString", {
          value: function toString() { return fnToString.call(real); },
          writable: true, enumerable: false, configurable: true,
        });
      } catch (_) { /* 무시 */ }
    }

    // ── new Notification(title, options) ─────────────────────────────────────
    const Orig = win.Notification;
    if (typeof Orig === "function") {
      const Wrapped = function Notification(title, options) {
        // new 없이 부르면 원래 것을 그대로 불러 원래 오류(또는 동작)를 낸다.
        if (!new.target) return Orig.apply(this, arguments);
        const made = Reflect.construct(Orig, arguments, new.target === Wrapped ? Orig : new.target);
        try { post(made.title, made.body); } catch (_) { /* 삼킨다 */ }
        return made;
      };
      let ready = true;
      try {
        Wrapped.prototype = Orig.prototype; // instanceof Notification 이 그대로 참
        Object.setPrototypeOf(Wrapped, Object.getPrototypeOf(Orig));
      } catch (_) {
        ready = false;
      }
      if (ready) {
        // 정적 속성 · 메서드(permission · requestPermission · maxActions …)를 원래 것으로 이어 준다.
        for (const key of Reflect.ownKeys(Orig)) {
          if (key === "prototype" || key === "length" || key === "name" || key === "arguments" || key === "caller") continue;
          try {
            const d = Object.getOwnPropertyDescriptor(Orig, key);
            if (!d) continue;
            if (d.get || d.set) {
              const getter = d.get;
              const setter = d.set;
              Object.defineProperty(Wrapped, key, {
                get: getter ? function () { return getter.call(Orig); } : undefined,
                set: setter ? function (v) { setter.call(Orig, v); } : undefined,
                enumerable: d.enumerable, configurable: true,
              });
            } else if (typeof d.value === "function") {
              const real = d.value;
              const forward = function () { return real.apply(Orig, arguments); };
              mask(forward, real);
              Object.defineProperty(Wrapped, key, { value: forward, writable: d.writable, enumerable: d.enumerable, configurable: true });
            } else {
              Object.defineProperty(Wrapped, key, {
                get: function () { return Orig[key]; },
                enumerable: d.enumerable, configurable: true,
              });
            }
          } catch (_) { /* 그 속성 하나만 못 이음 */ }
        }
        mask(Wrapped, Orig);

        let replaced = false;
        try {
          const wd = Object.getOwnPropertyDescriptor(win, "Notification");
          if (wd && "value" in wd) {
            Object.defineProperty(win, "Notification", {
              value: Wrapped, writable: wd.writable, enumerable: wd.enumerable, configurable: wd.configurable,
            });
          } else {
            win.Notification = Wrapped;
          }
          replaced = win.Notification === Wrapped;
        } catch (_) {
          replaced = false;
        }
        if (replaced) {
          // n.constructor === Notification 이 그대로 참이도록(바꿨을 때만).
          try {
            const cd = Object.getOwnPropertyDescriptor(Orig.prototype, "constructor");
            if (cd && cd.value === Orig && cd.configurable) {
              Object.defineProperty(Orig.prototype, "constructor", {
                value: Wrapped, writable: cd.writable, enumerable: cd.enumerable, configurable: true,
              });
            }
          } catch (_) { /* 무시 */ }
        }
      }
    }

    // ── registration.showNotification(title, options) ────────────────────────
    const SWR = win.ServiceWorkerRegistration;
    const proto = SWR && SWR.prototype;
    let sd = null;
    try { sd = proto ? Object.getOwnPropertyDescriptor(proto, "showNotification") : null; } catch (_) { sd = null; }
    if (sd && typeof sd.value === "function") {
      const origShow = sd.value;
      const showNotification = function showNotification(title, options) {
        const result = origShow.apply(this, arguments); // 원래 예외 · Promise 그대로
        try {
          let body = "";
          if (options && typeof options === "object") {
            try { body = options.body; } catch (_) { body = ""; }
          }
          post(title, body);
        } catch (_) { /* 삼킨다 */ }
        return result;
      };
      mask(showNotification, origShow);
      try {
        Object.defineProperty(proto, "showNotification", {
          value: showNotification, writable: sd.writable, enumerable: sd.enumerable, configurable: sd.configurable,
        });
      } catch (_) { /* 못 바꾸면 원래 것 그대로 */ }
    }
  } catch (_) {
    /* 무엇이든 삼킨다 — 페이지는 절대 망가지지 않는다 */
  }
})(typeof window !== "undefined" ? window : undefined);
