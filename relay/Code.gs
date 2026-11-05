/**
 * 시간 계량기 · 캘린더 중계 서버 (relay) v1
 *
 * 하는 일: 앱이 보낸 캘린더 주소(.ics)를 대신 읽어서 돌려준다.
 *   - 브라우저는 구글 캘린더 주소를 직접 읽을 수 없어서(CORS) 이 다리가 필요하다.
 *   - 받은 주소와 내용은 저장하지 않는다. 로그에도 남기지 않는다.
 *   - 캘린더 서비스 주소(구글·iCloud·Outlook)만 읽는다. 다른 사이트는 거절한다.
 *
 * 배포: 배포 → 새 배포 → 유형 '웹 앱'
 *   - 다음 사용자로 실행: 나
 *   - 액세스 권한이 있는 사용자: 모든 사용자
 */

var ALLOWED_HOSTS = [
  /^calendar\.google\.com$/,
  /^([a-z0-9-]+\.)*icloud\.com$/,
  /^outlook\.(live|office365|office)\.com$/
];
var MAX_BYTES = 5 * 1024 * 1024;
var MAX_REDIRECTS = 3;

function doPost(e) {
  var url = '';
  try { url = JSON.parse(e.postData.contents).url; } catch (err) {}
  return out_(relay_(url));
}

function doGet(e) {
  if (e && e.parameter && e.parameter.url) return out_(relay_(e.parameter.url));
  return out_({ ok: true, service: 'time-meter-relay', v: 1 });
}

function hostOf_(url) {
  var m = String(url).match(/^https:\/\/([^\/?#:@]+)(:\d+)?([\/?#]|$)/i);
  return m ? m[1].toLowerCase() : '';
}

function allowed_(host) {
  for (var i = 0; i < ALLOWED_HOSTS.length; i++) if (ALLOWED_HOSTS[i].test(host)) return true;
  return false;
}

function relay_(url) {
  url = String(url || '').trim().replace(/^webcal:\/\//i, 'https://');
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
        headers: { 'User-Agent': 'time-meter-relay/1' }
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

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
