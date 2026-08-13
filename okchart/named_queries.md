# named_query 정의 — 워커 등록용 (260813)

> 허브 인계 260813 1순위. 워커(`C:\acro-gas\_okchart-worker`)에 등록할 named_query 3종의
> **SQL 정본**이다. 등록·실측은 허브가, 정의는 여기가 — 정의가 리포에 있어야 드리프트가 안 난다.
>
> 공통 제약(전부 준수): **SELECT 전용** · **파라미터 바인딩만**(문자열 연결 금지) ·
> 클라우드 큐(named_query) 호출 가능 · SQL Server 2008 R2 문법(TOP 사용, OFFSET 없음).
>
> ⚠ **TTTDrug 행중복**: 방문 1건이 여러 행으로 쪼개지고 값이 복사된다(탐침 260812, 2.10배).
> TTTDrug를 건드리는 쿼리는 **DISTINCT 필수**.

## 1. `codi_list` — 모든코디 상담 목록

용도: 오늘 상담했거나 오늘 다시 걸어야 할 건. 정기 스케줄(코디 리스트)이 소비.

**파라미터**: `d` (YYYY-MM-DD, 오늘)

```sql
SELECT Name, SN, PhoneNumber, ConsultType, ConsultContentType, ConsultInflex,
       ConsultContent, ConsultResult, NextCallDate, Counselor, Completion
FROM CTIConsultation
WHERE CONVERT(char(10), ConsultDate, 120) = ?
   OR CONVERT(char(10), NextCallDate, 120) = ?
ORDER BY NextCallDate, Name
```

- 파라미터가 **2번** 바인딩된다(같은 값 두 번 전달). 워커 등록 시 params 개수 주의.
- 날짜 컬럼이 이미 문자열이면 `CONVERT` 없이 `= ?`로 — 등록 전 1행 조회로 타입 확인할 것.
- 개인정보(실명·전화)를 포함한다 → **원내 채널·내부 도구 전용.** feed·리포·환자 대면 금지.

## 2. `resv_list` — 예약 목록

용도: 아침 예약 리스트, 게이트웨이 예약 응대(빈 슬롯 계산)가 소비. 검증된 쿼리 기준.

**파라미터**: `d` (YYYY-MM-DD)

```sql
SELECT Res_Time_0, Res_ChartNo, Res_Name, Res_DoctorName, Res_Item
FROM Reservation_New
WHERE Res_Canceled = 0 AND Res_Date = ?
ORDER BY Res_Time_0
```

- `Res_Date`는 텍스트('YYYY-MM-DD'), `Res_Canceled`는 False 573/True 48·NULL 0건(탐침 P8)
  → `= 0` 필터 그대로 안전.
- 빈 슬롯 계산에는 `Res_Time_0`만 쓰면 되지만, 아침 리스트가 나머지 컬럼을 쓰므로 함께 반환.

## 3. `rx_addr` — 차트번호 → 배송지·연락처

용도: 택배 처방전 생성. 차트번호 목록을 받아 주소·연락처를 붙인다.

**파라미터**: 차트번호 배열 `sns` — **워커가 원소마다 개별 바인딩(`IN (?, ?, …)`)해야 한다.**
문자열로 이어 붙이면 인젝션 경로가 된다. 배열 지원이 어려우면 차트 1건씩 N회 호출로 대체.

```sql
SELECT DISTINCT c.sn, c.name, c.address,
       t.[전화번호]            AS tel_plain,      -- ___[확인 필요] 실제 컬럼명
       r.Res_MobilePhone       AS tel_resv
FROM Customer c
LEFT JOIN TTTDrug t ON t.Customer_PK = c.Customer_PK
LEFT JOIN Reservation_New r ON r.Res_ChartNo = c.sn
WHERE c.sn IN (?)
```

**미확정 2건 — 등재 전 탐침으로 확정할 것(추측으로 채우지 않는다):**

- `TTTDrug`의 평문 전화 컬럼명, 그리고 **배송지가 `Customer.address`인지 TTTDrug의 별도
  배송주소 컬럼인지.** 택배는 주소가 다를 수 있어 이게 틀리면 오배송이 된다.
- 확인용 탐침(P12): 컬럼 목록을 먼저 본다.

```sql
SELECT TOP 1 * FROM TTTDrug WHERE [결제금액] > 0 ORDER BY TxDate DESC
```

- 전화 3경로 우선순위(허브 지침): **TTTDrug 평문 → Res_MobilePhone → Customer 암호문(판독 불가,
  사실상 제외).** 소비 측에서 `COALESCE` 하거나 SQL에서 `COALESCE(t.[전화번호], r.Res_MobilePhone)`.
- `LEFT JOIN`이 TTTDrug·Reservation_New 다행과 곱해지므로 `DISTINCT` 필수 —
  그래도 전화번호가 서로 다르면 환자당 여러 행이 나온다. **소비 측에서 sn 기준 1행으로 접을 것**
  (최신 우선). 완전 단일화가 필요하면 등록 시 서브쿼리로 최신 1건만 뽑는 형태로 확정한다.

## 등록 후 검증 (허브)

1. 각 쿼리를 **클라우드 큐 경유로 1회씩** 왕복 실측 → 결과 행 수·컬럼명 확인.
2. `resv_list`는 오늘 날짜로 돌려 아침 리스트 건수와 일치하는지 대조.
3. `rx_addr`는 **주소가 실제 배송지와 맞는지 2~3건 눈으로 확인** — 여기서 틀리면 약이 잘못 간다.
4. 실측 결과(컬럼명 확정분)를 이 파일에 반영해 커밋 — `___[확인 필요]` 제거.

## 안전 규칙

- SELECT 전용. INSERT/UPDATE는 어떤 named_query로도 만들지 않는다(차트 쓰기 절대 금지).
- 결과에 실명·연락처·주소가 포함된다 → 원내 전용. **feed·public 리포·환자 대면 채널 금지.**
- 무거운 조회(전 테이블 스캔)는 진료 외 시간.
