import test from 'node:test';
import assert from 'node:assert/strict';
import { latexToTypst } from './converter.js';

function eq(latex, expected) {
  const got = latexToTypst(latex);
  assert.equal(got, expected, `\nLaTeX:    ${latex}\nExpected: ${expected}\nGot:      ${got}\n`);
}

test('fractions', () => {
  eq('\\frac{1}{2}', '(1)/(2)');
  eq('\\frac{a+b}{c}', '(a+b)/(c)');
  eq('\\frac{\\partial f}{\\partial x}', '(diff f)/(diff x)');
  eq('\\dfrac{1}{\\frac{2}{3}}', '(1)/((2)/(3))');
});

test('roots', () => {
  eq('\\sqrt{2}', 'sqrt(2)');
  eq('\\sqrt[3]{x}', 'root(3, x)');
  eq('\\sqrt{x^2+1}', 'sqrt(x^2+1)');
});

test('sub and superscripts', () => {
  eq('x^2', 'x^2');
  eq('x_i', 'x_i');
  eq('x_{ij}', 'x_(i j)'); // bare letter run -> spaced (Typst would merge "ij" into one identifier otherwise)
  eq('x^{10}', 'x^(10)');
  eq('a_1^2', 'a_1^2');
  eq('e^{-x}', 'e^(-x)');
});

test('greek letters incl. the phi/epsilon reversal', () => {
  eq('\\alpha + \\beta', 'alpha + beta');
  eq('\\phi', 'phi.alt');
  eq('\\varphi', 'phi');
  eq('\\epsilon', 'epsilon.alt');
  eq('\\varepsilon', 'epsilon');
  eq('\\Delta x', 'Delta x');
});

test('text operators / functions', () => {
  eq('\\sin x + \\cos y', 'sin x + cos y');
  eq('\\lim_{x \\to 0} f(x)', 'lim_(x arrow.r 0) f(x)');
  eq('\\log_2 n', 'log_2 n');
});

test('common symbols', () => {
  eq('a \\times b', 'a times b');
  eq('a \\cdot b', 'a dot.c b');
  eq('x \\in \\mathbb{R}', 'x in bb(R)');
  eq('\\forall x \\exists y', 'forall x exists y');
  eq('\\nabla f', 'nabla f');
  eq('a \\pm b', 'a plus.minus b');
  eq('x \\neq y', 'x eq.not y');
  eq('x \\leq y \\geq z', 'x lt.eq y gt.eq z');
  eq('x \\to \\infty', 'x arrow.r oo');
});

test('sums, products, integrals with bounds', () => {
  eq('\\sum_{i=1}^{n} i', 'sum_(i=1)^n i'); // single-token superscript needs no parens
  eq('\\int_0^1 x\\,dx', 'integral_0^1 x thin d x');
  eq('\\prod_{k=1}^{n} k', 'product_(k=1)^n k'); // single-token superscript needs no parens
});

test('adjacent bare-word tokens get a separating space', () => {
  // Regression: "\sigma\sqrt{2\pi}" used to render as "sigmasqrt(2pi)" -
  // two converted Typst names with no original whitespace between them
  // fused into one bogus identifier. Same risk for symbol-symbol and
  // symbol-operator adjacency.
  eq('\\sigma\\sqrt{2\\pi}', 'sigma sqrt(2pi)');
  eq('\\alpha\\beta', 'alpha beta');
  eq('\\sigma\\cos{x}', 'sigma cos(x)');
  // Normal distribution PDF, the exact equation that surfaced this bug.
  eq(
    'f(x) = \\frac{1}{\\sigma\\sqrt{2\\pi}} e^{-\\frac{1}{2}\\left(\\frac{x-\\mu}{\\sigma}\\right)^{2}}',
    'f(x) = (1)/(sigma sqrt(2pi)) e^(-(1)/(2)((x-mu)/(sigma))^2)'
  );
});

test('bare letter immediately before a converted symbol gets a separating space', () => {
  // Regression: a bare variable directly before \pm/\neq/\sin etc (no LaTeX
  // space needed there, since the backslash itself separates tokens in
  // LaTeX) used to fuse with the converted name - "b\pm" -> "bplus.minus",
  // "c\neq" -> "ceq.not" - because the old fusion guard only checked the
  // *following* side of an inserted name, never the preceding side.
  eq('b\\pm c', 'b plus.minus c');
  eq('c\\neq 0', 'c eq.not 0');
  eq('x\\sin y', 'x sin y');
  eq('a\\daleth b', 'a daleth b'); // uncatalogued command via the fallback path
  // The quadratic-formula equation that surfaced the bug.
  eq(
    '\\frac{1}{x}=\\frac{2c}{-b\\pm\\sqrt{b^2-4ac}}',
    '(1)/(x)=(2c)/(-b plus.minus sqrt(b^2-4a c))'
  );
  eq(
    'x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2c} \\qquad c\\neq 0',
    'x=(-b plus.minus sqrt(b^2-4a c))/(2c) wide c eq.not 0'
  );
});

test('OCR dropping a backslash on a Greek letter does not get letter-spaced', () => {
  // If the OCR step ever emits a bare "sigma"/"mu" instead of "\sigma"/"\mu"
  // (seen in practice for the denominator of a normal-distribution PDF, in
  // an otherwise-correct transcription), it must come through as the clean
  // symbol name, not shredded into "s i g m a" / "m u".
  eq('\\frac{x-mu}{sigma}', '(x-mu)/(sigma)');
});

test('decorations', () => {
  eq('\\vec{v}', 'arrow(v)');
  eq('\\hat{x}', 'hat(x)');
  eq('\\bar{x}', 'macron(x)');
  eq('\\dot{x}', 'dot(x)');
  eq('\\overline{AB}', 'overline(A B)');
});

test('binomial', () => {
  eq('\\binom{n}{k}', 'binom(n, k)');
});

test('text and named operators', () => {
  eq('\\text{if } x > 0', '"if " x > 0');
  eq('\\operatorname{sign}(x)', 'op("sign")(x)');
});

test('matrices', () => {
  eq('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}', 'mat(delim: "(", a, b; c, d)');
  eq('\\begin{bmatrix} 1 & 0 \\\\ 0 & 1 \\end{bmatrix}', 'mat(delim: "[", 1, 0; 0, 1)');
  eq('\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}', 'mat(delim: "|", a, b; c, d)');
});

test('cases', () => {
  eq(
    '\\begin{cases} 1 & x > 0 \\\\ 0 & x = 0 \\\\ -1 & x < 0 \\end{cases}',
    'cases(1 & x > 0, 0 & x = 0, -1 & x < 0)'
  );
});

test('left/right delimiters are stripped (typst auto-sizes)', () => {
  eq('\\left( \\frac{a}{b} \\right)', '( (a)/(b) )');
});

test('strips $ and \\[ \\] wrappers', () => {
  eq('$x^2$', 'x^2');
  eq('$$x^2$$', 'x^2');
  eq('\\[x^2\\]', 'x^2');
});

test('align/aligned/gathered/equation environments', () => {
  eq('\\begin{aligned} x &= 1 \\\\ y &= 2 \\end{aligned}', 'x &= 1 \\ y &= 2');
  eq('\\begin{aligned} x &= 1 \\\\ y &= 2 \\\\ z &= 3 \\end{aligned}', 'x &= 1 \\ y &= 2 \\ z &= 3');
  eq('\\begin{equation} x^2 + y^2 = z^2 \\end{equation}', 'x^2 + y^2 = z^2');
  eq('\\begin{gathered} a = b \\\\ c = d \\end{gathered}', 'a = b \\ c = d');
});

test('matrix nested inside an aligned block', () => {
  eq(
    '\\begin{aligned} A &= \\begin{pmatrix} 1 & 0 \\\\ 0 & 1 \\end{pmatrix} \\\\ b &= 2 \\end{aligned}',
    'A &= mat(delim: "(", 1, 0; 0, 1) \\ b &= 2'
  );
});

test('mathrm/operatorname placeholders survive adjacent letters and digits', () => {
  eq('\\mathrm{d}0123', 'upright(d)0123');
  eq('\\operatorname{sign}\\operatorname{abs}(x)', 'op("sign")op("abs")(x)');
  // "\mathrm{d}x" is a differential (d immediately followed by a variable),
  // so it now resolves to "dif x", not "upright(d)x". See the dedicated
  // differential-operator tests below.
  eq('\\mathrm{d}x \\operatorname{rank}(A)', 'dif x op("rank")(A)');
});

test('\\mathrm{d} as a differential operator becomes Typst\'s native "dif"', () => {
  // A digit right after \mathrm{d} can never be a differentiation variable
  // (LaTeX's differential is always "d" + a variable, never a numeral), so
  // that case stays plain upright(d) - unchanged regression from above.
  eq('\\mathrm{d}0123', 'upright(d)0123');
  // Letter, bracket, or another command right after -> a real differential.
  eq('\\mathrm{d}x', 'dif x');
  eq('\\mathrm{d}t', 'dif t');
  eq('\\mathrm{d}\\theta', 'dif theta');
  eq('\\mathrm{d}[x]', 'dif [x]');
  // No fusion with a bare letter immediately before it either.
  eq('a\\mathrm{d}x', 'a dif x');
  // The exact derivative-of-a-fraction shape from the bug report.
  eq('\\frac{-\\mathrm{d}x}{\\mathrm{d}t}', '(-dif x)/(dif t)');
});

test('literal "/" is escaped so Typst does not auto-render it as a fraction', () => {
  // Typst's math mode turns a bare "/" into a stacked frac() layout. LaTeX
  // never gives "/" that meaning - only \frac{}{} makes a real fraction - so
  // any literal slash from OCR'd LaTeX source must survive as an escaped
  // "\/" glyph, not a fraction.
  eq('K_a/[H_3O^+]', 'K_a\\/[H_3O^(+)]');
  eq('a/b', 'a\\/b');
  // \frac itself must still synthesize a REAL fraction - its own "/" must
  // NOT be escaped.
  eq('\\frac{a}{b}', '(a)/(b)');
  // A "/" inside \text{...} is prose, not math, and is also left untouched
  // since Typst displays quoted-string contents verbatim.
  eq('\\text{km/h}', '"km/h"');
  // Regression: convertGroups recurses once per nesting level (once for the
  // whole expression, again for each \frac argument), so a literal "/"
  // inside an as-yet-unextracted \frac argument used to get escaped by the
  // outer pass, then escaped AGAIN by the inner recursive pass once that
  // argument's content was pulled out and reprocessed - "\/" became "\\/".
  // escapeLiteralSlashes' lookbehind makes a second pass over already-
  // escaped text a no-op.
  eq('\\frac{k_2 K_a/[H^+]}{1 + K_a/[H^+]}', '(k_2 K_a\\/[H^(+)])/(1 + K_a\\/[H^(+)])');
});

test('subscript placeholder does not leak "qqqprotectqqq..." garbage', () => {
  // Regression: a \mathrm{...} subscript (e.g. K_\mathrm{a}) is converted to
  // a protect() placeholder before convertSubSuperscripts ever sees it.
  // grabGroup's backslash-command branch used to stop at the last letter of
  // the placeholder, stranding its digit terminator outside the grabbed
  // group - permanently breaking restoreProtected's ability to resolve it,
  // so it leaked into the final output as literal "qqqprotectqqq..." text.
  eq('K_\\mathrm{a}', 'K_(upright(a))');
  eq('K_\\mathrm{a}/[\\mathrm{H_3O^+}]', 'K_(upright(a))\\/[upright(H_3O^+)]');
});

test('superscript inside frac/sqrt/decoration does not double-wrap in parens', () => {
  // Regression: handleTwoArgCommands/handleOneArgCommands/handleSqrt
  // recursively convert their arguments to FINAL Typst syntax (e.g. a
  // literal "^(...)" from a converted superscript) before splicing the
  // result back in. Without protect()-ing that result, the outer
  // convertGroups call's own convertSubSuperscripts step (running later in
  // the same pass) would re-scan the already-finished "^" and mangle it -
  // grabGroup would see the literal "(" right after it, grab it as a lone
  // one-character token, and wrap THAT in its own parens:
  // "X_2^(+)" -> "X_2^(()+)".
  eq('\\frac{X_2^{+}}{y}', '(X_2^(+))/(y)');
  eq('\\sqrt{X_2^{+}}', 'sqrt(X_2^(+))');
});

test('end-to-end: full bug-report equation (differential, slash escaping, placeholder leak, double-paren)', () => {
  // The exact equation that surfaced all four bugs at once: a rate-law
  // expression with a derivative (d/dt), a subscripted \mathrm{a} divided by
  // a bracketed concentration term, and a superscripted "+" nested inside
  // \mathrm{...}[...] groups.
  eq(
    "\\frac{-\\mathrm{d}[\\mathrm{Codpt}(\\mathrm{H_2O})X_2^{+}]}{\\mathrm{d}t} = k_{\\mathrm{obs}}C_t = \\frac{k_2 + k'_2 K_\\mathrm{a}/[\\mathrm{H_3O^+}]}{1 + K_\\mathrm{a}/[\\mathrm{H_3O^+}]}C_t",
    '(-dif [upright(Codpt)(upright(H_2O))X_2^(+)])/(dif t) = k_(upright(obs))C_t = (k_2 + k\'_2 K_(upright(a))\\/[upright(H_3O^+)])/(1 + K_(upright(a))\\/[upright(H_3O^+)])C_t'
  );
});
