# CLAUDE.md — acro 리포 작업 규범

## 0. 이 리포의 정체

- 환자·직원이 **링크로 여는 정적 HTML 산출물(말단)** 저장소다. GitHub Pages로 서빙된다.
- **이 리포는 정본이 아니다.** 지식의 정본은 Google Drive `아크로_아카이브 / 10_아크로드_두뇌 / L2_확정지식` 의 md 문서다.
- `qa374.json` 같은 데이터 파일은 정본에서 컴파일된 **빌드 산출물**이다. 여기서 직접 고치면 드리프트가 생긴다.

## 1. ⚠️ 이 리포는 public이다

`visibility: public`. 커밋하는 모든 것이 즉시 전세계 공개다. 아래는 이 리포에 넣지 않는다.

- 계정 이메일, Drive 파일 ID, 스프레드시트 ID, GAS 배포 ID, 토큰·API 키
- 직원 개인정보·인사 관련 서술, 내부 전략·기획 문서
- 환자 식별정보(이름·차트번호·연락처)를 포함한 어떤 데이터도 금지

내부용 문서·식별자가 필요하면 Drive(두뇌) 또는 **별도 private 리포**에 둔다. 여기 문서에 ID를 적는 대신 "Drive에서 title로 검색"으로 참조한다.

## 2. 절대 규칙 — 위반하면 환자 대면 링크가 죽는다

1. **신규 GAS 배포를 만들지 않는다.** 기존 배포 수정 → 새 버전, `clasp deploy -i <배포ID>`.
   `-i` 없이 deploy 하면 새 `/exec` URL이 생겨 라인 리치메뉴·QR·카톡 저장링크·강남언니 템플릿이 전부 끊긴다.
2. **정본 없이 말단(HTML·json)에서 지식을 직접 수정하지 않는다.** `정본 → 빌드 → 말단` 순서만 허용.
3. 이관·컴파일 시 **요약·정리·개선 금지.** 무손실이 유일한 목표다(오탈자도 그대로 옮긴다).
4. 논문 서지정보를 기억으로 채우지 않는다. 확인 불가면 `___[확인 필요]`로 비운다.
5. 번역이 없는 언어 필드에 추측 번역을 채우지 않는다.
6. 크롬 익스텐션 브릿지로 대용량을 주입하지 않는다(165KB 주입 2회 동일 지점 붕괴 이력). 경로는 clasp.
7. **`main`에 직접 푸시하지 않는다.** 아래 §3 참조.

## 3. 두 개의 배포 경로 — 충돌 주의

이 리포는 2026-07-19부터 무인 배포 경로를 가진다.

```
클로드 → GAS doPost(action:deploy) → lwGitPutTo_ → GitHub Contents API → main
```

그 경로는 **`main`에 직접 쓴다.** 따라서 Claude Code 세션은 항상 **브랜치 + PR**로 작업한다.
두 경로가 같은 브랜치를 동시에 밀면 서로의 커밋을 덮어쓴다. 푸시 전 `git fetch origin main`으로 뒤처짐을 확인한다.

## 4. 세션 시작 절차

1. Drive에서 `아크로드_인수인계` 최신본을 **title 검색**으로 찾아 읽는다. 현재 상태·미결·다음 순서가 거기 있다.
2. 커넥터 상태를 확인한다. **커넥터·MCP 툴 레지스트리는 대화 시작 시점에 고정된다** — 중간에 켜도 그 대화에서는 잡히지 않는다. 새 대화를 열어야 한다.
3. 지금 하려는 일이 이 환경에서 되는 일인지 확인한다 → `docs/아크로드_세션운영.md`.

## 5. 파일 지도

| 파일 | 용도 |
|---|---|
| `index.html` | 안면 밸런스 프로그램 안내 (환자 대면) |
| `acro_guide.html`, `acro_treatment_guide.html`, `acro_diet_guide.html` | 환자 안내 대형 가이드 |
| `acro_guide_ems.html`, `acro_dosage.html`, `aftercare.html`, `untact_guide.html` | 시술·복약·애프터케어·비대면 안내 |
| `acro_first_treatment.html`, `Acro_first_treatment_park.html` | 초진 설문·차팅 관련 |
| `acro_foreign_line_guide.html`, `acro_interpreter.html` | 외국인 라인 응대·통역 |
| `acro_photo_*.html` | 사진 촬영·편집·인박스 |
| `acro_reply_console.html`, `qa374.json` | 응대 콘솔과 그 KB 빌드 산출물 |
| `acro-결산-html.html`, `acro-관제-대시보드.html` | 결산·관제 뷰 |
| `acro_staff_education.html`, `acro_links.html` | 직원 교육·링크 허브 |
| `faceline.html`, `onda_flow.html`, `asym/` | 개별 시술 랜딩 |
| `_deploy_proof_260719.txt` | 무인배포 자기증명 흔적. 지우지 말 것 |

## 6. 커밋·PR

- 커밋 메시지는 무엇이 왜 바뀌었는지 한국어로 한 줄. 모델명·내부 식별자는 넣지 않는다.
- HTML 산출물은 대용량이라 diff가 크게 잡힌다. 한 커밋에 한 파일 원칙.
