/**
 * 발송 전 관문 — 중복 발송 차단 + 언어 게이트 (reply_guard.gs)
 *
 * 원장 실사용 지적 260820:
 *   ① 같은 문의에 중복으로 대답했다
 *   ② 일본 환자에게 강남언니 **한국판** 링크와 한국어 블로그 내용을 보냈다
 *
 * ②의 원인은 지식 부족이 아니다 — 정본에 일본판·대만판 링크가 이미 있다(응대KB).
 * 상시 주입되는 자산인덱스 v1.0에 **언어 축이 없었고** 강남언니가 한국판 한 줄뿐이라,
 * "인덱스에 있는 링크만 쓴다"는 규칙을 지킬수록 한국판이 나갔다. 인덱스는 v1.1에서
 * 언어별로 갈랐고, 이 파일은 그래도 새는 경우를 막는 **마지막 관문**이다.
 *
 * 배선(허브): 발송 직전 argCheck_(text, chKey, msgId) → ok:false면 발송하지 말고
 *   사유를 원내 채널에 남긴다(환자에게는 오류를 노출하지 않는다 — 헌법).
 */

var ARG_CFG = {
  DUP_TTL_SEC: 21600,   // 같은 메시지 재도착 판정 창 (6시간)
  KO_CHANNELS: ['ko', 'kakao']   // 이 채널들에는 언어 게이트를 적용하지 않는다
};

/** 한국어 전용 자산 — 외국인 채널에 나가면 안 된다.
 *  판정은 부분일치. 일본판(/jp/)·대만판(/tw/)은 문자열이 달라 자연히 걸리지 않는다. */
var ARG_KO_ONLY = [
  'blog.naver.com',                  // 네이버 블로그 — 한국어 본문
  'pf.kakao.com',                    // 카카오톡 채널 — 한국 전용
  'gangnamunni.com/hospitals',       // 강남언니 한국판 (일본판은 /jp/, 대만판은 /tw/)
  'acrohani.com/ko/',                // 한국어 페이지
  'youtube.com', 'youtu.be',         // 영상 — 한국어 내레이션
  'github.io/acro/acro_diet_guide',  // 복용법·식단 가이드(한국어)
  'github.io/acro/asym/aftercare',
  'github.io/acro/index.html'
];

/** 한국 전용 자산의 언어별 대체 링크 — 있으면 이것으로 바꿔 보낸다 */
var ARG_ALT = {
  'gangnamunni.com/hospitals': {
    jp: 'https://www.gangnamunni.com/jp/hospitals/2067',
    tw: 'https://www.gangnamunni.com/tw/hospitals/2067'
  }
};

/** 텍스트에서 URL만 뽑는다 */
function argUrls_(text) {
  var m = String(text || '').match(/https?:\/\/[^\s<>()\[\]"']+/g);
  return m || [];
}

/**
 * 중복 발송 차단. 같은 메시지 id를 이미 처리했으면 true(=중복).
 * 처음 보는 id면 기록하고 false. **발송 전에 부르고, true면 발송하지 않는다.**
 * 저장은 CacheService — 판정 창이 짧아 축출돼도 드물게 중복 1건일 뿐,
 * 홀드 플래그와 달리 안전 문제가 아니다.
 */
function argDupe_(msgId) {
  if (!msgId) return false;                 // id를 못 받으면 막지 않는다(오차단 방지)
  var key = 'ARG_SEEN_' + String(msgId);
  var c = CacheService.getScriptCache();
  try {
    if (c.get(key)) return true;
    c.put(key, '1', ARG_CFG.DUP_TTL_SEC);
    return false;
  } catch (e) { return false; }
}

/**
 * 언어 게이트. 외국인 채널(jp/tw 등)에 한국어 전용 자산이 실렸는지 본다.
 * 반환: { ok:true } | { ok:false, hits:[...], fixed:'대체 링크로 바꾼 본문'|null, reason }
 * 대체 링크가 있으면 fixed를 주고, 없으면 **링크를 지우고 보내는 것이 아니라 사람에게 넘긴다**
 * — 문장이 링크를 전제로 쓰였을 수 있어 기계적으로 지우면 말이 깨진다.
 */
function argLang_(text, chKey) {
  var ch = String(chKey || '').toLowerCase();
  if (!ch || ARG_CFG.KO_CHANNELS.indexOf(ch) >= 0) return { ok: true };
  var urls = argUrls_(text), hits = [], out = String(text || ''), allFixed = true;
  for (var i = 0; i < urls.length; i++) {
    for (var k = 0; k < ARG_KO_ONLY.length; k++) {
      var pat = ARG_KO_ONLY[k];
      if (urls[i].indexOf(pat) < 0) continue;
      hits.push(urls[i]);
      var alt = ARG_ALT[pat] && ARG_ALT[pat][ch];
      if (alt) out = out.split(urls[i]).join(alt);
      else allFixed = false;
      break;
    }
  }
  if (!hits.length) return { ok: true };
  return { ok: false, hits: hits, fixed: allFixed ? out : null,
           reason: '외국인 채널(' + ch + ')에 한국어 전용 자산 ' + hits.length + '건' };
}

/**
 * 발송 직전 통합 관문 (허브가 부르는 진입점).
 * 반환: { send:true, text } | { send:false, reason, hits? }
 *   send:false면 환자에게 보내지 않는다. 사유는 원내 채널에만 남긴다.
 */
function argCheck_(text, chKey, msgId) {
  if (argDupe_(msgId)) return { send: false, reason: '중복 메시지 — 이미 응대함' };
  var L = argLang_(text, chKey);
  if (L.ok) return { send: true, text: String(text || '') };
  if (L.fixed) return { send: true, text: L.fixed, swapped: L.hits };   // 언어판으로 교체 후 발송
  return { send: false, reason: L.reason, hits: L.hits };               // 대체 없음 → 사람 인계
}
