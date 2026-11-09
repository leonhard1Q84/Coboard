import katex from 'katex';

/**
 * Heuristic for the single text input: does this look like a formula?
 * Explicit LaTeX commands, sub/superscripts, or an ASCII math expression with
 * an operator count as math; CJK prose and sentences stay text.
 */
export function looksLikeMath(source: string): boolean {
  const s = source.trim();
  if (!s) return false;
  if (/\\[a-zA-Z]+/.test(s)) return true;
  if (/[⺀-鿿豈-﫿]/.test(s)) return false;
  if (/[_^]/.test(s)) return true;
  return !/[\n。！？；、!?;:]/.test(s) && /[a-zA-Z0-9)\]}]\s*[=+\-×÷*/<>|]\s*[a-zA-Z0-9({[]/.test(s);
}

export type InlineSegment = { kind: 'text' | 'math'; value: string };

const CJK = /[⺀-鿿豈-﫿]/;
const CJK_PUNCT = /[，。！？；：、（）【】《》「」『』—…·]/;
const MATH_CHAR = /[=^_+\-*/<>|(){}\[\]\\×÷]/;
const BARE_OP = /^[=+\-*/<>|]+$/;
// Short tokens that can sit inside a math span: variables, numbers, single letters in any script.
const OPERAND = /^[\p{L}\p{N}.]{1,2}$/u;
const NUMBER = /^\p{N}[\p{N}.,]*$/u;

const isCjkLike = (c: string) => CJK.test(c) || CJK_PUNCT.test(c);
const isOperand = (t: string) => OPERAND.test(t) || NUMBER.test(t);
const isStrong = (t: string) => MATH_CHAR.test(t);

/**
 * Split paragraph text into plain and inline-math runs. Math spans are maximal
 * sequences of operand/operator tokens (single spaces allowed) that contain at
 * least one strong math character and do not start or end on a bare operator.
 * Prose words (3+ letters, no math char) break a span.
 */
export function segmentInlineMath(text: string): InlineSegment[] {
  const out: InlineSegment[] = [];
  const push = (kind: InlineSegment['kind'], value: string) => {
    if (!value) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.value += value;
    else out.push({ kind, value });
  };
  let i = 0;
  while (i < text.length) {
    if (isCjkLike(text[i])) {
      let j = i + 1;
      while (j < text.length && isCjkLike(text[j])) j++;
      push('text', text.slice(i, j));
      i = j;
      continue;
    }
    let j = i;
    while (j < text.length && !isCjkLike(text[j])) j++;
    emitRun(text.slice(i, j), push);
    i = j;
  }
  return out;
}

function emitRun(run: string, push: (kind: InlineSegment['kind'], value: string) => void) {
  const tokens = run.match(/\S+|\s+/g) ?? [];
  const cls = tokens.map((t) => (/^\s+$/.test(t) ? 'space' : isStrong(t) ? 'strong' : isOperand(t) ? 'operand' : 'prose'));
  let i = 0;
  while (i < tokens.length) {
    if (cls[i] === 'prose' || cls[i] === 'space') {
      push('text', tokens[i]);
      i++;
      continue;
    }
    // Candidate span: consecutive operand/strong tokens joined by whitespace.
    let j = i;
    let strong = false;
    let last = i - 1; // index of last non-space token in the span
    while (j < tokens.length) {
      const c = cls[j];
      if (c === 'space') {
        const next = j + 1;
        if (next < tokens.length && cls[next] !== 'prose' && cls[next] !== 'space') { j++; continue; }
        break;
      }
      if (c === 'prose') break;
      if (c === 'strong') strong = true;
      last = j;
      j++;
    }
    const first = tokens[i], end = tokens[last];
    const valid = strong && last >= i && !BARE_OP.test(first) && !BARE_OP.test(end);
    if (valid && last > i - 1) {
      push('math', tokens.slice(i, last + 1).join(''));
      if (last + 1 < j) push('text', tokens.slice(last + 1, j).join('')); // trailing space
      i = j;
    } else {
      push('text', tokens.slice(i, j).join(''));
      i = j;
    }
  }
}

/**
 * Render LaTeX source to HTML. Forgiving by default: unknown commands render
 * marked in KaTeX's own error style instead of dropping the whole formula.
 * Returns null only if KaTeX itself fails unexpectedly.
 */
export function renderMath(source: string, display = true): string | null {
  try {
    return katex.renderToString(source, { displayMode: display, throwOnError: false, strict: 'ignore' });
  } catch {
    return null;
  }
}
