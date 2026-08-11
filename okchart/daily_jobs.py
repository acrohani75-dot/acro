# -*- coding: utf-8 -*-
"""OK차트 일일 잡 — 아침 예약 리스트(Slack) · 저녁 실측 feed(GitHub)

원장 PC 워커 폴더(jobs\\)에 두고 작업 스케줄러로 하루 2회 실행한다.
  python daily_jobs.py morning [--dry-run]   # 08:30 오늘·내일 예약 → Slack 게시
  python daily_jobs.py evening [--dry-run]   # 21:40 오늘 집계 → canon 리포 feed 커밋

설계 정본: acro_canon `아크로드_OK차트_실측연동_설계_v1_0_260811.md`
- DB는 SELECT만 (아래 상수 쿼리가 전부 — 동적 SQL 조립 없음)
- 아침 게시는 원내 채널 한정이라 실명·차트번호 허용 (원장 확정 260811)
- 저녁 feed는 리포 밖 GAS까지 흘러가므로 환자 식별정보 절대 금지 (집계만)

설정 2파일 (둘 다 워커 폴더, 어떤 git에도 커밋 금지):
- config.json       : 워커와 공용 (server/port/uid/pwd/database/odbc_driver)
- daily_config.json : {"slack_token":"xoxb-..", "morning_channel":"C..",
                       "feed_repo":"소유자/acro_canon", "feed_token":"github_pat_..",
                       "feed_path":"feed/okchart_daily.json"(생략 가능)}
"""
import base64
import datetime
import json
import os
import sys
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # jobs\ 상위 = 워커 폴더

# ── 쿼리 상수 (SQL Server 2008 R2 — SELECT만) ──────────────────────────────
Q_RESV = ("SELECT Res_Time_0, Res_ChartNo, Res_Name, Res_DoctorName, Res_Item "
          "FROM Reservation_New WHERE Res_Canceled=0 AND Res_Date=? ORDER BY Res_Time_0")
Q_VISITS = "SELECT COUNT(DISTINCT Customer_PK) FROM Detail WHERE TxDate>=? AND TxDate<?"
Q_PAY = ("SELECT [결제방법], COUNT(*), SUM([결제금액]) FROM TTTDrug "
         "WHERE TxDate>=? AND TxDate<? GROUP BY [결제방법]")
Q_MISU = "SELECT SUM([미수금]) FROM TTTDrug WHERE TxDate>=? AND TxDate<?"
Q_RESV_CNT = ("SELECT COUNT(*), MIN(Res_Time_0) FROM Reservation_New "
              "WHERE Res_Canceled=0 AND Res_Date=?")


def load_cfg():
    cfg = {}
    for name in ("config.json", "daily_config.json"):
        p = os.path.join(BASE, name)
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                cfg.update(json.load(f))
    return cfg


def connect(cfg):
    import pyodbc  # 워커 PC에만 있음 — 테스트에서는 가짜 conn 주입
    cs = ("DRIVER={%s};SERVER=%s,%s;UID=%s;PWD=%s;" % (
        cfg.get("odbc_driver", "SQL Server"), cfg["server"], cfg.get("port", 1433),
        cfg["uid"], cfg["pwd"]))
    return pyodbc.connect(cs, readonly=True)


def q(conn, database, sql, params):
    cur = conn.cursor()
    cur.execute("USE [%s]" % database)  # 고정 문자열 상수만 — 사용자 입력 없음
    cur.execute(sql, params)
    return cur.fetchall()


# ── 순수 조립 함수 (테스트 대상) ────────────────────────────────────────────
def morning_report(rows_today, rows_tomorrow, today, tomorrow):
    """오늘·내일 예약을 게시문으로. 둘 다 0건이면 None(게시 생략)."""
    if not rows_today and not rows_tomorrow:
        return None
    lines = ["📋 예약 리스트 — %s (오늘 %d건 · 내일 %d건)"
             % (today, len(rows_today), len(rows_tomorrow))]
    def block(title, rows):
        if not rows:
            return
        lines.append(title)
        for r in rows:
            t, chart, name, doc, item = (str(x or "").strip() for x in r[:5])
            lines.append("· %s %s(%s) %s — %s" % (t, name, chart, item, doc))
    block("[오늘]", rows_today)
    block("[내일 %s — 내원전 확인콜 대상]" % tomorrow, rows_tomorrow)
    return "\n".join(lines)


def build_feed(visits, pay_rows, misu, resv_cnt, resv_first, today, now_hm):
    """feed 계약 v1 — 집계만, 환자 식별정보 없음."""
    return {
        "v": 1,
        "date": today,
        "generated_at": "%s %s" % (today, now_hm),
        "visits": int(visits or 0),
        "pay_by_method": [
            {"method": str(m or "미지정").strip(), "cnt": int(c or 0), "sum": int(s or 0)}
            for m, c, s in pay_rows
        ],
        "misu_today": int(misu or 0),
        "resv_tomorrow": int(resv_cnt or 0),
        "resv_tomorrow_first": str(resv_first or "")[:5],
    }


# ── 발신 (Slack · GitHub) ──────────────────────────────────────────────────
def http_json(url, method, headers, body=None):
    req = urllib.request.Request(url, method=method, headers=headers,
                                 data=json.dumps(body).encode("utf-8") if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, json.loads(res.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8") or "{}")


def slack_post(cfg, text):
    st, body = http_json("https://slack.com/api/chat.postMessage", "POST",
                         {"Authorization": "Bearer " + cfg["slack_token"],
                          "Content-Type": "application/json; charset=utf-8"},
                         {"channel": cfg["morning_channel"], "text": text})
    if st != 200 or not body.get("ok"):
        raise RuntimeError("Slack 게시 실패: %s %s" % (st, body.get("error")))


def github_put(cfg, content_str, message):
    path = cfg.get("feed_path", "feed/okchart_daily.json")
    url = "https://api.github.com/repos/%s/contents/%s" % (cfg["feed_repo"], path)
    headers = {"Authorization": "Bearer " + cfg["feed_token"],
               "Accept": "application/vnd.github+json"}
    st, body = http_json(url, "GET", headers)
    payload = {"message": message,
               "content": base64.b64encode(content_str.encode("utf-8")).decode("ascii")}
    if st == 200 and body.get("sha"):
        payload["sha"] = body["sha"]
    st, body = http_json(url, "PUT", headers, payload)
    if st not in (200, 201):
        raise RuntimeError("feed 커밋 실패: HTTP %s %s" % (st, str(body)[:200]))


# ── 실행 ───────────────────────────────────────────────────────────────────
def run_morning(conn, cfg, dry):
    today = datetime.date.today()
    d0, d1 = today.isoformat(), (today + datetime.timedelta(days=1)).isoformat()
    text = morning_report(q(conn, "MasterDB", Q_RESV, (d0,)),
                          q(conn, "MasterDB", Q_RESV, (d1,)), d0, d1)
    if text is None:
        print("예약 0건 — 게시 생략")
        return
    if dry:
        print(text)
    else:
        slack_post(cfg, text)
        print("게시 완료 (%d자)" % len(text))


def run_evening(conn, cfg, dry):
    today = datetime.date.today()
    d0, d1 = today.isoformat(), (today + datetime.timedelta(days=1)).isoformat()
    visits = q(conn, "MasterDB", Q_VISITS, (d0, d1))[0][0]
    pay = q(conn, "TreatCurrent", Q_PAY, (d0, d1))
    misu = q(conn, "TreatCurrent", Q_MISU, (d0, d1))[0][0]
    cnt, first = q(conn, "MasterDB", Q_RESV_CNT, (d1,))[0]
    feed = build_feed(visits, pay, misu, cnt, first, d0,
                      datetime.datetime.now().strftime("%H:%M"))
    body = json.dumps(feed, ensure_ascii=False, indent=1)
    if dry:
        print(body)
    else:
        github_put(cfg, body, "okchart feed %s" % d0)
        print("feed 커밋 완료: %s" % d0)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    dry = "--dry-run" in sys.argv
    if mode not in ("morning", "evening"):
        print(__doc__)
        return 2
    cfg = load_cfg()
    try:
        conn = connect(cfg)
        (run_morning if mode == "morning" else run_evening)(conn, cfg, dry)
        return 0
    except Exception as e:  # 잡 실패는 조용히 죽지 않는다 — 슬랙 경보 시도 후 종료코드로 알림
        print("실패:", e)
        if not dry and cfg.get("slack_token") and cfg.get("morning_channel"):
            try:
                slack_post(cfg, "🔺 OK차트 %s 잡 실패 — %s" % (mode, str(e)[:200]))
            except Exception:
                pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
