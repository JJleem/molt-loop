// adapters — Provider Adapter 레지스트리. Worker · Verifier · Planner가 함께 쓴다.
//
// Adapter 인터페이스는 네 함수뿐이다:
//   detect()      -> { available, reason?, version? }
//   runWorker()   -> { adapter, launch_error, exit_code, signal, timed_out, duration_ms,
//                      stdout, stderr, provider_usage, model, adapter_meta }
//   runVerifier() -> 위와 같고 + structured_output (읽기 전용 실행, 결과 파일을 쓰지 않는다)
//   runPlanner()  -> runVerifier와 같은 모양. Goal -> Task 제안. 역시 읽기 전용이다.
// Runtime core는 이 모양에만 의존한다. 특정 CLI를 loopctl에 하드코딩하지 않는다.
//
// Worker · Verifier · Planner는 같은 adapter를 쓰더라도 **항상 별개의 invocation**이다.
// 세션을 재개하지 않고 대화 기록을 공유하지 않는다.

import * as claude from './claude.mjs';
import * as codex from './codex.mjs';
import * as mock from './mock.mjs';

export const ADAPTERS = { claude, codex, mock };

export function getAdapter(name) {
  const adapter = ADAPTERS[name];
  if (!adapter) {
    throw new Error(`unknown worker adapter "${name}" (available: ${Object.keys(ADAPTERS).join(', ')})`);
  }
  return adapter;
}

/** 등록된 adapter들의 사용 가능 여부를 조사한다. LLM 호출은 하지 않는다(--version만). */
export async function detectAll() {
  const out = [];
  for (const [key, adapter] of Object.entries(ADAPTERS)) {
    try {
      out.push({ name: key, ...(await adapter.detect()) });
    } catch (e) {
      out.push({ name: key, available: false, reason: e.message });
    }
  }
  return out;
}
