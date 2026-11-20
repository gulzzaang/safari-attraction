/**
 * 페이지 안에서 Locator 의 단계 목록(chain)을 풀어 요소를 찾는 코드(소스 글). DEEP_SOURCE · NAME_SOURCE 와 PRELUDE(fail) 뒤에 끼운다.
 *
 * - 후보는 평평한 트리(화면에 그려지는 순서: 열린 shadow root 는 호스트 자리, slot 은 배정된 노드 자리, 같은 출처 iframe 은 iframe 자리) 순서다.
 * - 첫 단계는 문서 전체에서, 다음 단계부터는 앞 단계로 좁혀진 요소들의 안쪽(자손)에서 찾는다.
 * - 역할 · 이름은 snapshot 줄과 같은 roleOf · nameInfo 로 잰다(여기에 ARIA 기본 역할 · 다른 이름 후보를 더한다).
 * - 동작은 pwPick(첫 번째로 「보이는」 것, 없으면 첫 번째)에 한다 — Playwright 와 달리 엄격하지 않다.
 * 백틱 · 달러-중괄호는 쓰지 않는다(String.raw).
 */
export const LOCATOR_SOURCE = String.raw`
  var pwMemo = null;
  function pwNorm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  // {s} 글 또는 {re, fl} 정규식 → 글을 받아 맞는지 답하는 함수. 글은 기본이 대소문자 무시 부분 일치, exact 면 통째로 같아야(대소문자 구분).
  function pwMake(m, exact) {
    if (m.re !== undefined) {
      var re = new RegExp(m.re, String(m.fl || '').replace(/[gy]/g, ''));
      return function (str) { return re.test(pwNorm(str)); };
    }
    var want = pwNorm(m.s);
    if (exact) return function (str) { return pwNorm(str) === want; };
    var lw = want.toLowerCase();
    return function (str) { return pwNorm(str).toLowerCase().indexOf(lw) >= 0; };
  }
  // 평평한 트리에서 el 의 자식 요소들.
  function pwKids(el) {
    if (el.shadowRoot) return Array.prototype.slice.call(el.shadowRoot.children);
    if (el.tagName === 'SLOT' && typeof el.assignedNodes === 'function') {
      var an = el.assignedNodes({ flatten: true }), out = [];
      for (var k = 0; k < an.length; k++) if (an[k].nodeType === 1) out.push(an[k]);
      return out;
    }
    if (el.tagName === 'IFRAME') {
      var d = null;
      try { d = el.contentDocument; } catch (x) {}
      return d && d.documentElement ? [d.documentElement] : [];
    }
    return Array.prototype.slice.call(el.children);
  }
  function pwFlat(el, withSelf, out) {
    if (withSelf) out.push(el);
    var ks = pwKids(el);
    for (var i = 0; i < ks.length; i++) pwFlat(ks[i], true, out);
    return out;
  }
  // 이번 단계가 찾아볼 후보 전부: 첫 단계면 문서 전체, 아니면 앞 단계 결과들의 자손(겹치면 한 번만).
  function pwUniverse(scope) {
    if (scope === null) return pwFlat(document.documentElement, true, []);
    var seen = new Set(), out = [];
    for (var i = 0; i < scope.length; i++) {
      var all = pwFlat(scope[i], false, []);
      for (var j = 0; j < all.length; j++) if (!seen.has(all[j])) { seen.add(all[j]); out.push(all[j]); }
    }
    return out;
  }
  function pwCss(scope, sel) {
    var s = __saSel(sel);
    if (scope === null) return Array.prototype.slice.call(__saDeepAll(s));
    var uni = pwUniverse(scope), out = [];
    for (var i = 0; i < uni.length; i++) if (uni[i].matches(s)) out.push(uni[i]);
    return out;
  }

  // 요소 아래의 평평한 글(숨은 것 · svg 는 뺀다). 한 번 구한 것은 pwMemo 에 둔다(모든 요소를 보아도 한 번씩만 센다).
  function pwText(el) {
    var v = pwMemo.get(el);
    if (v !== undefined) return v;
    var tg = el.tagName, s = '', disp = 'inline';
    if (SKIP_TAGS[tg] || el.getAttribute('aria-hidden') === 'true' || el.hidden) { pwMemo.set(el, ''); return ''; }
    if (tg !== 'SLOT') {
      try {
        var cs = el.ownerDocument.defaultView.getComputedStyle(el);
        disp = cs.display;
        if (cs.visibility === 'hidden' || cs.visibility === 'collapse' || disp === 'none') { pwMemo.set(el, ''); return ''; }
      } catch (x) {}
    }
    if (tg === 'INPUT' && /^(button|submit|reset)$/i.test(el.type || '')) s = el.value || '';
    else {
      var nodes;
      if (el.shadowRoot) nodes = el.shadowRoot.childNodes;
      else if (tg === 'SLOT' && typeof el.assignedNodes === 'function') nodes = el.assignedNodes({ flatten: true });
      else if (tg === 'IFRAME') nodes = pwKids(el);
      else nodes = el.childNodes;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.nodeType === 3) s += n.nodeValue;
        else if (n.nodeType === 1) s += pwText(n);
      }
    }
    if ((disp.indexOf('inline') !== 0 && disp !== 'contents') || tg === 'BR') s = ' ' + s + ' ';
    pwMemo.set(el, s);
    return s;
  }
  // 글에 맞는 가장 작은 요소들(자식 중에 맞는 것이 있으면 그 부모는 뺀다).
  function pwByText(scope, m, exact) {
    var test = pwMake(m, exact), uni = pwUniverse(scope), hit = new Set(), list = [];
    for (var i = 0; i < uni.length; i++) {
      if (SKIP_TAGS[uni[i].tagName]) continue;
      if (test(pwText(uni[i]))) { hit.add(uni[i]); list.push(uni[i]); }
    }
    return list.filter(function (el) {
      var ks = pwKids(el);
      for (var j = 0; j < ks.length; j++) if (hit.has(ks[j])) return false;
      return true;
    });
  }

  // 역할: snapshot 의 역할에 ARIA 기본 역할을 더한다(searchbox · heading · navigation …). role 속성이 있으면 그것이 우선.
  var PW_TAG_ROLE = { H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading', P: 'paragraph', LI: 'listitem', UL: 'list', OL: 'list',
    NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary', ARTICLE: 'article', FORM: 'form', TABLE: 'table', TR: 'row',
    TD: 'cell', TH: 'columnheader', IMG: 'img', DIALOG: 'dialog', HR: 'separator', OPTION: 'option', PROGRESS: 'progressbar', FIGURE: 'figure', SECTION: 'region' };
  function pwRoles(el) {
    var out = [], base = roleOf(el);
    var ex = (el.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase();
    if (ex) out.push(ex);
    if (base !== 'generic' && out.indexOf(base) < 0) out.push(base);
    if (!ex) {
      var tg = el.tagName, t = PW_TAG_ROLE[tg];
      if (t && out.indexOf(t) < 0) out.push(t);
      if (tg === 'INPUT') {
        var ty = (el.getAttribute('type') || 'text').toLowerCase();
        if (ty === 'search') out.push('searchbox');
        else if (ty === 'number') out.push('spinbutton');
        if (ty === 'text' || ty === 'search') { if (el.getAttribute('list')) out.push('combobox'); }
      }
      if (tg === 'TH' && out.indexOf('cell') < 0) out.push('cell');
    }
    return out;
  }
  // 그려지지 않는가: 자기 자신이 visibility hidden 이거나, 자신 · 조상(shadow 호스트 · iframe 바깥은 올라가지 않음)이 display none.
  function pwNoRender(el) {
    var cs = el.ownerDocument.defaultView.getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
    for (var e = el, n = 0; e && n < 200; e = e.parentElement || (e.getRootNode && e.getRootNode().host) || null, n++) {
      if (e.ownerDocument.defaultView.getComputedStyle(e).display === 'none') return true;
    }
    return false;
  }
  // 보이는 것인가(Playwright 의 보임: 크기가 있고 visibility 가 hidden 이 아님). iframe 안이면 iframe 도 보여야 한다.
  function pwShown1(el) {
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (typeof el.checkVisibility === 'function') return !!el.checkVisibility({ visibilityProperty: true });
    return !pwNoRender(el);
  }
  function pwVis(el) {
    if (!pwShown1(el)) return false;
    var w = el.ownerDocument.defaultView;
    for (var d = 0; w && w !== window && d < 10; d++) {
      var fe = null;
      try { fe = w.frameElement; } catch (x) {}
      if (!fe) break;
      if (!pwShown1(fe)) return false;
      w = fe.ownerDocument.defaultView;
    }
    return true;
  }
  // 접근성 트리에서 빠지는 것(그려지지 않음 · aria-hidden). getByRole 은 이런 것을 뺀다(크기 0 · 화면 밖은 뺀 것이 아니다).
  function pwHiddenA11y(el) {
    if (el.closest && el.closest('[aria-hidden="true"]')) return true;
    if (typeof el.checkVisibility === 'function') return !el.checkVisibility({ visibilityProperty: true });
    return pwNoRender(el);
  }
  // 이름 후보: snapshot 줄의 이름 + 자르지 않은 글 + aria-label · 연결된 label · placeholder · title · alt · value.
  function pwNames(el, role) {
    var out = [nameInfo(el, roleOf(el)).name];
    var t = el.tagName;
    if (t !== 'INPUT' && t !== 'TEXTAREA' && t !== 'SELECT') {
      out.push(flatText(el, 100000));
      // 평평한 글은 안 그려지는 요소 자신의 글을 비운다 — 요소 자신이 숨은 경우(includeHidden 로 찾는 숨은 단추)에만 날것 textContent 를 후보로 둔다.
      // (보이는 요소에 날것 글을 쓰면 안쪽에 숨은 글 · script · style 의 글이 이름으로 잡힌다.)
      if (pwHiddenA11y(el)) out.push(el.textContent || '');
    }
    var a = el.getAttribute('aria-label'); if (a) out.push(a);
    var lt = pwLabels(el); for (var i = 0; i < lt.length; i++) out.push(lt[i]);
    var p = el.getAttribute('placeholder'); if (p) out.push(p);
    var ti = el.getAttribute('title'); if (ti) out.push(ti);
    var al = el.getAttribute('alt'); if (al) out.push(al);
    if (role === 'button' && t === 'INPUT') out.push(el.getAttribute('value') || '');
    return out;
  }
  function pwLabels(el) {
    var out = [];
    var lb = el.getAttribute('aria-labelledby');
    if (lb) {
      var root = el.getRootNode();
      var ids = lb.split(/\s+/);
      for (var i = 0; i < ids.length; i++) {
        var t = ids[i] && root.getElementById ? root.getElementById(ids[i]) : null;
        if (t) out.push(t.textContent || '');
      }
    }
    try { if (el.labels) for (var j = 0; j < el.labels.length; j++) out.push(el.labels[j].textContent || ''); } catch (e) {}
    return out;
  }
  // 체크 상태: true · false · 'mixed', 상태가 없는 요소는 null.
  function pwChecked(el) {
    if (el.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(el.type)) return el.type === 'checkbox' && el.indeterminate ? 'mixed' : !!el.checked;
    return pwAria(el, 'aria-checked');
  }
  function pwAria(el, name) { var a = el.getAttribute(name); return a === 'true' ? true : a === 'false' ? false : a === 'mixed' ? 'mixed' : null; }
  function pwLevel(el) {
    var m = /^H([1-6])$/.exec(el.tagName);
    if (m) return +m[1];
    var l = parseInt(el.getAttribute('aria-level') || '', 10);
    return isNaN(l) ? null : l;
  }
  function pwExpanded(el) {
    var a = pwAria(el, 'aria-expanded');
    if (a !== null) return a;
    if (el.tagName === 'SUMMARY' && el.parentElement && el.parentElement.tagName === 'DETAILS') return !!el.parentElement.open;
    return null;
  }
  function pwSelected(el) { return el.tagName === 'OPTION' ? !!el.selected : pwAria(el, 'aria-selected'); }
  // getByRole 의 상태 옵션(level · checked · pressed · expanded · selected)에 맞는가.
  function pwStateOk(el, st) {
    if (st.level !== undefined && pwLevel(el) !== st.level) return false;
    if (st.checked !== undefined && pwChecked(el) !== st.checked) return false;
    if (st.pressed !== undefined && pwAria(el, 'aria-pressed') !== st.pressed) return false;
    if (st.expanded !== undefined && pwExpanded(el) !== st.expanded) return false;
    if (st.selected !== undefined && pwSelected(el) !== st.selected) return false;
    return true;
  }
  function pwByRole(scope, st) {
    var test = st.name ? pwMake(st.name, st.exact) : null, uni = pwUniverse(scope), out = [];
    for (var i = 0; i < uni.length; i++) {
      var el = uni[i];
      if (pwRoles(el).indexOf(st.role) < 0) continue;
      if (!st.includeHidden && pwHiddenA11y(el)) continue;
      if (!pwStateOk(el, st)) continue;
      if (test) {
        var names = pwNames(el, st.role), hit = false;
        for (var j = 0; j < names.length && !hit; j++) hit = test(names[j]);
        if (!hit) continue;
      }
      out.push(el);
    }
    return out;
  }
  function pwByAttr(scope, st) {
    var test = pwMake(st.m, st.k === 'testid' ? true : st.exact), uni = pwUniverse(scope), out = [];
    for (var i = 0; i < uni.length; i++) {
      var el = uni[i], hit = false;
      if (st.k === 'testid') { var id = el.getAttribute('data-testid'); hit = id !== null && test(id); }
      else if (st.k === 'placeholder') { var ph = el.getAttribute('placeholder'); hit = ph !== null && test(ph); }
      else {
        var al = el.getAttribute('aria-label');
        var texts = (al ? [al] : []).concat(pwLabels(el));
        for (var j = 0; j < texts.length && !hit; j++) hit = test(texts[j]);
      }
      if (hit) out.push(el);
    }
    return out;
  }

  // chain 을 풀어 맞는 요소들(평평한 트리 순서)을 돌려준다.
  function pwResolve(chain) {
    pwMemo = new Map();
    var cur = null;
    for (var i = 0; i < chain.length; i++) {
      var st = chain[i];
      switch (st.k) {
        case 'css': case 'ref': case 'sub':
          try { cur = pwCss(cur, st.s); } catch (e) { fail('선택자가 잘못됨: ' + st.s); }
          break;
        case 'role': cur = pwByRole(cur, st); break;
        case 'text': cur = pwByText(cur, st.m, st.exact); break;
        case 'label': case 'placeholder': case 'testid': cur = pwByAttr(cur, st); break;
        case 'nth': {
          var ix = st.i < 0 ? cur.length + st.i : st.i;
          cur = ix >= 0 && ix < cur.length ? [cur[ix]] : [];
          break;
        }
        case 'hasText': {
          var t = pwMake(st.m, !!st.exact), neg = !!st.not;
          cur = cur.filter(function (el) { return t(pwText(el)) !== neg; });
          if (st.deep) {
            // 가장 깊은(작은) 것만: 맞는 자손이 있는 요소는 뺀다(html · body 같은 바깥 요소를 누르지 않게).
            var hitSet = new Set(cur);
            cur = cur.filter(function (el) {
              var ds = pwFlat(el, false, []);
              for (var di = 0; di < ds.length; di++) if (hitSet.has(ds[di])) return false;
              return true;
            });
          }
          break;
        }
        default: fail('알 수 없는 찾기 단계: ' + st.k);
      }
    }
    return cur === null ? [] : cur;
  }
  // 동작 대상: 보이는 첫 번째, 보이는 것이 없으면 첫 번째.
  function pwPick(m) {
    for (var i = 0; i < m.length; i++) if (pwVis(m[i])) return m[i];
    return m[0];
  }
  function pwEnabled(el) { return !(el.disabled || (el.matches && el.matches(':disabled')) || el.getAttribute('aria-disabled') === 'true'); }
  function pwOn(el) { return el.tagName === 'INPUT' ? !!el.checked : el.getAttribute('aria-checked') === 'true'; }
  function pwInnerText(el) {
    var t = el.innerText;
    if (typeof t === 'string' && t.trim()) return t;
    var f = flatText(el, 100000); // 사파리의 innerText 는 slot 에 배정된 노드를 빼 먹는다
    return f || (typeof t === 'string' ? t : '');
  }
`;
