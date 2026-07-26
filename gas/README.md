# 아크로드 빌드 GAS

정본 하나에서 말단을 찍어내는 코드다. 착수순서 3번.

```
Drive  L2_확정지식/L2_응대KB_v*.md   ← 사람이 고치는 유일한 곳
                  │
            build_kb.gs
                  ├──→ 답변KB 시트          (라인브릿지가 실시간으로 읽는 곳)
                  └──→ qa374.json (GitHub)  (응대콘솔 2차 폴백)
```

방향은 한쪽뿐이다. **말단을 고쳐도 다음 빌드에서 정본 값으로 덮인다.**

## 준비

### 1. 스크립트 속성

`build_kb.gs`는 **public 리포**에 있다. ID·토큰·웹훅은 코드에 없고 스크립트 속성에서 읽는다.
Apps Script 편집기 → 프로젝트 설정 → 스크립트 속성에 두 개를 넣는다.

| 키 | 값 |
|---|---|
| `KB_SPREADSHEET_ID` | 답변KB 탭이 있는 스프레드시트 ID |
| `SLACK_WEBHOOK_URL` | 알림 받을 채널의 Incoming Webhook (#회의_프로그램) |

Drive 폴더는 ID가 아니라 **이름(`L2_확정지식`)으로 찾는다.** 폴더 ID를 코드에 적지 않기 위한 것이다.

### 2. `lwGitPutTo_`가 같은 프로젝트에 있어야 한다

GitHub 푸시는 기존 배포 GAS의 `lwGitPutTo_`를 재사용한다. 없으면 `writeJson_`에서 중단된다.
어느 프로젝트에 있는지 찾는 법은 아래 "찾기" 참고.

## 실행

```
buildDryRun()   ← 반드시 먼저. 아무것도 쓰지 않고 리포트만 낸다.
buildAll()      ← 실제 반영.
```

`buildDryRun()`이 슬랙에 뭘 몇 건 바꿀지 보고한다. 그 숫자가 납득되면 `buildAll()`.

## 안전장치

빌드가 정본을 잘못 읽어서 시트를 비워버리는 게 최악이다. 그래서 다음 경우 **쓰기 전에 중단**한다.

| 상황 | 동작 |
|---|---|
| 정본 폴더를 못 읽음 | 중단 + 슬랙 경보 (조용히 실패하지 않는다) |
| `L2_확정지식` 이름의 폴더가 둘 이상 | 중단 — 어느 게 정본인지 알 수 없다 |
| 파싱 결과가 `MIN_ITEMS`(380) 미달 | 중단 — 정본이 잘려 읽힌 것으로 본다 |
| 시트 행이 `MAX_SHRINK`(5) 넘게 줄어듦 | 중단 |
| `원본ID`가 빈 항목이 있음 | 중단 + 어느 KB-ID인지 보고 |
| `원본ID` 중복 | 중단 |
| 정본에 없는 시트 행 | **지우지 않는다.** 맨 아래로 밀고 슬랙에 목록 보고 |

마지막 항목이 중요하다. 클로드→슬랙 경로가 시트에 직접 쓰기 때문에 정본에 없는 행이 생긴다.
빌드가 그걸 지우면 그 지식이 사라진다. 지우지 않고 **보이게** 만들어서 정본으로 올리게 한다.

## 슬랙 숏코드 정규화

클로드→슬랙 경로로 KB가 갱신되면 `:blush:` 같은 슬랙 표기가 문자 그대로 시트에 굳는다.
그대로 발송되면 환자 화면에 `:blush:`가 찍힌다(260726에 13곳 발견).
빌드가 매번 `CFG.EMOJI`로 치환하고, **매핑에 없는 새 숏코드가 보이면 슬랙으로 알린다.**

## 검증

```bash
# 파서가 정본을 정확히 읽는지
node gas/test/test_parse.js gas/build_kb.gs <정본.md>

# 역빌드 검증 — 빌드 결과 vs 현행 시트
node gas/test/reverse_verify.js gas/build_kb.gs <정본.md> <시트스냅샷.json>
```

`reverse_verify.js`의 통과 조건은 "차이 0"이 아니라 **"설명 안 되는 차이 0"** 이다.
의도한 정정(주차·D캡슐·죽은 링크 등)은 차이가 나야 정상이고, 그 목록은 스크립트 안의
`EXPECTED_KB`에 KB-ID로 적어둔다. 목록에 없는 차이가 나오면 미통과다.

260726 기준: 정본 423 · 시트 411 · 정본에만 12(F001~F012) · 값 차이 25건 전부 설명됨 · 시트에만 0.

## 배포

```
clasp deploy -i <배포ID>
```

**`-i` 없이 `clasp deploy` 하지 않는다.** 새 `/exec` URL이 생겨서 라인 리치메뉴·QR·카톡 저장링크·
강남언니 템플릿이 전부 끊긴다.

## 찾기

```powershell
# lwGitPutTo_ 가 어느 프로젝트에 있나 (clone 해둔 폴더에서)
Get-ChildItem -Recurse -Include *.js,*.gs -File | Select-String 'lwGitPutTo_' | Select-Object Path -Unique

# 배포 목록 (clone 없이 scriptId만으로)
clasp list-deployments <scriptId>
```

`Get-ChildItem -Recurse`를 OneDrive 동기 폴더에서 돌리면 클라우드 전용 파일이 전부
내려받아진다. **clone 폴더 안에서만** 돌릴 것.
