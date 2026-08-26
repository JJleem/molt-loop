// yaml-lite.test — CI-010: 큰따옴표 스칼라 안의 \" 이스케이프.
//
// 관찰된 버그(V0.1 유지보수 중 발견):
//   YAML  command: "node -e \"process.exit(0)\""
//   파싱  node -e \"process.exit(0)\"      <- 백슬래시가 그대로 남았다
//   실행  /bin/sh: 1: Syntax error: "(" unexpected
//
// 두 곳이 원인이었다. 인용 구간 스캐너가 \" 를 구간의 끝으로 봤고,
// 큰따옴표 스칼라 디코딩이 이스케이프를 해석하지 않았다.
//
// Gate는 여전히 fail-closed다 — 잘못된 명령은 ERROR/FAIL이 되지 거짓 PASS가 되지 않는다.
// 이 스위트는 그 성질을 깨지 않으면서 관찰된 케이스만 고쳤음을 확인한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml, YamlError } from '../yaml-lite.mjs';
import { makeProject } from './fixture.mjs';

const withProject = (opts, fn) => {
  const p = makeProject(opts);
  try { return fn(p); } finally { p.cleanup(); }
};

/** 테스트 안에서 YAML 원문을 헷갈리지 않게 쓰기 위한 도우미. */
const yaml = (...lines) => `${lines.join('\n')}\n`;

// ------------------------------------------------------------------
// Case A — 관찰된 명령 그대로
// ------------------------------------------------------------------

test('CI-010: the observed gate command decodes to a runnable shell command', () => {
  // 아래 한 줄은 파일에 이렇게 적힌다:  command: "node -e \"process.exit(0)\""
  const src = yaml(
    'gates:',
    '  build:',
    '    enabled: true',
    '    command: "node -e \\"process.exit(0)\\""'
  );
  assert.equal(
    src.split('\n')[3],
    '    command: "node -e \\"process.exit(0)\\""',
    'the fixture line must literally contain the YAML escapes'
  );

  const command = parseYaml(src).gates.build.command;
  assert.equal(command, 'node -e "process.exit(0)"');
  assert.ok(!command.includes('\\'), `the parsed command must carry no backslash: ${JSON.stringify(command)}`);
});

test('CI-010: the decoded command actually runs in a shell', async () => {
  const { spawnSync } = await import('node:child_process');
  const command = parseYaml(yaml(
    'gates:',
    '  build:',
    '    enabled: true',
    '    command: "node -e \\"process.exit(0)\\""'
  )).gates.build.command;

  const r = spawnSync(command, { shell: true, encoding: 'utf8' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal((r.stderr ?? '').trim(), '', 'the shell must not report a syntax error');
});

// ------------------------------------------------------------------
// Case B — 이스케이프가 인용 구간 추적을 깨지 않는다
// ------------------------------------------------------------------

test('an escaped quote does not close the quoted region early', () => {
  // 인용이 일찍 닫히면 뒤쪽 내용이 잘리거나 다른 토큰으로 잘못 읽힌다.
  const v = parseYaml(yaml('key: "a \\"b\\" c: d, e"')).key;
  assert.equal(v, 'a "b" c: d, e');
});

test('a # inside a double-quoted scalar with escaped quotes is still not a comment', () => {
  const v = parseYaml(yaml('key: "a \\"b\\" # not a comment"')).key;
  assert.equal(v, 'a "b" # not a comment');
});

test('a real comment after a scalar containing escaped quotes is still stripped', () => {
  const v = parseYaml(yaml('key: "node -e \\"x\\"" # this is a comment')).key;
  assert.equal(v, 'node -e "x"');
});

test('an escaped backslash is decoded and keeps the quote state correct', () => {
  // 스캐너와 디코더가 같은 이스케이프 집합을 보지 않으면 여기서 어긋난다.
  assert.equal(parseYaml(yaml('key: "a\\\\b"')).key, 'a\\b');
  assert.equal(parseYaml(yaml('key: "trailing\\\\"')).key, 'trailing\\');
});

test('escaped quotes survive inside a nested mapping value', () => {
  const doc = parseYaml(yaml(
    'gates:',
    '  test:',
    '    enabled: true',
    '    command: "node -e \\"console.log(1)\\""',
    '    reason: "quoted # hash and \\"quotes\\""',
    '  lint:',
    '    enabled: false'
  ));
  assert.equal(doc.gates.test.command, 'node -e "console.log(1)"');
  assert.equal(doc.gates.test.reason, 'quoted # hash and "quotes"');
  assert.equal(doc.gates.lint.enabled, false);
});

// ------------------------------------------------------------------
// Case C — 기존 동작이 그대로다
// ------------------------------------------------------------------

test('ordinary quoted scalars are unchanged', () => {
  assert.equal(parseYaml(yaml('key: "plain double"')).key, 'plain double');
  assert.equal(parseYaml(yaml("key: 'plain single'")).key, 'plain single');
  assert.equal(parseYaml(yaml('key: "a # b"')).key, 'a # b');
  assert.equal(parseYaml(yaml("key: 'a # b'")).key, 'a # b');
  assert.equal(parseYaml(yaml('key: plain scalar')).key, 'plain scalar');
});

test('single-quoted scalars get no escape decoding', () => {
  // YAML의 작은따옴표에는 백슬래시 이스케이프가 없다. 있는 그대로 둔다.
  assert.equal(parseYaml(yaml("key: 'a\\\"b'")).key, 'a\\"b');
});

test('a plain-scalar apostrophe is still not a quote', () => {
  assert.equal(parseYaml(yaml('key: it\'s fine')).key, "it's fine");
});

test('an unterminated quote still fails', () => {
  assert.throws(() => parseYaml(yaml('key: "unterminated')), YamlError);
  assert.throws(() => parseYaml(yaml("key: 'unterminated")), YamlError);
  // 이스케이프 때문에 닫히지 않은 경우도 마찬가지다.
  assert.throws(() => parseYaml(yaml('key: "node -e \\"x\\"')), YamlError);
  // 값 전체가 백슬래시 하나로 끝나 닫는 따옴표를 먹어버린 경우.
  assert.throws(() => parseYaml(yaml('key: "\\"')), YamlError);
});

test('unsupported YAML syntax remains unsupported', () => {
  assert.throws(() => parseYaml(yaml('key: {a: 1}')), /flow mappings/);
  assert.throws(() => parseYaml(yaml('key: &anchor value')), /anchors\/aliases/);
  assert.throws(() => parseYaml(yaml('key: *alias')), /anchors\/aliases/);
  assert.throws(() => parseYaml(yaml('---', 'key: value')), /multi-document/);
  assert.throws(() => parseYaml('key:\n\tnested: 1\n'), /tab indentation/);
  assert.throws(() => parseYaml(yaml('key: [a, b')), /unterminated flow sequence/);
});

test('escapes other than \\" and \\\\ are refused rather than silently kept', () => {
  // 이 파서의 원칙: 조용히 잘못 읽지 않고 명시적으로 실패한다.
  // CI-010은 정확히 "백슬래시가 그대로 남아 실행 불가능한 명령이 되는" 문제였다.
  for (const src of ['key: "a\\nb"', 'key: "a\\tb"', 'key: "a\\u0041b"']) {
    assert.throws(() => parseYaml(yaml(src)), /unsupported escape/, src);
  }
});

test('block scalars and other value shapes are untouched', () => {
  const doc = parseYaml(yaml(
    'request: |-',
    '  line one',
    '  line "two" # not a comment',
    'flag: true',
    'count: 42',
    'ratio: 1.5',
    'empty: null',
    'list: [a, b]'
  ));
  assert.equal(doc.request, 'line one\nline "two" # not a comment');
  assert.equal(doc.flag, true);
  assert.equal(doc.count, 42);
  assert.equal(doc.ratio, 1.5);
  assert.equal(doc.empty, null);
  assert.deepEqual(doc.list, ['a', 'b']);
});

// ------------------------------------------------------------------
// Case D — YAML -> Gate 명령 경계 (버그가 발견된 자리)
// ------------------------------------------------------------------

test('the fixture project.yaml carries the real escaped command', () => {
  withProject({}, (p) => {
    const line = readFileSync(join(p.root, '.loop', 'project.yaml'), 'utf8')
      .split('\n')
      .find((l) => l.includes('command:') && l.includes('node'));
    assert.equal(line, '    command: "node -e \\"process.exit(0)\\""',
      'the fixture must exercise the observed escape, not a rewritten command');
  });
});

test('loopctl gates reports the decoded command, not the escaped source', () => {
  withProject({}, (p) => {
    const r = p.run(['gates']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /node -e "process\.exit\(0\)"/);
    assert.doesNotMatch(r.stdout, /\\"/, 'the runtime must not surface YAML escapes');
  });
});

test('the runtime executes the escaped gate command successfully', () => {
  withProject({}, (p) => {
    const r = p.run(['self-check', 'build']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /build: PASS/);
    assert.match(r.stdout, /node -e "process\.exit\(0\)"/);
  });
});

test('a gate command that is genuinely broken still fails closed', () => {
  // 고친 것은 파싱이지 판정이 아니다. 실행 불가능한 명령은 여전히 PASS가 되지 않는다.
  withProject({
    gates: [
      '  build:',
      '    enabled: true',
      '    command: "node -e \\"syntax ( error\\""',
    ].join('\n'),
  }, (p) => {
    const r = p.run(['self-check', 'build']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.stdout, /build: (FAIL|ERROR|TIMEOUT)/);
    assert.doesNotMatch(r.stdout, /build: PASS/);
  });
});
