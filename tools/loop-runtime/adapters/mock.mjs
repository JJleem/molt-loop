// adapter: mock — Runtime 자체를 테스트하기 위한 test double. LLM을 호출하지 않는다.
//
// 실패 경로(잘못된 result · 잘못된 run_id · DONE 요청 · 비정상 종료 · timeout ·
// .loop 무단 변경)를 결정론적으로 재현하기 위한 것이다. 실제 작업에는 쓰지 않는다.
//
// 동작은 환경변수 LOOP_MOCK_* 로 지정한다:
//   LOOP_MOCK_RESULT   result 파일에 쓸 문자열. __RUN__ / __TASK__ 는 실제 값으로 치환된다.
//                      (미지정이면 파일을 쓰지 않는다 -> missing result file 테스트)
//   LOOP_MOCK_EXIT     프로세스 종료 코드 (기본 0)
//   LOOP_MOCK_SLEEP_MS 종료 전 대기 시간 (timeout 테스트용)
//   LOOP_MOCK_TOUCH    실행 중에 수정할 파일 경로 (.loop 무단 변경 테스트용)
//   LOOP_MOCK_WRITE_PATH / LOOP_MOCK_WRITE_BODY
//                      실행 중에 만들 파일. Runtime이 관찰하는 변경(observed_changes)과
//                      Canonical Diff를 LLM 없이 재현하기 위한 fixture다.
//
// Verifier용 (runVerifier):
//   LOOP_MOCK_VERIFIER_SEQ      호출 순서대로 쓸 payload의 JSON 배열. 마지막 값이 이후 계속 쓰인다.
//                               (Verifier FAIL -> retry -> PASS 같은 순차 시나리오 재현용.
//                                카운터는 subject에서 제외되는 .loop-local/ 아래에 둔다.)
//   LOOP_MOCK_VERIFIER          structured_output으로 돌려줄 JSON 문자열.
//                               __RUN__ / __TASK__ / __SUBJECT__ 는 실제 값으로 치환된다.
//                               미지정이면 structured_output: null (결과 없음 테스트)
//   LOOP_MOCK_VERIFIER_RAW      구조화 출력이 객체가 아닌 경우를 만든다 (malformed 테스트)
//   LOOP_MOCK_VERIFIER_EXIT     종료 코드 (기본 0)
//   LOOP_MOCK_VERIFIER_SLEEP_MS 종료 전 대기 (timeout 테스트용)
//   LOOP_MOCK_VERIFIER_TOUCH    실행 중에 수정할 파일 경로 (읽기 전용 위반 탐지 테스트용)
//   LOOP_MOCK_VERIFIER_USAGE    provider 사용량 JSON (미지정이면 unavailable)
//
// Planner용 (runPlanner):
//   LOOP_MOCK_PLANNER           structured_output으로 돌려줄 JSON 문자열.
//                               __PLAN__ / __SUBJECT__ 는 실제 값으로 치환된다.
//                               미지정이면 structured_output: null (결과 없음 테스트)
//   LOOP_MOCK_PLANNER_RAW       구조화 출력이 객체가 아닌 경우를 만든다 (malformed 테스트)
//   LOOP_MOCK_PLANNER_EXIT      종료 코드 (기본 0)
//   LOOP_MOCK_PLANNER_SLEEP_MS  종료 전 대기 (timeout 테스트용)
//   LOOP_MOCK_PLANNER_TOUCH     실행 중에 수정할 파일 경로 (읽기 전용 위반 탐지 테스트용)
//   LOOP_MOCK_PLANNER_USAGE     provider 사용량 JSON (미지정이면 unavailable)
//   LOOP_MOCK_PLANNER_MODEL     provider가 보고한 모델 이름

import { writeFileSync, appendFileSync, readFileSync } from 'node:fs';

export const name = 'mock';

export async function detect() {
  return { available: true, version: 'mock (runtime test double)' };
}

export async function runWorker({ resultPath, timeoutMs, runId, taskId }) {
  const started = Date.now();
  const sleep = Number(process.env.LOOP_MOCK_SLEEP_MS ?? 0);
  if (sleep > 0) {
    const timedOut = sleep >= timeoutMs;
    await new Promise((r) => setTimeout(r, Math.min(sleep, timeoutMs)));
    if (timedOut) {
      return {
        adapter: name, launch_error: null, exit_code: null, signal: 'SIGKILL', timed_out: true,
        duration_ms: Date.now() - started, stdout: '', stderr: '', provider_usage: null,
        model: null, adapter_meta: { mock: true },
      };
    }
  }
  if (process.env.LOOP_MOCK_TOUCH) appendFileSync(process.env.LOOP_MOCK_TOUCH, '\n# mock worker was here\n');
  if (process.env.LOOP_MOCK_WRITE_PATH) {
    writeFileSync(process.env.LOOP_MOCK_WRITE_PATH, process.env.LOOP_MOCK_WRITE_BODY ?? '', 'utf8');
  }
  if (process.env.LOOP_MOCK_RESULT !== undefined) {
    const body = process.env.LOOP_MOCK_RESULT.replaceAll('__RUN__', runId).replaceAll('__TASK__', taskId);
    writeFileSync(resultPath, body, 'utf8');
  }

  return {
    adapter: name,
    launch_error: process.env.LOOP_MOCK_LAUNCH_ERROR ?? null,
    exit_code: Number(process.env.LOOP_MOCK_EXIT ?? 0),
    signal: null,
    timed_out: false,
    duration_ms: Date.now() - started,
    stdout: 'mock worker stdout\n',
    stderr: '',
    provider_usage: process.env.LOOP_MOCK_USAGE ? JSON.parse(process.env.LOOP_MOCK_USAGE) : null,
    model: null,
    adapter_meta: { mock: true },
  };
}

/** Verifier test double. LLM을 호출하지 않는다. 결과는 구조화 출력 채널로 돌려준다. */
export async function runVerifier({ timeoutMs, runId, taskId, subjectSha256 }) {
  const started = Date.now();
  const sleep = Number(process.env.LOOP_MOCK_VERIFIER_SLEEP_MS ?? 0);
  if (sleep > 0) {
    const timedOut = sleep >= timeoutMs;
    await new Promise((r) => setTimeout(r, Math.min(sleep, timeoutMs)));
    if (timedOut) {
      return {
        adapter: name, launch_error: null, exit_code: null, signal: 'SIGKILL', timed_out: true,
        duration_ms: Date.now() - started, stdout: '', stderr: '', provider_usage: null,
        model: null, structured_output: null, adapter_meta: { mock: true },
      };
    }
  }
  if (process.env.LOOP_MOCK_VERIFIER_TOUCH) {
    appendFileSync(process.env.LOOP_MOCK_VERIFIER_TOUCH, '\n# mock verifier was here\n');
  }

  let structured = null;
  const seqRaw = process.env.LOOP_MOCK_VERIFIER_SEQ;
  if (seqRaw !== undefined) {
    const seq = JSON.parse(seqRaw);
    const counter = process.env.LOOP_MOCK_VERIFIER_SEQ_FILE ?? '.loop-local/mock-verifier-seq';
    let n = 0;
    try { n = Number(readFileSync(counter, 'utf8')) || 0; } catch { n = 0; }
    writeFileSync(counter, String(n + 1), 'utf8');
    const body = String(seq[Math.min(n, seq.length - 1)])
      .replaceAll('__RUN__', runId).replaceAll('__TASK__', taskId).replaceAll('__SUBJECT__', subjectSha256 ?? '');
    try { structured = JSON.parse(body); } catch { structured = body; }
  } else if (process.env.LOOP_MOCK_VERIFIER_RAW !== undefined) {
    structured = process.env.LOOP_MOCK_VERIFIER_RAW;   // 객체가 아닌 값 -> Runtime이 거부해야 한다
  } else if (process.env.LOOP_MOCK_VERIFIER !== undefined) {
    const body = process.env.LOOP_MOCK_VERIFIER
      .replaceAll('__RUN__', runId)
      .replaceAll('__TASK__', taskId)
      .replaceAll('__SUBJECT__', subjectSha256 ?? '');
    try {
      structured = JSON.parse(body);
    } catch {
      structured = body; // 파싱 불가 -> 구조화 출력이 아님
    }
  }

  return {
    adapter: name,
    launch_error: process.env.LOOP_MOCK_VERIFIER_LAUNCH_ERROR ?? null,
    exit_code: Number(process.env.LOOP_MOCK_VERIFIER_EXIT ?? 0),
    signal: null,
    timed_out: false,
    duration_ms: Date.now() - started,
    stdout: 'mock verifier stdout\n',
    stderr: '',
    provider_usage: process.env.LOOP_MOCK_VERIFIER_USAGE ? JSON.parse(process.env.LOOP_MOCK_VERIFIER_USAGE) : null,
    model: process.env.LOOP_MOCK_VERIFIER_MODEL ?? null,
    structured_output: structured,
    adapter_meta: { mock: true },
  };
}

/** Planner test double. LLM을 호출하지 않는다. 결과는 구조화 출력 채널로 돌려준다. */
export async function runPlanner({ timeoutMs, planId, subjectSha256 }) {
  const started = Date.now();
  const sleep = Number(process.env.LOOP_MOCK_PLANNER_SLEEP_MS ?? 0);
  if (sleep > 0) {
    const timedOut = sleep >= timeoutMs;
    await new Promise((r) => setTimeout(r, Math.min(sleep, timeoutMs)));
    if (timedOut) {
      return {
        adapter: name, launch_error: null, exit_code: null, signal: 'SIGKILL', timed_out: true,
        duration_ms: Date.now() - started, stdout: '', stderr: '', provider_usage: null,
        model: null, structured_output: null, adapter_meta: { mock: true },
      };
    }
  }
  if (process.env.LOOP_MOCK_PLANNER_TOUCH) {
    appendFileSync(process.env.LOOP_MOCK_PLANNER_TOUCH, '\n# mock planner was here\n');
  }

  let structured = null;
  if (process.env.LOOP_MOCK_PLANNER_RAW !== undefined) {
    structured = process.env.LOOP_MOCK_PLANNER_RAW;   // 객체가 아닌 값 -> Runtime이 거부해야 한다
  } else if (process.env.LOOP_MOCK_PLANNER !== undefined) {
    const body = process.env.LOOP_MOCK_PLANNER
      .replaceAll('__PLAN__', planId)
      .replaceAll('__SUBJECT__', subjectSha256 ?? '');
    try {
      structured = JSON.parse(body);
    } catch {
      structured = body; // 파싱 불가 -> 구조화 출력이 아님
    }
  }

  return {
    adapter: name,
    launch_error: process.env.LOOP_MOCK_PLANNER_LAUNCH_ERROR ?? null,
    exit_code: Number(process.env.LOOP_MOCK_PLANNER_EXIT ?? 0),
    signal: null,
    timed_out: false,
    duration_ms: Date.now() - started,
    stdout: 'mock planner stdout\n',
    stderr: '',
    provider_usage: process.env.LOOP_MOCK_PLANNER_USAGE ? JSON.parse(process.env.LOOP_MOCK_PLANNER_USAGE) : null,
    model: process.env.LOOP_MOCK_PLANNER_MODEL ?? null,
    structured_output: structured,
    adapter_meta: { mock: true },
  };
}
