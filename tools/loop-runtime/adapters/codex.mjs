// adapter: codex — 자리만 준비되어 있고 아직 구현되지 않았다.
//
// 이 환경에서 `codex`는 PATH에 있지만 실행되지 않는다. Windows npm global 설치본이고
// linux 네이티브 바이너리(@openai/codex-linux-x64)가 없어서 --version조차 실패한다.
// 설치된 CLI의 help를 확인할 수 없으므로 플래그를 추측해서 적지 않는다.
//
// 구현 조건: `codex --help`가 실제로 동작하는 환경에서 지원 플래그와
//            구조화 출력/사용량 노출 여부를 확인한 뒤에 채운다.

import { execFile } from 'node:child_process';

export const name = 'codex';

export async function detect() {
  const probe = await new Promise((resolve) => {
    execFile('codex', ['--version'], { timeout: 15_000 }, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr });
    });
  });
  if (probe.error) {
    const detail = (probe.stderr || probe.error.message).split('\n').find((l) => l.includes('Error:'))
      ?? probe.error.message.split('\n')[0];
    return { available: false, reason: `codex CLI is present but not runnable here (${detail.trim()})` };
  }
  return {
    available: false,
    reason: `codex ${probe.stdout.trim()} is runnable, but this adapter is not implemented yet ` +
      '(inspect `codex --help` for supported flags and usage reporting before implementing)',
  };
}

export async function runWorker() {
  throw new Error('codex adapter is not implemented — see tools/loop-runtime/worker/adapters/codex.mjs');
}

export async function runVerifier() {
  throw new Error('codex adapter is not implemented — see tools/loop-runtime/adapters/codex.mjs');
}
