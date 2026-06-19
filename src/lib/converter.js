/**
 * LaTeX -> Typst math converter.
 *
 * Scope: converts the LaTeX produced by the OCR step (single math expression,
 * not a full document) into Typst math markup that can be pasted directly
 * between `$ ... $` in a .typ file.
 *
 * This is a best-effort syntactic transpiler, not a full LaTeX parser. It
 * covers the symbols/structures that appear in the overwhelming majority of
 * OCR'd equations: fractions, roots, sub/superscripts, Greek letters, the
 * standard operator/function names, common binary relations and symbols,
 * matrices (pmatrix/bmatrix/vmatrix/matrix/array), cases, text runs, and
 * decorations (hat/bar/dot/vec/overline/underline/overbrace/underbrace).
 *
 * Reference used for the LaTeX-command -> Typst-name table: Jianrui Lyu,
 * "Equivalent Typst Function Names of LaTeX Commands" (CTAN, typstfun),
 * cross-checked against the official Typst docs (typst.app/docs/reference/math).
 */

// ---------------------------------------------------------------------------
// Small parsing helpers
// ---------------------------------------------------------------------------

/**
 * Given a string and the index of an opening brace/bracket, return the index
 * of the matching closing brace/bracket (handling nesting), or -1 if none.
 */
function findMatching(str, openIdx, openChar = '{', closeChar = '}') {
  let depth = 0;
  for (let i = openIdx; i < str.length; i++) {
    if (str[i] === openChar) depth++;
    else if (str[i] === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * If `str` starting at `idx` (after skipping whitespace) begins with `{`,
 * return { content, nextIdx } where content is the text inside the braces
 * (not yet converted) and nextIdx is the index right after the closing `}`.
 * If it begins with a single non-brace token (e.g. a letter, digit, or a
 * backslash command like \alpha), that single token is returned instead.
 * Returns null if there is nothing to grab.
 */
function grabGroup(str, idx) {
  while (idx < str.length && /\s/.test(str[idx])) idx++;
  if (idx >= str.length) return null;

  if (str[idx] === '{') {
    const close = findMatching(str, idx, '{', '}');
    if (close === -1) return null;
    return { content: str.slice(idx + 1, close), nextIdx: close + 1 };
  }

  // A backslash command, e.g. \alpha, \partial
  if (str[idx] === '\\') {
    // A protect() placeholder (see below) must be grabbed as one atomic
    // unit INCLUDING its trailing digit terminator. The generic
    // backslash-command match just below stops at the last letter - for an
    // ordinary command like \alpha that's the whole token, but a
    // placeholder's terminator is a digit, which [a-zA-Z]+ can't include.
    // Falling through to the generic match would strand that terminator
    // outside whatever group this grab is feeding (e.g. a `_(...)`
    // wrapper), permanently breaking restoreProtected's ability to find
    // and resolve it later - it leaks out as literal "qqqprotectqqq..."
    // text in the final output instead.
    const p = new RegExp(`^\\\\${PROTECT_TAG}[a-z]+0`).exec(str.slice(idx));
    if (p) return { content: p[0], nextIdx: idx + p[0].length };
    const m = /^\\[a-zA-Z]+/.exec(str.slice(idx));
    if (m) return { content: m[0], nextIdx: idx + m[0].length };
    // \, \; etc single-char command
    return { content: str.slice(idx, idx + 2), nextIdx: idx + 2 };
  }

  // A single character token (letter or digit)
  return { content: str[idx], nextIdx: idx + 1 };
}

/**
 * Build the source for a regex matching `\name` only when it is NOT
 * immediately followed by another letter. Plain `\b` is unsuitable for this:
 * `\b` treats `_` as a word character, so e.g. `\int_0` has no word boundary
 * between "int" and "_0", and `\\int\b` silently fails to match - the
 * command then falls through whatever fallback follows and loses its
 * intended translation. A negative lookahead for "another letter follows"
 * gets this right for every terminator that actually occurs after a LaTeX
 * command name: `{`, `_`, `^`, a digit, whitespace, punctuation, or EOF.
 */
function cmdEnd(name) {
  return `\\\\${name}(?![a-zA-Z])`;
}

// ---------------------------------------------------------------------------
// Protected-segment mechanism: lets a synthesis step "lock" a chunk of
// already-finished Typst output (e.g. a literal `mat(...)` or `op("...")`
// it just built) so that later passes in the same convertGroups call - or
// an outer convertGroups call this output gets embedded into - don't treat
// the literal Typst keywords as bare LaTeX prose and mangle them (the
// bare-letter-run spacer would otherwise turn "mat" into "m a t").
// Reset once per top-level latexToTypst call; restored once at the end.
// ---------------------------------------------------------------------------
let protectedSegments = [];

// Fixed letters-only tag string, never a real LaTeX command name.
const PROTECT_TAG = 'qqqprotectqqq';

// Pure-letter base-26 index encoding. A digit anywhere in the placeholder
// would break it out of the single backslash-letter run that
// spaceOutBareLetterRuns treats as one atomic token (its split regex is
// `\\[a-zA-Z]+` - letters only), so the index has to be spelled with
// letters too.
function encodeIndex(n) {
  n++;
  let out = '';
  while (n > 0) {
    n--;
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

function decodeIndex(code) {
  let n = 0;
  for (const ch of code) n = n * 26 + (ch.charCodeAt(0) - 96);
  return n - 1;
}

// Trailing '0' terminator: without it, a placeholder sitting directly next
// to an unrelated bare letter (e.g. "\mathrm{d}x" -> protect("upright(d)")
// immediately followed by the source's own "x") would have its letter-coded
// index greedily swallow that letter too, since both are indistinguishable
// lowercase letters with no boundary between them. A digit can never be
// part of `[a-z]+`, so it always stops the capture at the right place
// regardless of what text follows.
function protect(str) {
  const idx = protectedSegments.length;
  protectedSegments.push(str);
  return `\\${PROTECT_TAG}${encodeIndex(idx)}0`;
}

function restoreProtected(s) {
  // A protected segment can itself contain another protected segment's
  // placeholder (e.g. a matrix nested inside an aligned block: the matrix
  // is protect()-ed first, then the whole align body - placeholder and all
  // - is protect()-ed again). String.replace only scans the original string
  // once and never re-scans the text it just substituted in, so a single
  // pass would leave inner placeholders like this unresolved. Looping to a
  // fixed point handles any nesting depth; it always terminates because an
  // outer placeholder can only ever reference an earlier (already-built)
  // entry, never a later or circular one.
  const re = new RegExp(`\\\\?${PROTECT_TAG}([a-z]+)0`, 'g');
  let prev;
  do {
    prev = s;
    s = s.replace(re, (_, code) => protectedSegments[decodeIndex(code)]);
  } while (s !== prev);
  return s;
}

// ---------------------------------------------------------------------------
// Symbol table (LaTeX command -> Typst name), built from the official Typst
// docs and the typstfun reference sheet.
// ---------------------------------------------------------------------------

const SYMBOL_MAP = {
  // Greek (lowercase)
  alpha: 'alpha', beta: 'beta', gamma: 'gamma', delta: 'delta',
  epsilon: 'epsilon.alt', varepsilon: 'epsilon', zeta: 'zeta', eta: 'eta',
  theta: 'theta', vartheta: 'theta.alt', iota: 'iota', kappa: 'kappa',
  lambda: 'lambda', mu: 'mu', nu: 'nu', xi: 'xi', pi: 'pi', varpi: 'pi.alt',
  rho: 'rho', varrho: 'rho.alt', sigma: 'sigma', varsigma: 'sigma.alt',
  tau: 'tau', upsilon: 'upsilon', phi: 'phi.alt', varphi: 'phi', chi: 'chi',
  psi: 'psi', omega: 'omega',
  // Greek (uppercase) - only the ones that differ visually from Latin
  Gamma: 'Gamma', Delta: 'Delta', Theta: 'Theta', Lambda: 'Lambda',
  Xi: 'Xi', Pi: 'Pi', Sigma: 'Sigma', Upsilon: 'Upsilon', Phi: 'Phi',
  Psi: 'Psi', Omega: 'Omega',

  // Common constants / misc symbols
  infty: 'oo', hbar: 'planck.reduce', ell: 'ell', aleph: 'alef',
  emptyset: 'nothing', varnothing: 'nothing', nabla: 'nabla',
  partial: 'diff', prime: 'prime', forall: 'forall', exists: 'exists',
  imath: 'dotless.i', jmath: 'dotless.j', wp: 'wp',

  // Binary operators / relations
  pm: 'plus.minus', mp: 'minus.plus', times: 'times', div: 'div',
  cdot: 'dot.c', ast: 'ast', star: 'star', circ: 'circle.small',
  bullet: 'bullet', oplus: 'plus.circle', ominus: 'minus.circle',
  otimes: 'times.circle', odot: 'dot.circle', setminus: 'without',
  wr: 'wreath',

  le: 'lt.eq', leq: 'lt.eq', leqslant: 'lt.eq.slant',
  ge: 'gt.eq', geq: 'gt.eq', geqslant: 'gt.eq.slant',
  ne: 'eq.not', neq: 'eq.not', equiv: 'equiv', approx: 'approx',
  approxeq: 'approx.eq', cong: 'tilde.equiv', sim: 'tilde', simeq: 'tilde.eq',
  propto: 'prop', ll: 'lt.double', gg: 'gt.double',
  prec: 'prec', preceq: 'prec.eq', succ: 'succ', succeq: 'succ.eq',

  in: 'in', notin: 'in.not', ni: 'in.rev',
  subset: 'subset', subseteq: 'subset.eq', subsetneq: 'subset.neq',
  supset: 'supset', supseteq: 'supset.eq', supsetneq: 'supset.neq',
  cup: 'union', cap: 'sect', uplus: 'union.plus',
  sqcup: 'union.sq', sqcap: 'sect.sq',
  vee: 'or', wedge: 'and', oplus2: 'plus.circle',

  perp: 'perp', parallel: 'parallel', angle: 'angle',
  measuredangle: 'angle.arc', mid: 'divides', nmid: 'divides.not',
  models: 'models', vdash: 'tack.r', dashv: 'tack.l',

  // Dots
  ldots: 'dots.l', cdots: 'dots.c', vdots: 'dots.v', ddots: 'dots.down',
  dots: 'dots.l',

  // Arrows
  to: 'arrow.r', rightarrow: 'arrow.r', leftarrow: 'arrow.l',
  leftrightarrow: 'arrow.l.r', Rightarrow: 'arrow.double',
  Leftarrow: 'arrow.double.l', Leftrightarrow: 'arrow.double.l.r',
  longrightarrow: 'arrow.long', longleftarrow: 'arrow.long.l',
  mapsto: 'arrow.bar', longmapsto: 'arrow.long.bar',
  hookrightarrow: 'arrow.hook', rightharpoonup: 'harpoon.tr',
  uparrow: 'arrow.t', downarrow: 'arrow.b', updownarrow: 'arrow.t.b',
  nrightarrow: 'arrow.not', nleftarrow: 'arrow.l.not',
  leadsto: 'arrow.squiggly',

  // Delimiters / brackets (used outside auto-sizing contexts)
  langle: 'angle.l', rangle: 'angle.r',
  lbrace: 'brace.l', rbrace: 'brace.r',
  lbrack: 'bracket.l', rbrack: 'bracket.r',
  lceil: 'ceil.l', rceil: 'ceil.r', lfloor: 'floor.l', rfloor: 'floor.r',

  // Sums / products / integrals
  sum: 'sum', prod: 'product', coprod: 'product.co',
  int: 'integral', iint: 'integral.double', iiint: 'integral.triple',
  oint: 'integral.cont',

  // Big operators
  bigcup: 'union.big', bigcap: 'sect.big', bigvee: 'or.big',
  bigwedge: 'and.big', bigoplus: 'plus.circle.big',
  bigotimes: 'times.circle.big', bigodot: 'dot.circle.big',

  // Misc that are identical bare words already (kept for documentation/tests)
  top: 'top', bot: 'bot', neg: 'not', lnot: 'not',
  checkmark: 'checkmark', dagger: 'dagger', ddagger: 'dagger.double',
};

// LaTeX text-style commands that just need their backslash form translated
// to a bare Typst function/operator name (no argument re-wrapping needed
// beyond what the generic "named function" pass already does).
const TEXT_OPERATORS = [
  'arccos', 'arcsin', 'arctan', 'arg', 'cos', 'cosh', 'cot', 'coth', 'csc',
  'csch', 'deg', 'det', 'dim', 'exp', 'gcd', 'hom', 'inf', 'ker', 'lg',
  'lim', 'liminf', 'limsup', 'ln', 'log', 'max', 'min', 'mod', 'Pr', 'sec',
  'sech', 'sin', 'sinh', 'sup', 'tan', 'tanh',
];

// ---------------------------------------------------------------------------
// Main conversion
// ---------------------------------------------------------------------------

function latexToTypst(input) {
  if (!input || !input.trim()) return '';

  // Fresh protected-segment store for this call (see `protect` above).
  protectedSegments = [];

  let s = input.trim();

  // Strip $$ ... $$, $ ... $, \[ ... \], \( ... \) wrappers if the OCR
  // included them - we only want the inner math.
  s = s.replace(/^\$\$([\s\S]*)\$\$$/, '$1');
  s = s.replace(/^\$([\s\S]*)\$$/, '$1');
  s = s.replace(/^\\\[([\s\S]*)\\\]$/, '$1');
  s = s.replace(/^\\\(([\s\S]*)\\\)$/, '$1');
  s = s.trim();

  s = convertEnvironments(s);
  s = convertGroups(s);
  s = restoreProtected(s);

  // Collapse excess whitespace introduced by the passes above.
  s = s.replace(/[ \t]+/g, ' ').replace(/ +\n/g, '\n').trim();

  return s;
}

// --- Environments: matrices, cases, aligned blocks ------------------------

const MATRIX_DELIMS = {
  matrix: null,
  pmatrix: ['(', ')'],
  bmatrix: ['[', ']'],
  Bmatrix: ['{', '}'],
  vmatrix: ['|', '|'],
  Vmatrix: ['', ''], // double-bar, no single-char Typst delim - left plain
  array: null,
};

function convertEnvironments(s) {
  const envRegex = /\\begin\{(\w+\*?)\}([\s\S]*?)\\end\{\1\}/;
  let match;
  let guard = 0;
  while ((match = envRegex.exec(s)) && guard++ < 200) {
    const [whole, envNameRaw, body] = match;
    const envName = envNameRaw.replace(/\*$/, '');
    let replacement;

    if (envName in MATRIX_DELIMS) {
      replacement = convertMatrixBody(body, MATRIX_DELIMS[envName]);
    } else if (envName === 'cases') {
      replacement = convertCasesBody(body);
    } else if (envName === 'align' || envName === 'aligned' || envName === 'gathered' || envName === 'equation') {
      // Typst math mode supports `&` for alignment and `\` for line breaks
      // natively, so the body mostly carries over as-is once converted.
      replacement = convertAlignBody(body);
    } else {
      // Unknown environment: best effort, just keep the converted body.
      // Resolve any nested environments first (see convertAlignBody for why),
      // then protect (see convertMatrixBody) since this result is spliced
      // back into `s` before the top-level convertGroups pass runs again.
      replacement = protect(convertGroups(convertEnvironments(body)).trim());
    }

    s = s.slice(0, match.index) + replacement + s.slice(match.index + whole.length);
  }
  return s;
}

/**
 * `\begin{align}`/`aligned`/`gathered`/`equation` bodies carry their own
 * `\\` row breaks (LaTeX) which Typst spells as a single `\`. Each row is
 * converted on its own (so a backslash command split across a row boundary
 * can't leak into the next row) and the LaTeX `\\` is rewritten to a single
 * Typst `\`. The whole result is protected (see convertMatrixBody) since,
 * like the matrix/cases output, it gets spliced back into `s` before the
 * top-level convertGroups pass runs - and that pass's convertSpacing step
 * would otherwise treat a lone `\` followed by whitespace as the `\<space>`
 * spacing command and silently delete it.
 *
 * Nested environments (e.g. a `pmatrix` inside an `aligned` block) are
 * resolved first, via a recursive `convertEnvironments` call, before the
 * `\\` split below runs. Otherwise a nested matrix's own `\\` row
 * separators would be indistinguishable from the outer align's row
 * separators and get shredded by the same naive split.
 */
function convertAlignBody(body) {
  const resolved = convertEnvironments(body);
  const rows = resolved
    .split(/\\\\/)
    .map((row) => row.trim())
    .filter((row) => row.length > 0);
  const convertedRows = rows.map((row) => convertGroups(row));
  return protect(convertedRows.join(' \\ '));
}

/**
 * Split a LaTeX tabular-like body into rows (\\) and cells (&). Nested
 * environments are resolved first for the same reason as convertAlignBody
 * above (a matrix/cases cell could itself contain a nested matrix).
 */
function splitRows(body) {
  const resolved = convertEnvironments(body);
  return resolved
    .split(/\\\\/)
    .map((row) => row.trim())
    .filter((row) => row.length > 0)
    .map((row) => row.split('&').map((cell) => cell.trim()));
}

function convertMatrixBody(body, delim) {
  const rows = splitRows(body);
  const convertedRows = rows.map((cells) =>
    cells.map((cell) => convertGroups(cell)).join(', ')
  );
  const delimArg = delim && delim[0] !== '' ? `delim: "${delim[0]}", ` : (delim === null ? '' : 'delim: #none, ');
  // Protected: this runs inside convertEnvironments, before the top-level
  // convertGroups pass, which would otherwise letter-space the bare word
  // "mat" and the "delim" keyword as if they were ordinary LaTeX prose.
  return protect(`mat(${delimArg}${convertedRows.join('; ')})`);
}

function convertCasesBody(body) {
  const rows = splitRows(body);
  const parts = rows.map((cells) => {
    const value = convertGroups(cells[0] || '');
    if (cells.length > 1) {
      const cond = convertGroups(cells[1]).trim();
      // Wrap plain-text conditions (e.g. "if x > 0") in quotes only if they
      // contain letters meant as prose; numeric/symbolic conditions are left bare.
      return `${value} & ${cond}`;
    }
    return value;
  });
  // Protected for the same reason as convertMatrixBody's return value above.
  return protect(`cases(${parts.join(', ')})`);
}

// --- Token / group level conversion ----------------------------------------

function convertGroups(s) {
  // Text-like commands must be pulled out, raw, before anything else: their
  // contents are prose/identifiers, not math, and must not be touched by the
  // bare-letter spacing pass below (which would otherwise turn "if" into
  // "i f").
  s = handleTextLikeCommands(s);

  // LaTeX never gives "/" any special meaning on its own - only \frac{}{}
  // produces a real fraction, so any literal "/" that survives from OCR'd
  // LaTeX source (e.g. "K_a / [H_3O^+]" written as inline division) is just
  // a slash glyph. Typst's math mode is different: it auto-renders a bare
  // "/" as a stacked frac() layout. Left unescaped, that silently turns
  // intended inline division into a vertical fraction. Escaping to "\/"
  // here preserves the literal-slash meaning. Must run after
  // handleTextLikeCommands (so \text/\mbox/mathrm/operatorname content is
  // already pulled into quoted strings or protect()-ed placeholders, exempt
  // from escaping) and before the frac/sqrt/decoration handlers below
  // (their own templates synthesize real "/" characters for genuine
  // fractions - those must NOT be escaped, and protect()-ing their output
  // already shields it from this pass too).
  s = escapeLiteralSlashes(s);

  // Typst treats a run of bare letters as a single multi-letter identifier
  // (shown upright), whereas LaTeX always renders adjacent letters as
  // separate italic variables. So `ab` (meaning "a times b") needs to become
  // `a b` for Typst to render it the same way. Must run before any
  // backslash command is stripped of its backslash, since the check below
  // only protects letter runs that are still backslash-prefixed.
  s = spaceOutBareLetterRuns(s);

  s = handleTwoArgCommands(s, 'frac', (a, b) => `(${a})/(${b})`);
  s = handleTwoArgCommands(s, 'dfrac', (a, b) => `(${a})/(${b})`);
  s = handleTwoArgCommands(s, 'tfrac', (a, b) => `(${a})/(${b})`);
  s = handleTwoArgCommands(s, 'binom', (a, b) => `binom(${a}, ${b})`);
  s = handleTwoArgCommands(s, 'dbinom', (a, b) => `binom(${a}, ${b})`);
  s = handleTwoArgCommands(s, 'tbinom', (a, b) => `binom(${a}, ${b})`);

  s = handleSqrt(s);

  s = handleOneArgCommands(s, 'overline', (a) => `overline(${a})`);
  s = handleOneArgCommands(s, 'underline', (a) => `underline(${a})`);
  s = handleOneArgCommands(s, 'overbrace', (a) => `overbrace(${a})`);
  s = handleOneArgCommands(s, 'underbrace', (a) => `underbrace(${a})`);
  s = handleOneArgCommands(s, 'hat', (a) => `hat(${a})`);
  s = handleOneArgCommands(s, 'widehat', (a) => `hat(${a})`);
  s = handleOneArgCommands(s, 'bar', (a) => `macron(${a})`);
  s = handleOneArgCommands(s, 'tilde', (a) => `tilde(${a})`);
  s = handleOneArgCommands(s, 'widetilde', (a) => `tilde(${a})`);
  s = handleOneArgCommands(s, 'vec', (a) => `arrow(${a})`);
  s = handleOneArgCommands(s, 'dot', (a) => `dot(${a})`);
  s = handleOneArgCommands(s, 'ddot', (a) => `dot.double(${a})`);
  s = handleOneArgCommands(s, 'mathbb', (a) => `bb(${a})`);
  s = handleOneArgCommands(s, 'mathcal', (a) => `cal(${a})`);
  s = handleOneArgCommands(s, 'mathfrak', (a) => `frak(${a})`);
  s = handleOneArgCommands(s, 'boldsymbol', (a) => `bold(${a})`);
  s = handleOneArgCommands(s, 'mathbf', (a) => `bold(${a})`);

  s = stripLeftRight(s);
  s = convertSubSuperscripts(s);
  s = convertSpacing(s);
  s = convertNamedSymbols(s);
  s = convertTextOperators(s);
  // Catch-all for anything not covered above (custom macros, uncatalogued
  // command names): must run last, since frac/sqrt/decorations above still
  // need their own backslash intact to be recognised by name.
  s = convertSymbolFallback(s);

  // Drop now-meaningless leftover grouping braces, e.g. `{x}` -> `(x)` only
  // where needed for precedence; bare `{...}` with no following script is
  // just a grouping in LaTeX and can become Typst's grouping parens.
  s = s.replace(/\{([^{}]*)\}/g, (m, inner) => `(${convertGroups(inner)})`);

  return s;
}

/**
 * Like handleOneArgCommands, but does NOT recursively run convertGroups on
 * the captured content - the content is used exactly as written. This is
 * for commands whose argument is prose or a literal identifier (\text,
 * \operatorname, ...) rather than a nested math expression.
 */
function handleOneArgRaw(s, cmd, templateFn) {
  const re = new RegExp(cmdEnd(cmd));
  let out = '';
  let rest = s;
  let m;
  while ((m = re.exec(rest))) {
    const before = rest.slice(0, m.index);
    const idx = m.index + m[0].length;
    const g1 = grabGroup(rest, idx);
    if (!g1) {
      out += before + m[0];
      rest = rest.slice(idx);
      continue;
    }
    out += before + templateFn(g1.content);
    rest = rest.slice(g1.nextIdx);
  }
  return out + rest;
}

function handleTextLikeCommands(s) {
  s = handleOneArgRaw(s, 'text', (a) => `"${a}"`);
  s = handleOneArgRaw(s, 'textrm', (a) => `"${a}"`);
  s = handleOneArgRaw(s, 'mbox', (a) => `"${a}"`);
  // Must run before the generic \mathrm handler just below: a bare
  // \mathrm{d} used as a differential operator (e.g. \mathrm{d}x, the "dx"
  // in an integral or derivative) needs Typst's dedicated `dif` symbol
  // instead of generic upright-roman text. See handleDifferentialD.
  s = handleDifferentialD(s);
  // upright(...)/op("...") are protected: they're synthesized here in step 1
  // of convertGroups, and spaceOutBareLetterRuns (step 2, same call) would
  // otherwise letter-space the bare words "upright" and "op".
  s = handleOneArgRaw(s, 'mathrm', (a) => protect(`upright(${a.trim()})`));
  s = handleOneArgRaw(s, 'operatorname', (a) => protect(`op("${a.trim()}")`));
  return s;
}

/**
 * `\mathrm{d}` immediately followed by a variable - a letter, an opening
 * `[`, or another command (e.g. `\mathrm{d}x`, `\mathrm{d}[\ldots]`,
 * `\mathrm{d}\theta`) - is LaTeX's spelling of a differential operator (the
 * "d" in "dx", as opposed to the upright "d" used as an ordinary
 * abbreviation letter). Typst has a dedicated `dif` symbol for exactly this
 * that also carries its own correct spacing/font, so that case is rewritten
 * to `dif` instead of the generic `upright(d)` the plain \mathrm handler
 * below would otherwise produce. A digit right after (e.g. `\mathrm{d}0123`)
 * can never be a differentiation variable - LaTeX's differential is always
 * `d` immediately followed by a variable, never a numeral - so that case is
 * left as plain upright(d), unchanged from before.
 *
 * Like the generic mathrm/operatorname output, the result is a synthesized
 * bare Typst word ("dif") that must be protect()-ed (step 2 of convertGroups,
 * spaceOutBareLetterRuns, would otherwise shred it into "d i f") and is given
 * the same leading/trailing-space treatment as the named-symbol handlers
 * (convertNamedSymbols et al.) so it doesn't visually fuse with a bare
 * letter immediately before or after it.
 */
function handleDifferentialD(s) {
  const re = new RegExp(cmdEnd('mathrm'));
  let out = '';
  let rest = s;
  let m;
  while ((m = re.exec(rest))) {
    const before = rest.slice(0, m.index);
    const idx = m.index + m[0].length;
    const g1 = grabGroup(rest, idx);
    if (!g1 || g1.content.trim() !== 'd') {
      // Not a bare "d": leave untouched for the generic \mathrm handler.
      out += before + m[0];
      rest = rest.slice(idx);
      continue;
    }
    const after = rest.slice(g1.nextIdx);
    const afterTrimmed = after.replace(/^\s+/, '');
    const isDifferential = /^[a-zA-Z[]/.test(afterTrimmed) || afterTrimmed.startsWith('\\');
    const lead = endsWithLetter(before) ? ' ' : '';
    const trail = isDifferential && /^[a-zA-Z\\[]/.test(afterTrimmed) ? ' ' : '';
    out += before + lead + protect(isDifferential ? 'dif' : 'upright(d)') + trail;
    rest = rest.slice(g1.nextIdx);
  }
  return out + rest;
}

/**
 * Insert spaces between adjacent bare letters so Typst renders them as
 * separate single-letter symbols (matching how LaTeX implicitly italicises
 * and spaces juxtaposed variables like `ab` meaning "a times b"). Backslash
 * command names (still intact at this point in the pipeline) and anything
 * already inside a quoted Typst string literal are left untouched.
 */
// Bare (no-backslash) words that should never be letter-spaced even though
// they look like an ordinary multi-letter run - the OCR step occasionally
// drops the leading backslash on a Greek letter or function name (seen in
// practice: "\sigma" rendered as bare "sigma" in one spot of an otherwise
// correct transcription), and without this guard spaceOutBareLetterRuns
// would shred it into single letters ("s i g m a"). Most entries here are
// also the correct Typst spelling already (sigma, pi, sin, cos, ...), so
// leaving them untouched produces correct output directly; the few whose
// Typst name differs from the LaTeX command name (e.g. infty -> oo) at
// least come through as one readable word instead of mangled letters.
const ATOMIC_BARE_WORDS = new Set([...Object.keys(SYMBOL_MAP), ...TEXT_OPERATORS]);

function spaceOutBareLetterRuns(s) {
  // Split out quoted string literals and whole backslash-letter commands
  // (e.g. \left, \frac, \alpha) - both are atomic tokens whose letters must
  // never be separated. A lookbehind on just the match start isn't enough
  // here: e.g. for "\left", a naive scan would protect the "l" right after
  // the backslash but then happily match "eft" starting one character in.
  // Pulling the whole token out up front avoids that.
  const parts = s.split(/("(?:[^"\\]|\\.)*"|\\[a-zA-Z]+)/g);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(/[a-zA-Z]{2,}/g, (run) =>
      ATOMIC_BARE_WORDS.has(run) ? run : run.split('').join(' ')
    );
  }
  return parts.join('');
}

/**
 * Escape every literal "/" in `s` to "\/", protecting it from Typst math
 * mode's auto-fraction-on-bare-slash rendering. See the call site in
 * convertGroups for the full rationale. Uses the same split-and-skip
 * structure as spaceOutBareLetterRuns above (quoted strings and whole
 * backslash-letter commands are left untouched, since a slash inside either
 * one is not a loose division glyph - e.g. a unit string like "\text{km/h}"
 * already became a quoted "km/h" literal upstream, and Typst displays
 * quoted-string contents verbatim with no auto-fraction behaviour).
 *
 * The negative lookbehind (skip a "/" already preceded by "\") makes this
 * idempotent. It has to be: convertGroups runs once per nesting level (e.g.
 * once for the whole expression, then again for each \frac argument via its
 * own recursive convertGroups call), and a literal "/" sitting inside a
 * not-yet-extracted \frac{...} argument is visited by the OUTER pass first -
 * before handleTwoArgCommands below even runs - then visited again by the
 * INNER recursive pass once that argument's content is pulled out and run
 * through the full pipeline a second time. Without the lookbehind, that
 * already-escaped "\/" would get escaped a second time into "\\/".
 */
function escapeLiteralSlashes(s) {
  const parts = s.split(/("(?:[^"\\]|\\.)*"|\\[a-zA-Z]+)/g);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(/(?<!\\)\//g, '\\/');
  }
  return parts.join('');
}

/**
 * True if the character at `pos` in `str` starts something that will end up
 * as a letter in the final Typst output - either a literal letter already,
 * or a backslash command (which every command we translate turns into a
 * bare Typst word). Used to decide whether a just-emitted bare Typst name
 * needs a trailing space so it doesn't visually fuse with whatever follows
 * (Typst has no backslash to delimit identifiers the way LaTeX does, so
 * `sigma` immediately followed by `sqrt(...)` with no separator reads as the
 * single unknown identifier "sigmasqrt", not "sigma" times "sqrt(...)").
 */
function followedByLetter(str, pos) {
  if (pos >= str.length) return false;
  if (/[a-zA-Z]/.test(str[pos])) return true;
  return str[pos] === '\\' && /[a-zA-Z]/.test(str[pos + 1] || '');
}

/**
 * True if the character immediately before `pos` in `str` is a literal
 * letter. Mirrors `followedByLetter` but looks backward. Only a literal
 * letter needs checking here (never a bare backslash): whatever sits right
 * before a match is either plain source text (e.g. the OCR'd variable in
 * "b\pm") or the already-emitted tail of a Typst name a previous step
 * produced - either way, a letter there fuses with a following
 * letter-starting replacement the same way `followedByLetter` guards
 * against on the other side.
 */
function precededByLetter(str, pos) {
  return pos > 0 && /[a-zA-Z]/.test(str[pos - 1]);
}

/**
 * True if `str` ends with a letter - either a literal bare letter (e.g. the
 * OCR'd variable in "...b\sqrt{2}") or the tail of a backslash command that
 * has not been converted yet (e.g. "...\sigma\sqrt{2\pi}"). Used by the
 * structural handlers below (frac/sqrt/decorations) to decide whether they
 * need to insert a separating space before their own bare-word Typst
 * output: those handlers run before convertSymbols/convertTextOperators, so
 * a bare letter or a still-unconverted command sitting immediately before
 * the match (no original whitespace) would otherwise butt directly against
 * a bare word like "sqrt(...)" with nothing between them, fusing into one
 * bogus identifier ("bsqrt", "sigmasqrt") instead of staying two tokens
 * ("b sqrt(...)", "sigma sqrt(...)").
 */
function endsWithLetter(str) {
  return /[a-zA-Z]$/.test(str);
}

/** Prepend a separating space to `replacement` if it's needed to keep it from
 * visually fusing with a letter (bare, or an unconverted command's tail) at
 * the end of `before`. */
function sepIfNeeded(before, replacement) {
  return endsWithLetter(before) && /^[a-zA-Z]/.test(replacement) ? ' ' + replacement : replacement;
}

/**
 * Replace `\cmd{a}{b}` with templateFn(convert(a), convert(b)).
 *
 * The templated result is protect()-ed before being spliced back in. Its
 * arguments were just run through a fresh, recursive convertGroups() call
 * (one full pipeline pass, including convertSubSuperscripts), so the result
 * can already contain literal Typst syntax - in particular a "^(...)"
 * sequence from a converted superscript. Splicing that raw into `out` would
 * leave it sitting in the string for the REST of the outer convertGroups
 * steps still queued after this one - most dangerously convertSubSuperscripts
 * (step 7 below), which would find that already-finished "^" character and
 * try to convert it a second time as if it were still unprocessed LaTeX,
 * mangling it (e.g. "X_2^(+)" -> "X_2^(()+)": grabGroup sees the literal "("
 * right after "^", grabs it as a lone one-character token, and wraps THAT in
 * its own parens). Protecting hides the result behind an opaque placeholder
 * until restoreProtected resolves it at the very end of latexToTypst, after
 * every pass that could misinterpret embedded Typst syntax has finished.
 */
function handleTwoArgCommands(s, cmd, templateFn) {
  const re = new RegExp(cmdEnd(cmd));
  let out = '';
  let rest = s;
  let m;
  while ((m = re.exec(rest))) {
    const before = rest.slice(0, m.index);
    let idx = m.index + m[0].length;
    const g1 = grabGroup(rest, idx);
    if (!g1) {
      out += before + m[0];
      rest = rest.slice(idx);
      continue;
    }
    const g2 = grabGroup(rest, g1.nextIdx);
    if (!g2) {
      out += before + m[0];
      rest = rest.slice(idx);
      continue;
    }
    const a = convertGroups(g1.content);
    const b = convertGroups(g2.content);
    out += before + protect(sepIfNeeded(before, templateFn(a, b)));
    rest = rest.slice(g2.nextIdx);
  }
  return out + rest;
}

/**
 * Replace `\cmd{a}` (or `\cmd x` for a single token) with templateFn(convert(a)).
 * Protected for the same reason as handleTwoArgCommands above.
 */
function handleOneArgCommands(s, cmd, templateFn) {
  const re = new RegExp(cmdEnd(cmd));
  let out = '';
  let rest = s;
  let m;
  while ((m = re.exec(rest))) {
    const before = rest.slice(0, m.index);
    const idx = m.index + m[0].length;
    const g1 = grabGroup(rest, idx);
    if (!g1) {
      out += before + m[0];
      rest = rest.slice(idx);
      continue;
    }
    const a = convertGroups(g1.content);
    out += before + protect(sepIfNeeded(before, templateFn(a)));
    rest = rest.slice(g1.nextIdx);
  }
  return out + rest;
}

function handleSqrt(s) {
  const re = /\\sqrt/;
  let out = '';
  let rest = s;
  let m;
  while ((m = re.exec(rest))) {
    const before = rest.slice(0, m.index);
    let idx = m.index + m[0].length;
    // Optional [n] index
    let indexArg = null;
    if (rest[idx] === '[') {
      const close = findMatching(rest, idx, '[', ']');
      if (close !== -1) {
        indexArg = rest.slice(idx + 1, close);
        idx = close + 1;
      }
    }
    const g = grabGroup(rest, idx);
    if (!g) {
      out += before + m[0];
      rest = rest.slice(idx);
      continue;
    }
    const radicand = convertGroups(g.content);
    const replacement = indexArg
      ? `root(${convertGroups(indexArg)}, ${radicand})`
      : `sqrt(${radicand})`;
    // Protected for the same reason as handleTwoArgCommands above - the
    // radicand was just recursively converted and can already contain
    // literal Typst "^(...)" syntax that later steps must not re-scan.
    out += before + protect(sepIfNeeded(before, replacement));
    rest = rest.slice(g.nextIdx);
  }
  return out + rest;
}

function stripLeftRight(s) {
  return s
    .replace(/\\left\\?/g, '')
    .replace(/\\right\\?/g, '')
    .replace(new RegExp(cmdEnd('bigl'), 'g'), '').replace(new RegExp(cmdEnd('bigr'), 'g'), '')
    .replace(new RegExp(cmdEnd('Bigl'), 'g'), '').replace(new RegExp(cmdEnd('Bigr'), 'g'), '')
    .replace(new RegExp(cmdEnd('big'), 'g'), '').replace(new RegExp(cmdEnd('Big'), 'g'), '');
}

/** Convert `_{...}`, `^{...}`, `_x`, `^x` into Typst's `_(...)` / `^(...)` form. */
function convertSubSuperscripts(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '_' || ch === '^') {
      const g = grabGroup(s, i + 1);
      if (g) {
        const converted = convertGroups(g.content);
        // Single simple alphanumeric tokens don't need parens in Typst.
        const needsParens = !/^[a-zA-Z0-9]$/.test(g.content) || g.content !== converted;
        out += ch + (needsParens ? `(${converted})` : converted);
        i = g.nextIdx;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

function convertSpacing(s) {
  return s
    .replace(new RegExp(cmdEnd('qquad'), 'g'), ' wide ')
    .replace(new RegExp(cmdEnd('quad'), 'g'), ' quad ')
    .replace(new RegExp(cmdEnd('medspace'), 'g'), ' med ')
    .replace(new RegExp(cmdEnd('thickspace'), 'g'), ' thick ')
    .replace(new RegExp(cmdEnd('thinspace'), 'g'), ' thin ')
    .replace(/\\,/g, ' thin ')
    .replace(/\\:/g, ' med ')
    .replace(/\\;/g, ' thick ')
    .replace(/\\!/g, '')
    .replace(/\\\s/g, ' ')
    .replace(/~/g, ' ');
}

function convertTextOperators(s) {
  for (const op of TEXT_OPERATORS) {
    const re = new RegExp(cmdEnd(op), 'g');
    s = s.replace(re, (matched, offset) => {
      const lead = precededByLetter(s, offset) ? ' ' : '';
      const trail = followedByLetter(s, offset + matched.length) ? ' ' : '';
      return lead + op + trail;
    });
  }
  return s;
}

function convertNamedSymbols(s) {
  // Replace longest command names first so e.g. \leq isn't partially matched
  // by a shorter \le rule placed earlier (object key order already helps,
  // but we sort explicitly to be safe).
  const keys = Object.keys(SYMBOL_MAP).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    const re = new RegExp(cmdEnd(key), 'g');
    const name = SYMBOL_MAP[key];
    // Pad on either side whenever a neighbouring character would otherwise
    // fuse with this bare Typst name (see followedByLetter/precededByLetter)
    // - e.g. "\sigma\sqrt{2\pi}" -> "sigma" immediately before "sqrt(2pi)"
    // would read as one identifier "sigmasqrt" without the trailing space,
    // and "b\pm" -> "b" immediately before "plus.minus" would read as one
    // identifier "bplus.minus" without the leading space.
    s = s.replace(re, (matched, offset) => {
      const lead = precededByLetter(s, offset) ? ' ' : '';
      const trail = followedByLetter(s, offset + matched.length) ? ' ' : '';
      return lead + name + trail;
    });
  }
  return s;
}

// Any remaining unrecognised backslash-word command: strip the backslash and
// keep the word verbatim. This is a safe fallback because most LaTeX command
// names that don't need translation are also valid bare words in Typst (e.g.
// custom macros, or names we simply haven't catalogued yet).
//
// Must run AFTER the structural handlers (frac/sqrt/decorations) so that
// \frac, \sqrt, \overline, etc. - none of which are in SYMBOL_MAP - still get
// their proper templated conversion instead of being flattened into a bare
// word + literal braces by this catch-all first.
function convertSymbolFallback(s) {
  return s.replace(/\\([a-zA-Z]+)/g, (matched, word, offset) => {
    const lead = precededByLetter(s, offset) ? ' ' : '';
    const trail = followedByLetter(s, offset + matched.length) ? ' ' : '';
    return lead + word + trail;
  });
}

// ---------------------------------------------------------------------------

export { latexToTypst, SYMBOL_MAP, TEXT_OPERATORS };
