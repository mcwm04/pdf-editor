// Tokenizer for PDF content streams (ISO 32000-1, 7.8.2). Keeps byte offsets so a rewrite can copy
// every untouched command byte-for-byte.

export type Operand =
  | { t: 'num'; v: number }
  | { t: 'name'; v: string }
  | { t: 'str'; v: Uint8Array; hex: boolean }
  | { t: 'arr'; v: Operand[] }
  | { t: 'dict'; v: Map<string, Operand> }
  | { t: 'bool'; v: boolean }
  | { t: 'null' };

export interface Op { op: string; args: Operand[]; start: number; end: number }

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
const isRegular = (c: number) => !WS.has(c) && !DELIM.has(c);

export function lex(data: Uint8Array): Op[] {
  const ops: Op[] = [];
  let i = 0;
  const n = data.length;
  let stack: Operand[] = [];
  let opStart = -1;

  const skipWs = () => {
    while (i < n) {
      const c = data[i];
      if (WS.has(c)) i++;
      else if (c === 37) { while (i < n && data[i] !== 10 && data[i] !== 13) i++; } // % comment
      else break;
    }
  };

  const readLiteral = (): Uint8Array => {
    i++; // (
    const out: number[] = [];
    let depth = 1;
    while (i < n) {
      const c = data[i++];
      if (c === 92) { // backslash
        const e = data[i++];
        if (e === 110) out.push(10); else if (e === 114) out.push(13); else if (e === 116) out.push(9);
        else if (e === 98) out.push(8); else if (e === 102) out.push(12);
        else if (e === 13) { if (data[i] === 10) i++; } // line continuation
        else if (e === 10) { /* continuation */ }
        else if (e >= 48 && e <= 55) {
          let v = e - 48;
          for (let k = 0; k < 2 && data[i] >= 48 && data[i] <= 55; k++) v = v * 8 + (data[i++] - 48);
          out.push(v & 255);
        } else out.push(e);
      } else if (c === 40) { depth++; out.push(c); }
      else if (c === 41) { if (--depth === 0) break; out.push(c); }
      else out.push(c);
    }
    return Uint8Array.from(out);
  };

  const readHex = (): Uint8Array => {
    i++; // <
    const digits: number[] = [];
    while (i < n && data[i] !== 62) {
      const c = data[i++];
      const v = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
      if (v >= 0) digits.push(v);
    }
    i++; // >
    if (digits.length % 2) digits.push(0);
    const out = new Uint8Array(digits.length / 2);
    for (let k = 0; k < out.length; k++) out[k] = digits[2 * k] * 16 + digits[2 * k + 1];
    return out;
  };

  const readName = (): string => {
    i++; // /
    let s = '';
    while (i < n && isRegular(data[i])) {
      if (data[i] === 35 && i + 2 < n) { s += String.fromCharCode(parseInt(String.fromCharCode(data[i + 1], data[i + 2]), 16)); i += 3; }
      else s += String.fromCharCode(data[i++]);
    }
    return s;
  };

  const readWord = (): string => {
    let s = '';
    while (i < n && isRegular(data[i])) s += String.fromCharCode(data[i++]);
    return s;
  };

  // Reads one operand object (used inside arrays/dicts); returns null at a keyword.
  const readObject = (): Operand | 'end-arr' | 'end-dict' | { kw: string } => {
    skipWs();
    const c = data[i];
    if (c === 40) return { t: 'str', v: readLiteral(), hex: false };
    if (c === 60 && data[i + 1] === 60) {
      i += 2;
      const d = new Map<string, Operand>();
      for (;;) {
        skipWs();
        if (i >= n) break;
        if (data[i] === 62 && data[i + 1] === 62) { i += 2; break; }
        const k = readObject();
        if (k === 'end-dict' || k === 'end-arr') break;
        const v = readObject();
        if (typeof k === 'object' && 't' in k && k.t === 'name' && typeof v === 'object' && 't' in v) d.set(k.v, v);
      }
      return { t: 'dict', v: d };
    }
    if (c === 60) return { t: 'str', v: readHex(), hex: true };
    if (c === 62 && data[i + 1] === 62) { i += 2; return 'end-dict'; }
    if (c === 91) {
      i++;
      const arr: Operand[] = [];
      for (;;) {
        skipWs();
        if (i >= n) break;
        if (data[i] === 93) { i++; break; }
        const o = readObject();
        if (o === 'end-arr' || o === 'end-dict') break;
        if ('kw' in o) continue; // stray keyword inside an array: ignore
        arr.push(o);
      }
      return { t: 'arr', v: arr };
    }
    if (c === 93) { i++; return 'end-arr'; }
    if (c === 47) return { t: 'name', v: readName() };
    if (c === 123 || c === 125 || c === 41 || c === 62) { i++; return { kw: String.fromCharCode(c) }; }
    const w = readWord();
    if (!w) { i++; return { kw: '' }; }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) return { t: 'num', v: parseFloat(w) };
    if (/^[+-]?\d*\.?\d*$/.test(w) && /\d/.test(w)) return { t: 'num', v: parseFloat(w) || 0 };
    if (w === 'true' || w === 'false') return { t: 'bool', v: w === 'true' };
    if (w === 'null') return { t: 'null' };
    return { kw: w };
  };

  while (i < n) {
    skipWs();
    if (i >= n) break;
    const before = i;
    const o = readObject();
    if (o === 'end-arr' || o === 'end-dict') continue;
    if (!('kw' in o)) { if (opStart < 0) opStart = before; stack.push(o); continue; }
    const kw = o.kw;
    if (!kw) continue;
    if (opStart < 0) opStart = before;
    if (kw === 'BI') {
      // Inline image: key/value pairs, ID, binary data, EI.
      const dict = new Map<string, Operand>();
      for (;;) {
        skipWs();
        if (i >= n) break;
        const k = readObject();
        if (typeof k === 'object' && 'kw' in k) { if (k.kw === 'ID') break; continue; }
        if (k === 'end-arr' || k === 'end-dict') continue;
        const v = readObject();
        if (k.t === 'name' && typeof v === 'object' && 't' in v) dict.set(k.v, v);
      }
      i++; // single whitespace after ID
      // EI must be preceded and followed by whitespace (or end of data).
      while (i < n) {
        if (data[i] === 69 && data[i + 1] === 73 && WS.has(data[i - 1]) && (i + 2 >= n || WS.has(data[i + 2]))) { i += 2; break; }
        i++;
      }
      ops.push({ op: 'BI', args: [{ t: 'dict', v: dict }], start: opStart, end: i });
    } else {
      ops.push({ op: kw, args: stack, start: opStart, end: i });
    }
    stack = []; opStart = -1;
  }
  return ops;
}

// ---------- serialising operands back to text ----------
export function fmtNum(v: number) {
  if (!isFinite(v)) return '0';
  const s = (Math.round(v * 10000) / 10000).toString();
  return s.includes('e') ? v.toFixed(6) : s;
}
export const hexOf = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
export function fmtOperand(o: Operand): string {
  switch (o.t) {
    case 'num': return fmtNum(o.v);
    case 'name': return '/' + o.v.replace(/[^!-~]|[#()<>[\]{}/%]/g, ch => '#' + ch.charCodeAt(0).toString(16).padStart(2, '0'));
    case 'str': return `<${hexOf(o.v)}>`;
    case 'arr': return `[${o.v.map(fmtOperand).join(' ')}]`;
    case 'dict': return `<<${[...o.v].map(([k, v]) => fmtOperand({ t: 'name', v: k }) + ' ' + fmtOperand(v)).join(' ')}>>`;
    case 'bool': return String(o.v);
    case 'null': return 'null';
  }
}
export const fmtOp = (op: Op) => [...op.args.map(fmtOperand), op.op].join(' ');
