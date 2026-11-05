/**
 * 시간 계량기 · 캘린더 중계 서버 (relay) v2
 *
 * 하는 일: 앱이 보낸 링크를 대신 읽어서 캘린더(.ics)로 돌려준다.
 *   - 구글·iCloud·Outlook 캘린더 주소(.ics)는 그대로 읽어서 돌려준다.
 *   - v2: 에브리타임 시간표 공유 링크(everytime.kr/@…)는 시간표를 읽어 매주 반복 일정(.ics)으로 바꿔 준다.
 *   - 브라우저는 이 주소들을 직접 읽을 수 없어서(CORS) 이 다리가 필요하다.
 *   - 받은 주소와 내용은 저장하지 않는다. 로그에도 남기지 않는다.
 *   - 위 서비스 주소만 읽는다. 다른 사이트는 거절한다.
 *
 * 배포: 배포 → 새 배포 → 유형 '웹 앱'
 *   - 다음 사용자로 실행: 나
 *   - 액세스 권한이 있는 사용자: 모든 사용자
 * 고친 뒤에는 배포 → 배포 관리 → 연필 → 버전: 새 버전 (주소 유지)
 */

var RELAY_VERSION = 2;
var ALLOWED_HOSTS = [
  /^calendar\.google\.com$/,
  /^([a-z0-9-]+\.)*icloud\.com$/,
  /^outlook\.(live|office365|office)\.com$/
];
var MAX_BYTES = 5 * 1024 * 1024;
var MAX_REDIRECTS = 3;
var ETA_API = 'https://api.everytime.kr/find/timetable/table/friend';

function doPost(e) {
  var url = '';
  try { url = JSON.parse(e.postData.contents).url; } catch (err) {}
  return out_(relay_(url));
}

function doGet(e) {
  if (e && e.parameter && e.parameter.url) return out_(relay_(e.parameter.url));
  return out_({ ok: true, service: 'time-meter-relay', v: RELAY_VERSION, everytime: true });
}

function hostOf_(url) {
  var m = String(url).match(/^https:\/\/([^\/?#:@]+)(:\d+)?([\/?#]|$)/i);
  return m ? m[1].toLowerCase() : '';
}

function allowed_(host) {
  for (var i = 0; i < ALLOWED_HOSTS.length; i++) if (ALLOWED_HOSTS[i].test(host)) return true;
  return false;
}

/* everytime.kr/@abc123 → 'abc123' (아니면 '') */
function etaId_(url) {
  var m = String(url).match(/^https:\/\/(?:www\.|m\.)?everytime\.kr\/@([A-Za-z0-9]{1,40})\/?(?:[?#].*)?$/i);
  return m ? m[1] : '';
}

function relay_(url) {
  url = String(url || '').trim().replace(/^webcal:\/\//i, 'https://');
  if (/^https:\/\/(www\.|m\.)?everytime\.kr(\/|$)/i.test(url)) return everytime_(url);
  if (!hostOf_(url)) return { ok: false, error: 'bad_url' };
  for (var hop = 0; hop <= MAX_REDIRECTS; hop++) {
    var host = hostOf_(url);
    if (!host) return { ok: false, error: 'bad_url' };
    if (!allowed_(host)) return { ok: false, error: 'host_not_allowed' };
    var res;
    try {
      res = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true,
        followRedirects: false,
        headers: { 'User-Agent': 'time-meter-relay/' + RELAY_VERSION }
      });
    } catch (err) {
      return { ok: false, error: 'fetch_failed' };
    }
    var code = res.getResponseCode();
    if (code >= 300 && code < 400) {
      var h = res.getHeaders() || {};
      var loc = h.Location || h.location;
      if (!loc) return { ok: false, error: 'http_' + code };
      url = String(loc);
      continue;
    }
    if (code !== 200) return { ok: false, error: 'http_' + code };
    var txt = res.getContentText('UTF-8');
    if (txt.length > MAX_BYTES) return { ok: false, error: 'too_large' };
    if (txt.indexOf('BEGIN:VCALENDAR') < 0) return { ok: false, error: 'not_ics' };
    return { ok: true, ics: txt };
  }
  return { ok: false, error: 'too_many_redirects' };
}

/* ---------- 에브리타임 ---------- */

function everytime_(url) {
  var id = etaId_(url);
  if (!id) return { ok: false, error: 'eta_bad' };
  var res;
  try {
    res = UrlFetchApp.fetch(ETA_API, {
      method: 'post',
      muteHttpExceptions: true,
      payload: { identifier: id, friendInfo: 'true' },
      headers: {
        'Accept': '*/*',
        'Origin': 'https://everytime.kr',
        'Referer': 'https://everytime.kr/',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
      }
    });
  } catch (err) {
    return { ok: false, error: 'eta_failed' };
  }
  if (res.getResponseCode() !== 200) return { ok: false, error: 'eta_failed' };
  return etaToIcs_(res.getContentText('UTF-8'), new Date());
}

function xmlUnesc_(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(+d); })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function attrs_(s) {
  var o = {}, re = /([a-zA-Z_][\w-]*)\s*=\s*"([^"]*)"/g, m;
  while ((m = re.exec(s))) o[m[1]] = xmlUnesc_(m[2]);
  return o;
}

function pad_(n) { return (n < 10 ? '0' : '') + n; }

/* 날짜는 모두 UTC 자정 기준 숫자로 계산한다 (서버 시간대와 무관) */
function ymdNum_(y, m, d) { return Date.UTC(y, m - 1, d); }
function ymdStr_(t) { var d = new Date(t); return '' + d.getUTCFullYear() + pad_(d.getUTCMonth() + 1) + pad_(d.getUTCDate()); }

/* 학기 → [시작, 끝] (한국 대학 보통 일정 기준) */
function semesterRange_(year, sem, now) {
  var y = parseInt(year, 10), s = String(sem || '').toLowerCase();
  var kst = new Date(now.getTime() + 9 * 3600000);
  var ty = kst.getUTCFullYear(), today = ymdNum_(ty, kst.getUTCMonth() + 1, kst.getUTCDate());
  if (y > 2000) {
    if (s === '1') return [ymdNum_(y, 3, 2), ymdNum_(y, 6, 21)];
    if (s === '2') return [ymdNum_(y, 9, 1), ymdNum_(y, 12, 21)];
    if (/^(s|3|여름|summer)/.test(s)) return [ymdNum_(y, 6, 22), ymdNum_(y, 8, 31)];
    if (/^(w|4|겨울|winter)/.test(s)) return [ymdNum_(y, 12, 22), ymdNum_(y + 1, 2, 28)];
  }
  return [today, today + 16 * 7 * 86400000];
}

function icsEsc_(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function etaToIcs_(xml, now) {
  xml = String(xml || '');
  var tm = xml.match(/<table\b([^>]*)>/);
  if (!tm) return { ok: false, error: 'eta_private' };
  var table = attrs_(tm[1]);
  var range = semesterRange_(table.year, table.semester, now);
  var start = range[0], end = range[1];
  var stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  var until = ymdStr_(end) + 'T145959Z'; // 끝나는 날 23:59:59 (한국 시간)
  var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//time-meter//everytime//KO', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:' + icsEsc_('에타 시간표')];
  var count = 0, sre = /<subject\b([^>]*)>([\s\S]*?)<\/subject>/g, sm;
  while ((sm = sre.exec(xml))) {
    var sa = attrs_(sm[1]), body = sm[2];
    var nm = body.match(/<name\b([^>]*)\/?>/), pr = body.match(/<professor\b([^>]*)\/?>/);
    var name = nm ? attrs_(nm[1]).value : '';
    var prof = pr ? attrs_(pr[1]).value : '';
    if (!name) continue;
    var dre = /<data\b([^>]*)\/?>/g, dm, k = 0;
    while ((dm = dre.exec(body))) {
      var d = attrs_(dm[1]);
      var day = parseInt(d.day, 10), st = parseInt(d.starttime, 10), et = parseInt(d.endtime, 10);
      if (!(day >= 0 && day <= 6) || !(st >= 0) || !(et > st) || et > 288) continue;
      // 에타: 0=월 … 6=일 / 시간은 5분 단위
      var sd = (new Date(start).getUTCDay() + 6) % 7; // 0=월
      var first = start + ((day - sd + 7) % 7) * 86400000;
      if (first > end) continue;
      var ds = ymdStr_(first);
      var sh = Math.floor(st * 5 / 60), smn = (st * 5) % 60, eh = Math.floor(et * 5 / 60), emn = (et * 5) % 60;
      lines.push('BEGIN:VEVENT',
        'UID:eta-' + (sa.id || count) + '-' + (k++) + '@time-meter',
        'DTSTAMP:' + stamp,
        'SUMMARY:' + icsEsc_(name),
        'DTSTART;TZID=Asia/Seoul:' + ds + 'T' + pad_(sh) + pad_(smn) + '00',
        'DTEND;TZID=Asia/Seoul:' + ds + 'T' + pad_(eh) + pad_(emn) + '00',
        'RRULE:FREQ=WEEKLY;UNTIL=' + until);
      if (d.place) lines.push('LOCATION:' + icsEsc_(d.place));
      if (prof) lines.push('DESCRIPTION:' + icsEsc_(prof));
      lines.push('END:VEVENT');
      count++;
    }
  }
  lines.push('END:VCALENDAR');
  if (!count) return { ok: false, error: 'eta_empty' };
  var e = new Date(end);
  return { ok: true, ics: lines.join('\r\n'), kind: 'everytime', count: count,
           until: e.getUTCFullYear() + '-' + pad_(e.getUTCMonth() + 1) + '-' + pad_(e.getUTCDate()) };
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

if (typeof module !== 'undefined') module.exports = { relay_: relay_, etaId_: etaId_, etaToIcs_: etaToIcs_, semesterRange_: semesterRange_ };
