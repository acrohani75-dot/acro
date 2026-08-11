# -*- coding: utf-8 -*-
"""daily_jobs.py 순수 로직 검증 — DB·네트워크는 가짜 객체
실행: python3 okchart/test_daily_jobs.py
"""
import io
import json
import sys
import contextlib

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import daily_jobs as dj

PASS = []


def ok(label, cond):
    PASS.append(bool(cond))
    print(("  ✓ " if cond else "  ✗ ") + label)


class FakeConn:
    """execute된 SQL의 앞부분으로 결과를 돌려주는 가짜 커서/커넥션."""
    def __init__(self, table):
        self.table = table
        self.log = []

    def cursor(self):
        return self

    def execute(self, sql, params=()):
        self.log.append((sql, tuple(params)))
        self._rows = []
        for key, rows in self.table.items():
            if sql.startswith(key) or key in sql:
                self._rows = rows(tuple(params)) if callable(rows) else rows
        return self

    def fetchall(self):
        return self._rows


print("1) morning_report — 형식·0건 생략")
rows_t = [("10:00", "001234", "홍길동", "임원장", "온다")]
rows_m = [("09:30", "005678", "김영희", "박원장", "다이어트재진"),
          ("11:00", "000009", "조민지", "임원장", "체크")]
txt = dj.morning_report(rows_t, rows_m, "2026-08-11", "2026-08-12")
ok("헤더에 건수", "오늘 1건 · 내일 2건" in txt)
ok("오늘 블록 형식", "· 10:00 홍길동(001234) 온다 — 임원장" in txt)
ok("내일 블록에 확인콜 문구", "내원전 확인콜 대상" in txt)
ok("시간순 그대로 유지", txt.index("09:30") < txt.index("11:00"))
ok("둘 다 0건이면 None", dj.morning_report([], [], "d", "d") is None)
ok("None 값 안전 처리", "· " in dj.morning_report([(None, "1", None, "의", "항목")], [], "d", "d"))

print("2) build_feed — 계약 v1 · 무PII")
feed = dj.build_feed(23, [("카드", 12, 1234000), (None, 1, None)], 50000, 17, "10:00:00", "2026-08-11", "21:40")
ok("필수 키 전부", all(k in feed for k in ("v", "date", "visits", "pay_by_method", "misu_today", "resv_tomorrow", "resv_tomorrow_first")))
ok("결제방법 None → 미지정·합계 0", feed["pay_by_method"][1] == {"method": "미지정", "cnt": 1, "sum": 0})
ok("첫 예약시각 HH:MM 절단", feed["resv_tomorrow_first"] == "10:00")
ok("이름·차트 키 없음(무PII)", not any(k in json.dumps(feed, ensure_ascii=False) for k in ("name", "chart", "홍길동")))

print("3) run_morning — 쿼리 흐름·dry-run 출력·0건 생략")
conn = FakeConn({"SELECT Res_Time_0": lambda p: rows_t if p[0] == dj.datetime.date.today().isoformat() else rows_m})
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    dj.run_morning(conn, {}, dry=True)
ok("dry-run이 게시문 출력", "예약 리스트" in buf.getvalue())
ok("MasterDB USE 선행", any("USE [MasterDB]" in s for s, _ in conn.log))
conn2 = FakeConn({"SELECT Res_Time_0": []})
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    dj.run_morning(conn2, {}, dry=True)
ok("0건이면 게시 생략 메시지", "게시 생략" in buf.getvalue())

print("4) run_evening — 집계 조인·feed JSON 출력")
conn3 = FakeConn({
    "SELECT COUNT(DISTINCT Customer_PK)": [(23,)],
    "GROUP BY [결제방법]": [("카드", 12, 1234000), ("현금", 3, 200000)],
    "SELECT SUM([미수금])": [(50000,)],
    "SELECT COUNT(*), MIN(Res_Time_0)": [(17, "10:00:00")],
})
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    dj.run_evening(conn3, {}, dry=True)
out = json.loads(buf.getvalue())
ok("visits·misu·resv 반영", (out["visits"], out["misu_today"], out["resv_tomorrow"]) == (23, 50000, 17))
ok("결제방법 2줄", len(out["pay_by_method"]) == 2)
ok("TreatCurrent USE 포함", any("USE [TreatCurrent]" in s for s, _ in conn3.log))
ok("쿼리는 SELECT/USE만", all(s.split()[0] in ("SELECT", "USE") for s, _ in conn3.log))

n = sum(PASS)
print("\n" + ("✅ 전부 통과 — %d케이스" % n if all(PASS) else "❌ %d/%d" % (n, len(PASS))))
sys.exit(0 if all(PASS) else 1)
