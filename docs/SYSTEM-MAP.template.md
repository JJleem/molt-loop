# System Map — Template

> **이 파일은 템플릿이다. 그대로 두고, 복사해서 `docs/SYSTEM-MAP.md` 를 만든다.**
>
> 채우는 방법은 `prompts/PROJECT-BOOTSTRAP.md` 의 SYSTEM-MAP 절을 따른다.
> 저장소를 읽지 않고 추측으로 채우지 않는다. **없는 architecture를 지어내지 않는다.**
>
> 아래 인용문(`>`)은 전부 작성 지침이며, 실제 `SYSTEM-MAP.md` 에는 남기지 않는다.

이 문서는 프로젝트의 **최상위 지도**다. 세부 구현 문서가 아니라, 전체를 탐색하기 위한 진입점이다.

처음 보는 사람이나 새 세션이 짧은 시간 안에 다음을 파악할 수 있게 하는 것이 목적이다.

```text
이 시스템은 무엇인가
→ 지금 실제로 구현된 것은 무엇인가
→ 작업/데이터는 어떻게 흘러가는가
→ 주요 구성요소는 무엇인가
→ 외부 의존성 경계는 어디인가
→ 어느 Phase가 DONE / PLANNED / DEFERRED 인가
→ 무엇이 자동으로 검증되는가
→ 무엇은 사람이 확인해야 하는가
→ 다음에 읽어야 할 상세 문서는 무엇인가
```

세부는 §8의 문서들로 넘긴다. **이 문서가 상세 문서를 대체하지 않는다.**

---

## 상태 표기 규칙 (필수)

> 이 블록은 지우지 않는다. 이 문서의 신뢰성이 여기서 나온다.

| 표기 | 뜻 |
| --- | --- |
| **DONE** | 저장소에 실제 구현이 있고, 요구된 검증을 통과했다 |
| **PLANNED** | 계획되었지만 아직 구현이 없다 |
| **DEFERRED** | 의도적으로 후속 scope로 미뤘다 |
| **CANDIDATE** | 검토 후보이며 선택되지도 구현되지도 않았다 |

**의존성이 설치되어 있다는 것은 기능이 구현됐다는 뜻이 아니다.**

패키지가 `package.json` 에 있다는 것, preflight가 통과했다는 것, 샘플이 한 번 돌았다는 것은
전부 **DONE의 근거가 아니다.** 제품 경로에 통합되어 검증을 통과했을 때만 DONE이다.

---

## 1. What This System Is

> 이 시스템이 **무엇을 책임지는가**를 몇 문단으로 적는다.
> 기능 목록이 아니라 역할과 경계다. "무엇을 하지 않는가"도 같이 적으면 좋다.
>
> 아래 표로 현재 상태를 한눈에 구분해 준다.

| | |
| --- | --- |
| **지금 동작한다 (DONE)** | |
| **다음 단계 (PLANNED)** | |
| **미룬 것 (DEFERRED)** | |
| **후보 (CANDIDATE)** | |

---

## 2. Current System Flow

> **현재 구현된** 흐름만 그린다. 계획된 단계를 흐름 안에 섞지 않는다.
> 계획된 단계를 보여야 한다면 시각적으로 분리하고 `(PLANNED)` 를 명시한다.

```text
(입력) → (처리 단계) → (출력)
```

---

## 3. Major Components

> 주요 구성요소를 역할 중심으로 적는다. 소스 파일을 전부 나열하지 않는다.
> 각 항목에 상태(DONE / PLANNED / ...)를 붙인다.

| Component | 역할 | 상태 |
| --- | --- | --- |
| | | |

---

## 4. External Dependency Boundary

> **라이브러리 이름보다 시스템 역할을 먼저 적는다.**
>
> 권장:
>
> ```text
> Product Domain Logic → Adapter Boundary → External Engine / Library
> ```
>
> 피할 것: 라이브러리 이름만 나열하는 목록.
>
> 아래 네 가지를 **반드시 구분**한다. 섞이면 이 문서는 신뢰를 잃는다.

| 구분 | 항목 | 비고 |
| --- | --- | --- |
| **선택됨 · 현재 사용 중** | | 제품 경로에서 실제로 쓰인다 |
| **설치됨 · 미통합** | | 설치만 되어 있다. **기능이 아니다** |
| **후보 · 미선택** | | 설치되지 않았다 |
| **미룸** | | 왜 미뤘는지 한 줄 |

---

## 5. Build Evolution Map

> Phase별로 무엇이 생겼는지 시간 순으로 남긴다.
>
> **과거를 덮어쓰지 않는다.** Phase 3이 시작됐다고 Phase 1·2 항목을 지우거나
> 현재 architecture 설명에 흡수시키지 않는다. 어떤 결정이 언제 왜 내려졌는지
> 추적할 수 있어야 이 문서가 지도 역할을 한다.

### Phase 1 — <이름>  ·  <DONE | PLANNED | DEFERRED>

> 무엇이 생겼는지 · 무엇이 검증됐는지 · 상세 문서 링크

### Phase 2 — <이름>  ·  <상태>

---

## 6. Validation Model

> 프로젝트가 이 구분을 쓰는 경우에만 채운다. 모든 프로젝트에 사람 확인이 필요하지는 않다.
>
> 다만 **자동 테스트 PASS를 사람이 확인해야 할 것까지 PASS로 적지 않는다.**
> 시각적 결과·UX·물리적 정확성처럼 자동으로 판정할 수 없는 것이 있다면 여기서 분리한다.

| | 무엇을 보장하는가 | 수단 |
| --- | --- | --- |
| **Automated validation** | | Gate · 테스트 · Verifier |
| **Human validation / witness** | | 사람이 직접 확인해야 하는 것 |

---

## 7. Known Boundaries / Deferred Work

> 지금 못 하는 것과 일부러 안 한 것을 적는다. 각 항목에 이유를 한 줄씩 남긴다.
> 여기가 비어 있으면 대개 문서가 정직하지 않은 것이다.

---

## 8. Architecture Documents

> 이 문서의 **index 역할**이 여기서 나온다. 상세 내용을 복사해 오지 말고 링크한다.

| 문서 | 무엇이 들어 있는가 |
| --- | --- |
| `docs/PRODUCT-SPEC.md` | 제품 사양 (source of truth) |
| `phase-prompt/` | Phase Goal |
| `docs/LOOP-RUNTIME-FIELD-NOTES.md` | Runtime 운용 관찰 기록 |

---

## 9. Decision History

> 되돌리기 어려운 결정과 그 근거를 남긴다. 바뀐 결정은 지우지 말고 바뀐 사실을 덧붙인다.

| 시점 | 결정 | 근거 | 현재 상태 |
| --- | --- | --- | --- |
| | | | |

---

## 10. Update Rule

> 이 절은 지우지 않는다. 갱신 빈도를 통제하지 않으면 이 문서는 금방 낡거나 비대해진다.

이 문서는 **다음 경우에만** 갱신한다.

1. Phase가 최종 **DONE** 상태가 됐을 때
2. 의미 있는 architecture boundary가 바뀌었을 때
3. 외부 engine / adapter 선택이 확정되거나 교체됐을 때
4. 시스템 전체 흐름이 달라졌을 때

**Task마다 갱신하지 않는다.**

Phase 종료 시 최소 아래를 확인한다.

- §1 현재 상태 표
- §2 System Flow
- §3 Major Components
- §4 External Dependency Boundary
- §5 Build Evolution
- §6 Validation Model
- §7 Known Boundaries
- §9 Decision History

**History를 덮어쓰지 않는다.** 실패한 시도와 교정의 계보는 각 Phase 문서에 그대로 둔다.
**Current / Planned / Deferred 상태는 언제나 구분되어야 한다** — 설치된 의존성을 구현된
기능으로, 계획된 결정을 채택된 구현으로 적지 않는다.

---

## 이 문서가 되어서는 안 되는 것

> 이 절도 작성 지침이며 실제 `SYSTEM-MAP.md` 에는 남기지 않는다.

- 상세 구현 문서의 복사본
- Runtime 내부 설계 전체 복사
- 모든 Task history 기록
- 모든 test case 목록
- 모든 source file 목록
- ADR(결정 기록) 상세 문서의 대체
- Phase sign-off 문서의 대체

전부 **링크로 넘긴다.** 이 문서는 index다.
