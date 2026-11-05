/**
 * 시간 계량기 · 노션 → 구글 캘린더 동기화 v1
 *
 * 노션 데이터베이스의 날짜 항목을 내 구글 캘린더('노션 TASK')에 15분마다 옮겨 적는다.
 *   - 시간까지 있는 항목 → 시간 일정 / 날짜만 있는 항목 → 종일 일정
 *   - 노션에서 고치면 캘린더도 고쳐지고, 지우거나 완료하면 캘린더에서도 지워진다.
 *   - 어제 이후 항목만 다룬다. 지난 일정은 건드리지 않는다.
 *
 * 설정 (프로젝트 설정 → 스크립트 속성)
 *   NOTION_TOKEN        (필수) 노션 통합 토큰 (ntn_ 또는 secret_ 로 시작)
 *   NOTION_DATABASE_ID  (필수) 데이터베이스 주소 또는 ID
 *   DATE_PROP           (선택) 날짜 속성 이름. 비우면 첫 번째 날짜 속성
 *   DONE_PROP           (선택) 완료 속성 이름(체크박스 또는 상태). 비우면 '완료/Done' 이름을 자동으로 찾음
 *   CALENDAR_NAME       (선택) 기본 '노션 TASK'
 *
 * 처음 한 번: 함수 목록에서 setup 을 골라 실행 → 권한 허용.
 */

var NOTION_VERSION = '2022-06-28';
var DONE_VALUES = /^(완료|완료됨|끝|done|complete|completed)$/i;
var TAG = 'notionId';

function setup() {
  var cal = calendar_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sync').timeBased().everyMinutes(15).create();
  var r = sync();
  Logger.log('준비 완료 · 캘린더 "' + cal.getName() + '" · ' + JSON.stringify(r));
  return r;
}

function props_() {
  var p = PropertiesService.getScriptProperties();
  var token = (p.getProperty('NOTION_TOKEN') || '').trim();
  var db = (p.getProperty('NOTION_DATABASE_ID') || '').trim();
  if (!token) throw new Error('스크립트 속성 NOTION_TOKEN 이 비어 있어요.');
  var m = db.replace(/-/g, '').match(/[0-9a-f]{32}/i);
  if (!m) throw new Error('스크립트 속성 NOTION_DATABASE_ID 에서 데이터베이스 ID(32자리)를 찾지 못했어요.');
  return {
    token: token,
    db: m[0],
    dateProp: (p.getProperty('DATE_PROP') || '').trim(),
    doneProp: (p.getProperty('DONE_PROP') || '').trim(),
    calName: (p.getProperty('CALENDAR_NAME') || '').trim() || '노션 TASK'
  };
}

function calendar_() {
  var name = props_().calName;
  var list = CalendarApp.getCalendarsByName(name);
  if (list && list.length) return list[0];
  return CalendarApp.createCalendar(name);
}

function notion_(cfg, method, path, body) {
  var opt = {
    method: method,
    muteHttpExceptions: true,
    headers: { 'Authorization': 'Bearer ' + cfg.token, 'Notion-Version': NOTION_VERSION }
  };
  if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
  var res = UrlFetchApp.fetch('https://api.notion.com' + path, opt);
  var code = res.getResponseCode();
  var data = {};
  try { data = JSON.parse(res.getContentText()); } catch (e) {}
  if (code === 404) throw new Error('노션 데이터베이스를 찾지 못했어요. 데이터베이스 ··· → 연결에서 이 통합을 추가했는지 확인해 주세요.');
  if (code === 401) throw new Error('노션 토큰이 맞지 않아요. NOTION_TOKEN 을 확인해 주세요.');
  if (code !== 200) throw new Error('노션 오류 ' + code + ' ' + (data.message || ''));
  return data;
}

function plain_(arr) {
  return (arr || []).map(function (t) { return t.plain_text || ''; }).join('').trim();
}

function isDone_(prop) {
  if (!prop) return false;
  if (prop.type === 'checkbox') return !!prop.checkbox;
  if (prop.type === 'status') return !!(prop.status && DONE_VALUES.test(prop.status.name || ''));
  if (prop.type === 'select') return !!(prop.select && DONE_VALUES.test(prop.select.name || ''));
  return false;
}

function ymd_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/** '2026-11-05' → 스크립트 시간대 기준 그날 0시 */
function dayOf_(s) {
  var a = String(s).slice(0, 10).split('-').map(Number);
  return new Date(a[0], a[1] - 1, a[2]);
}

function readSchema_(cfg) {
  var db = notion_(cfg, 'GET', '/v1/databases/' + cfg.db);
  var props = db.properties || {};
  var titleKey = null, dateKey = cfg.dateProp || null, doneKey = cfg.doneProp || null;
  Object.keys(props).forEach(function (k) {
    var t = props[k].type;
    if (t === 'title') titleKey = k;
    if (!cfg.dateProp && !dateKey && t === 'date') dateKey = k;
    if (!cfg.doneProp && !doneKey && (t === 'checkbox' || t === 'status') && /완료|done|complete/i.test(k)) doneKey = k;
  });
  if (!doneKey && !cfg.doneProp) {
    Object.keys(props).forEach(function (k) { if (!doneKey && props[k].type === 'status') doneKey = k; });
  }
  if (!dateKey || !props[dateKey] || props[dateKey].type !== 'date') throw new Error('날짜 속성을 찾지 못했어요. DATE_PROP 을 확인해 주세요.');
  return { titleKey: titleKey, dateKey: dateKey, doneKey: doneKey && props[doneKey] ? doneKey : null };
}

function wanted_(cfg, sc) {
  var y = new Date(); y.setDate(y.getDate() - 1);
  var body = {
    page_size: 100,
    filter: { property: sc.dateKey, date: { on_or_after: ymd_(y) } },
    sorts: [{ property: sc.dateKey, direction: 'ascending' }]
  };
  var out = {}, cursor = null;
  for (var i = 0; i < 10; i++) {
    if (cursor) body.start_cursor = cursor;
    var r = notion_(cfg, 'POST', '/v1/databases/' + cfg.db + '/query', body);
    (r.results || []).forEach(function (pg) {
      if (pg.archived || pg.in_trash) return;
      var p = pg.properties || {};
      var d = p[sc.dateKey] && p[sc.dateKey].date;
      if (!d || !d.start) return;
      if (sc.doneKey && isDone_(p[sc.doneKey])) return;
      var title = (sc.titleKey && p[sc.titleKey] && plain_(p[sc.titleKey].title)) || '(제목 없음)';
      var allDay = !/T\d{2}:/.test(d.start);
      var s, e;
      if (allDay) {
        s = dayOf_(d.start);
        e = d.end ? dayOf_(d.end) : new Date(s.getTime());
        e.setDate(e.getDate() + 1); // 종일 일정 끝은 다음 날 0시
        if (e <= s) { e = new Date(s.getTime()); e.setDate(e.getDate() + 1); }
      } else {
        s = new Date(d.start);
        e = d.end ? new Date(d.end) : new Date(s.getTime() + 60 * 60000);
        if (!(e > s)) e = new Date(s.getTime() + 60 * 60000);
      }
      out[pg.id] = { id: pg.id, title: title, allDay: allDay, s: s, e: e, url: pg.url || '' };
    });
    if (!r.has_more) break;
    cursor = r.next_cursor;
  }
  return out;
}

function sync() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { skipped: 'busy' };
  try {
    var cfg = props_();
    var sc = readSchema_(cfg);
    var want = wanted_(cfg, sc);
    var cal = calendar_();
    var from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - 1);
    var to = new Date(from.getTime()); to.setDate(to.getDate() + 400);
    var have = {};
    cal.getEvents(from, to).forEach(function (ev) {
      var id = ev.getTag(TAG);
      if (!id) return;
      if (have[id]) { ev.deleteEvent(); return; } // 중복 정리
      have[id] = ev;
    });
    var made = 0, changed = 0, removed = 0;
    Object.keys(want).forEach(function (id) {
      var w = want[id], ev = have[id];
      if (ev) {
        delete have[id];
        var same = ev.getTitle() === w.title && ev.isAllDayEvent() === w.allDay &&
          ev.getStartTime().getTime() === w.s.getTime() && ev.getEndTime().getTime() === w.e.getTime();
        if (same) return;
        if (ev.isAllDayEvent() !== w.allDay) { ev.deleteEvent(); ev = null; }
        else {
          ev.setTitle(w.title);
          if (w.allDay) ev.setAllDayDates(w.s, w.e); else ev.setTime(w.s, w.e);
          changed++;
          return;
        }
      }
      var n = w.allDay ? cal.createAllDayEvent(w.title, w.s, w.e) : cal.createEvent(w.title, w.s, w.e);
      n.setTag(TAG, id);
      if (w.url) n.setDescription(w.url);
      made++;
    });
    Object.keys(have).forEach(function (id) { have[id].deleteEvent(); removed++; });
    return { added: made, updated: changed, removed: removed, total: Object.keys(want).length };
  } finally {
    lock.releaseLock();
  }
}
