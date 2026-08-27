// yaml-lite — Task YAML을 읽기 위한 최소 파서. 의존성 없음.
//
// 왜 직접 쓰는가: 이 repository에는 아직 package.json이 없다. Task Schema는 작고 고정되어 있으므로
// 지원하는 문법을 좁게 제한하고, 그 밖의 문법은 조용히 잘못 읽는 대신 명시적으로 에러를 낸다.
//
// 지원: block map · block sequence · 인라인 flow 배열([] / [a, b]) · 주석 · 따옴표 문자열
//       block scalar(| >, chomping - +) · boolean · null · 정수/실수 · 문자열
//       큰따옴표 스칼라 안의 이스케이프는 \" 와 \\ 둘뿐이다 (아래 DQ_ESCAPES)
// 미지원(에러): flow map({}) · anchor/alias · 여러 document · tab 들여쓰기 · 명시적 indent indicator(|2)
//               그 밖의 이스케이프(\n · \t 등) — 조용히 백슬래시를 남기지 않고 에러를 낸다

export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = 'YamlError';
    this.line = line;
  }
}

function stripComment(s) {
  // 따옴표는 "값이 시작하는 자리"에서만 인용 구간을 연다. 그래서 `it's fine` 같은
  // 평문 아포스트로피는 인용으로 오해되지 않고, `key: "a # b"`의 #는 보존된다.
  const opensValue = (i) => {
    const before = s.slice(0, i).trimEnd();
    return before === '' || /[:,[-]$/.test(before);
  };
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      // 큰따옴표 구간 안에서 백슬래시는 다음 한 글자를 이스케이프한다. 그래서 \" 는
      // 구간을 닫지 않는다. 여기서 인정하는 이스케이프 집합은 DQ_ESCAPES와 같아야 한다 —
      // 스캐너와 디코더가 서로 다른 문자열을 보면 CI-010 같은 어긋남이 다시 생긴다.
      // 작은따옴표 구간은 건드리지 않는다(YAML의 작은따옴표는 백슬래시 이스케이프가 없다).
      if (quote === '"' && c === '\\' && i + 1 < s.length) { i += 1; continue; }
      if (c === quote) quote = null;
    } else if ((c === '"' || c === "'") && opensValue(i)) {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i);
    }
  }
  if (quote) throw new YamlError('unterminated quote');
  return s;
}

/**
 * block scalar(| 또는 >)의 본문을 원본 줄에서 읽는다.
 * 주석 제거 전의 raw 줄을 쓰므로 본문 안의 #와 들여쓰기가 그대로 보존된다.
 * @returns {{ text: string, consumedThrough: number }} consumedThrough = 마지막으로 소비한 줄 번호(1-based)
 */
function readBlockScalar(raw, keyLineNo, keyIndent, style, chomp) {
  const collected = [];
  let last = -1;
  for (let idx = keyLineNo; idx < raw.length; idx++) {
    const line = raw[idx];
    if (line.trim() === '') { collected.push(''); continue; }
    if (line.length - line.trimStart().length <= keyIndent) break;
    collected.push(line);
    last = collected.length - 1;
  }
  if (last === -1) throw new YamlError('empty block scalar', keyLineNo);
  const body = collected.slice(0, last + 1);
  const indents = body.filter((l) => l !== '').map((l) => l.length - l.trimStart().length);
  const blockIndent = Math.min(...indents);
  const stripped = body.map((l) => (l === '' ? '' : l.slice(blockIndent)));

  let text;
  if (style === '|') {
    text = stripped.join('\n');
  } else {
    // folded: 연속된 줄은 공백으로 잇고, 빈 줄은 줄바꿈으로 남긴다.
    const paras = [];
    let cur = [];
    for (const l of stripped) {
      if (l === '') { paras.push(cur.join(' ')); cur = []; } else { cur.push(l); }
    }
    paras.push(cur.join(' '));
    text = paras.join('\n');
  }
  text = text.replace(/\n+$/, '');
  if (chomp !== '-') text += '\n'; // clip(기본)과 keep(+)은 끝에 줄바꿈을 남긴다
  return { text, consumedThrough: keyLineNo + body.length };
}

/**
 * block scalar header 한 줄. `key: |` `key: >-` 와 sequence item 형태 `- key: |-`.
 * parseMap/parseSeq이 실제로 인정하는 모양(KEY_RE + `^([|>])([+-]?)$`)과 같아야 한다.
 */
const BLOCK_SCALAR_HEADER_RE = /^(?:-\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*:\s+[|>][+-]?$/;

function scanLines(text) {
  const out = [];
  const raw = text.split(/\r?\n/);
  // block scalar 본문은 readBlockScalar가 raw 줄에서 직접 읽는다. 그래서 여기서 만든
  // content는 본문에 대해서는 애초에 쓰이지 않는다 — 그런데도 스캔하면 본문의 따옴표·#·
  // 콜론이 문법으로 오인된다. 실제로 `Confirm no 'node:' import exists.` 라는 평범한
  // 산문이 phantom quote를 열어 'unterminated quote'로 Plan 승인을 막았다(OBS-013).
  // 본문의 범위는 readBlockScalar와 같은 규칙으로 정한다: header보다 깊게 들여쓴 줄은
  // 전부 본문이고, header 이하로 돌아오는 첫 비어 있지 않은 줄에서 끝난다.
  let bodyIndent = null;
  for (let idx = 0; idx < raw.length; idx += 1) {
    const line = raw[idx];
    const lineNo = idx + 1;
    if (/^\s*$/.test(line)) continue;
    if (bodyIndent !== null) {
      if (line.length - line.trimStart().length > bodyIndent) {
        // 본문은 해석하지 않는다. tab 들여쓰기 금지만 그대로 적용한다 —
        // tab이 섞이면 readBlockScalar의 들여쓰기 계산이 깨지기 때문이다.
        if (/^\t|^ *\t/.test(line)) throw new YamlError('tab indentation is not allowed', lineNo);
        continue;
      }
      bodyIndent = null;
    }
    if (/^\s*#/.test(line)) continue;
    if (/^\t|^ *\t/.test(line)) throw new YamlError('tab indentation is not allowed', lineNo);
    const content = stripComment(line).trimEnd();
    if (content.trim() === '') continue;
    const trimmed = content.trim();
    if (trimmed === '---' || trimmed === '...') {
      throw new YamlError('multi-document YAML is not supported', lineNo);
    }
    const indent = content.length - content.trimStart().length;
    out.push({ indent, content: trimmed, lineNo });
    if (BLOCK_SCALAR_HEADER_RE.test(trimmed)) {
      // `- key: |-` 는 parseSeq가 dash를 지운 가상 라인(indent + 2)으로 파싱하므로
      // readBlockScalar가 보는 keyIndent도 indent + 2다. 여기서도 같은 값을 쓴다.
      bodyIndent = trimmed.startsWith('- ') ? indent + 2 : indent;
    }
  }
  return out;
}

/**
 * 큰따옴표 스칼라에서 인정하는 이스케이프. **이것뿐이다.**
 * stripComment()의 스캐너가 백슬래시를 이스케이프로 취급하는 집합과 정확히 같아야 한다.
 */
const DQ_ESCAPES = { '"': '"', '\\': '\\' };

/**
 * 큰따옴표 스칼라 본문(따옴표를 뗀 상태)을 실제 문자열로 디코딩한다.
 *
 * 지원하지 않는 이스케이프는 백슬래시를 그대로 남기지 않고 에러를 낸다.
 * 조용히 잘못 읽는 대신 명시적으로 실패한다는 이 파서의 원칙을 따른다 —
 * CI-010은 정확히 "백슬래시가 그대로 남아 실행 불가능한 명령이 되는" 문제였다.
 */
function decodeDoubleQuoted(body, lineNo) {
  if (!body.includes('\\')) return body;
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') { out += c; continue; }
    const next = body[i + 1];
    if (next === undefined) {
      throw new YamlError('dangling escape at the end of a double-quoted scalar', lineNo);
    }
    if (!Object.hasOwn(DQ_ESCAPES, next)) {
      throw new YamlError(
        `unsupported escape "\\${next}" in a double-quoted scalar `
        + `(this parser supports only \\" and \\\\)`,
        lineNo
      );
    }
    out += DQ_ESCAPES[next];
    i += 1;
  }
  return out;
}

function parseScalar(raw, lineNo) {
  const s = raw.trim();
  if (s === '') return null;
  if (s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('{')) throw new YamlError('flow mappings ({...}) are not supported', lineNo);
  if (s.startsWith('|') || s.startsWith('>')) {
    throw new YamlError('block scalar (| >) is only supported as a mapping value', lineNo);
  }
  if (s.startsWith('&') || s.startsWith('*')) {
    throw new YamlError('anchors/aliases are not supported', lineNo);
  }
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new YamlError('unterminated flow sequence', lineNo);
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((p) => parseScalar(p, lineNo));
  }
  if (s.startsWith('"') && s.endsWith('"') && s.length > 1) {
    return decodeDoubleQuoted(s.slice(1, -1), lineNo);
  }
  // 작은따옴표는 이스케이프를 해석하지 않는다. 기존 동작 그대로다.
  if (s.startsWith("'") && s.endsWith("'") && s.length > 1) {
    return s.slice(1, -1);
  }
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return Number.parseFloat(s);
  return s;
}

const KEY_RE = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:(?:\s+(.*))?$/;

// lines: scanLines() 결과, i: 시작 index, indent: 이 블록의 들여쓰기
// 반환: [value, nextIndex]
function parseBlock(lines, i, indent, raw) {
  if (lines[i].content === '-' || lines[i].content.startsWith('- ')) {
    return parseSeq(lines, i, indent, raw);
  }
  return parseMap(lines, i, indent, raw);
}

function parseMap(lines, i, indent, raw) {
  const map = {};
  while (i < lines.length && lines[i].indent === indent) {
    const { content, lineNo } = lines[i];
    if (content.startsWith('- ') || content === '-') {
      throw new YamlError('sequence item where a mapping key was expected', lineNo);
    }
    const m = KEY_RE.exec(content);
    if (!m) throw new YamlError(`expected "key: value", got ${JSON.stringify(content)}`, lineNo);
    const [, key, rest] = m;
    if (Object.hasOwn(map, key)) throw new YamlError(`duplicate key "${key}"`, lineNo);
    if (rest === undefined || rest.trim() === '') {
      const next = lines[i + 1];
      if (next && next.indent > indent) {
        const [value, ni] = parseBlock(lines, i + 1, next.indent, raw);
        map[key] = value;
        i = ni;
      } else {
        map[key] = null;
        i += 1;
      }
    } else if (/^[|>]/.test(rest.trim())) {
      const bs = /^([|>])([+-]?)$/.exec(rest.trim());
      if (!bs) throw new YamlError(`unsupported block scalar header "${rest.trim()}"`, lineNo);
      const { text, consumedThrough } = readBlockScalar(raw, lineNo, indent, bs[1], bs[2]);
      map[key] = text;
      i += 1;
      while (i < lines.length && lines[i].lineNo <= consumedThrough) i += 1;
    } else {
      map[key] = parseScalar(rest, lineNo);
      i += 1;
      const next = lines[i];
      if (next && next.indent > indent) {
        throw new YamlError('unexpected indented block after a scalar value', next.lineNo);
      }
    }
  }
  if (i < lines.length && lines[i].indent > indent) {
    throw new YamlError('inconsistent indentation', lines[i].lineNo);
  }
  return [map, i];
}

function parseSeq(lines, i, indent, raw) {
  const seq = [];
  while (i < lines.length && lines[i].indent === indent &&
         (lines[i].content === '-' || lines[i].content.startsWith('- '))) {
    const { content, lineNo } = lines[i];
    const rest = content === '-' ? '' : content.slice(2).trim();
    if (rest === '') {
      const next = lines[i + 1];
      if (!next || next.indent <= indent) throw new YamlError('empty sequence item', lineNo);
      const [value, ni] = parseBlock(lines, i + 1, next.indent, raw);
      seq.push(value);
      i = ni;
    } else if (KEY_RE.test(rest)) {
      // "- key: value" — dash를 공백으로 바꾼 가상 라인으로 보고 map으로 파싱한다.
      const itemIndent = indent + 2;
      const virtual = [{ indent: itemIndent, content: rest, lineNo }, ...lines.slice(i + 1)];
      const [value, consumed] = parseMap(virtual, 0, itemIndent, raw);
      seq.push(value);
      i += consumed;
    } else {
      seq.push(parseScalar(rest, lineNo));
      i += 1;
    }
  }
  if (i < lines.length && lines[i].indent > indent) {
    throw new YamlError('inconsistent indentation', lines[i].lineNo);
  }
  return [seq, i];
}

export function parseYaml(text) {
  const raw = text.split(/\r?\n/);
  const lines = scanLines(text);
  if (lines.length === 0) return null;
  if (lines[0].indent !== 0) throw new YamlError('document must start at column 0', lines[0].lineNo);
  const [value, next] = parseBlock(lines, 0, 0, raw);
  if (next < lines.length) throw new YamlError('inconsistent indentation', lines[next].lineNo);
  return value;
}
