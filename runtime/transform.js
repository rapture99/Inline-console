/**
 * Source-to-source instrumentation for Inline Console.
 *
 * Rewrites every expression whose value can safely be observed into a call to
 * an identity function that records the value and returns it untouched:
 *
 *     items.reduce((s, it) => s + it.price, 0)
 *     __ic$(7, __ic$(2, items).reduce((s, it) => __ic$(6, __ic$(3, s) + ...), 0))
 *
 * Identity is the entire contract. If the recorder returns exactly what it was
 * given and throws nothing, semantics are preserved — *provided* we only ever
 * wrap positions where an arbitrary expression is legal. Most of this file is
 * about establishing that "provided".
 *
 * Two invariants the rest of the system depends on:
 *
 *   1. Line numbers never move. The prologue is spliced onto the end of the
 *      line holding the directive prologue (or line 1), never onto its own
 *      line, so stack traces from the untouched console path keep working.
 *
 *   2. Any failure returns null and the caller uses the original source. A
 *      missing value is an inconvenience; a corrupted module is someone's
 *      broken build.
 */

import { parse } from './vendor/acorn.js';

/** Global the recorder installs; see runtime/recorder.js (phase 3). */
export const RECORDER_GLOBAL = '__inlineConsole__';

/**
 * Expression types worth recording.
 *
 * Deliberately absent:
 *   Literal                  — static; its value is already on screen
 *   ThisExpression           — throws if read before super() in a derived
 *                              constructor, and detecting that reliably needs
 *                              scope analysis we do not have yet
 *   Function/Arrow/Class     — wrapping defeats name inference, so
 *     expressions                `const f = () => {}` would lose f.name
 *   SpreadElement, Super,    — not value positions at all
 *     MetaProperty
 */
const WRAPPABLE = new Set([
  'Identifier',
  'MemberExpression',
  'CallExpression',
  'NewExpression',
  'BinaryExpression',
  'LogicalExpression',
  'UnaryExpression',
  'AssignmentExpression',
  'UpdateExpression',
  'ConditionalExpression',
  'TemplateLiteral',
  'TaggedTemplateExpression',
  'ArrayExpression',
  'ObjectExpression',
  'AwaitExpression',
  'YieldExpression',
  'SequenceExpression',
  'ChainExpression',
]);

/** Keys that hold position/metadata rather than child nodes. */
const META_KEYS = new Set(['type', 'start', 'end', 'loc', 'range', 'raw', 'regex', 'bigint']);

function isNode(value) {
  return !!value && typeof value === 'object' && typeof value.type === 'string';
}

/* ------------------------------------------------------------------ *
 * Position rules
 *
 * `canWrap` answers one question: may an arbitrary expression stand where
 * this node stands? Every `return false` below is a case where the answer is
 * no, and wrapping would either fail to parse or silently change behaviour.
 * The default is *deny* for anything not explicitly wrappable, so syntax we
 * have never seen is skipped rather than mangled.
 * ------------------------------------------------------------------ */

function canWrap(node, parent, key, ctx) {
  if (!parent) return false;
  if (!WRAPPABLE.has(node.type)) return false;
  if (ctx.pattern) return false;

  // A callee is never wrapped. Two separate hazards share this rule:
  // `_ic(a.b)(…)` detaches the method from its receiver, and wrapping `eval`
  // turns direct eval into indirect eval, moving its scope to global. The
  // call's *result* is still recorded, and we still descend into the callee
  // to reach the object, so `items.reduce(…)` keeps `items` observable.
  if ((parent.type === 'CallExpression' || parent.type === 'NewExpression') && key === 'callee') {
    return false;
  }

  // `tag` has the receiver problem above; `quasi` must stay a template
  // literal, since the strings array is cached per call site and its identity
  // is observable.
  if (parent.type === 'TaggedTemplateExpression') return false;

  // `typeof undeclared` is legal and yields "undefined"; through a call it
  // throws ReferenceError. `delete` needs a reference, not a value.
  if (
    parent.type === 'UnaryExpression' &&
    key === 'argument' &&
    (parent.operator === 'typeof' || parent.operator === 'delete')
  ) {
    return false;
  }

  // Write targets are references. The result of the assignment is recorded
  // instead, and children (a member object, a computed key) are reached with
  // a normal read context.
  if (parent.type === 'AssignmentExpression' && key === 'left') return false;
  if (parent.type === 'UpdateExpression' && key === 'argument') return false;

  // Not value positions: `a.b`, `{ b: … }`, `class { b() {} }`.
  if (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return false;
  if (
    (parent.type === 'Property' ||
      parent.type === 'PropertyDefinition' ||
      parent.type === 'MethodDefinition') &&
    key === 'key' &&
    !parent.computed
  ) {
    return false;
  }

  // `{ a }` is shorthand: splicing a call in produces `{ _ic(0, a) }`, which
  // is not valid property syntax.
  if (parent.type === 'Property' && parent.shorthand) return false;

  // Binding and declaration names.
  if (key === 'id') return false;

  // Module specifiers, labels, and `new.target` / `import.meta`.
  if (parent.type.endsWith('Specifier')) return false;
  if (
    parent.type === 'ImportDeclaration' ||
    parent.type === 'ExportNamedDeclaration' ||
    parent.type === 'ExportAllDeclaration'
  ) {
    return false;
  }
  if (
    parent.type === 'LabeledStatement' ||
    parent.type === 'BreakStatement' ||
    parent.type === 'ContinueStatement'
  ) {
    return false;
  }
  if (parent.type === 'MetaProperty') return false;

  // Inside an optional chain, only the whole chain may be wrapped. Lifting a
  // link out — `_ic(a?.b).c` — makes `.c` unconditional, so a chain that used
  // to yield undefined now throws.
  if (ctx.chain && (node.type === 'MemberExpression' || node.type === 'CallExpression')) {
    return false;
  }

  return true;
}

/**
 * Context handed to a child: whether it sits in a binding pattern (where
 * nothing may be wrapped) and whether it sits on an optional chain's spine.
 */
function childContext(parent, key, ctx) {
  let pattern = ctx.pattern;
  let chain = ctx.chain;

  // The chain flag follows the spine only. An argument or a computed key is
  // an ordinary expression context and may be instrumented normally.
  if (chain) {
    const onSpine =
      (parent.type === 'ChainExpression' && key === 'expression') ||
      (parent.type === 'MemberExpression' && key === 'object') ||
      (parent.type === 'CallExpression' && key === 'callee');
    if (!onSpine) chain = false;
  }

  if (parent.type === 'VariableDeclarator' && key === 'id') pattern = true;
  else if (key === 'params') pattern = true;
  else if (parent.type === 'CatchClause' && key === 'param') pattern = true;
  else if (parent.type === 'ObjectPattern' || parent.type === 'ArrayPattern') pattern = true;
  else if (parent.type === 'AssignmentPattern') {
    // `function f(a = expr)` — the default is a real expression, the target is not.
    pattern = key === 'left';
  } else if (parent.type === 'RestElement' && key === 'argument') pattern = ctx.pattern;
  else if (
    (parent.type === 'ForInStatement' || parent.type === 'ForOfStatement') &&
    key === 'left'
  ) {
    pattern = true;
  } else if (parent.type === 'AssignmentExpression' && key === 'left') {
    // `a.b = v` and `a[i] = v` still evaluate the object and the computed key
    // as reads, so only a destructuring target suppresses instrumentation.
    pattern = parent.left.type !== 'MemberExpression';
  } else if (parent.type === 'UpdateExpression' && key === 'argument') {
    pattern = parent.argument.type !== 'MemberExpression';
  }

  // A non-computed key is a name, never a read — in a literal or a pattern.
  if (parent.type === 'Property' && key === 'key' && !parent.computed) pattern = true;

  return { pattern, chain };
}

/* ------------------------------------------------------------------ *
 * Walk
 * ------------------------------------------------------------------ */

function collectSites(ast, limit) {
  const sites = [];
  let truncated = false;

  function visit(node, parent, key, ctx) {
    if (truncated) return;

    const here = node.type === 'ChainExpression' ? { ...ctx, chain: true } : ctx;

    if (canWrap(node, parent, key, here) && node.start < node.end) {
      if (sites.length >= limit) {
        truncated = true;
        return;
      }
      sites.push(node);
    }

    for (const childKey of Object.keys(node)) {
      if (META_KEYS.has(childKey)) continue;

      // Shorthand properties share one node between `key` and `value`;
      // visiting both would record the same expression twice.
      if (childKey === 'key' && node.type === 'Property' && node.shorthand) continue;

      const child = node[childKey];
      if (!child || typeof child !== 'object') continue;

      const next = childContext(node, childKey, here);

      if (Array.isArray(child)) {
        for (const item of child) {
          if (isNode(item)) visit(item, node, childKey, next);
        }
      } else if (isNode(child)) {
        visit(child, node, childKey, next);
      }
    }
  }

  visit(ast, null, null, { pattern: false, chain: false });
  return { sites, truncated };
}

/* ------------------------------------------------------------------ *
 * Emit
 * ------------------------------------------------------------------ */

/**
 * Picks a recorder name that cannot collide with anything already in the
 * file. Substring containment is stricter than it needs to be, which is
 * exactly what we want from a name we are about to inject.
 */
function uniqueName(code) {
  let name = '__ic$';
  while (code.indexOf(name) !== -1) name = '_' + name;
  return name;
}

/**
 * Where the prologue goes: after a hashbang, and after any directive prologue
 * so `"use strict"` keeps its meaning — but never on a line of its own, since
 * every line number below it would shift.
 */
function prologueOffset(code, ast) {
  let offset = 0;

  if (code.startsWith('#!')) {
    const newline = code.indexOf('\n');
    offset = newline === -1 ? code.length : newline + 1;
  }

  for (const statement of ast.body) {
    const isDirective =
      statement.type === 'ExpressionStatement' &&
      statement.expression.type === 'Literal' &&
      typeof statement.expression.value === 'string';
    if (!isDirective) break;
    offset = statement.end;
  }

  return offset;
}

/**
 * The recorder is a self-replacing function declaration. Declarations hoist
 * completely, so a circular import that calls into this module before its
 * body has run still finds a callable binding rather than a TDZ error; the
 * first call swaps in the fast per-file closure. With no recorder installed
 * it stays an identity function forever.
 */
function prologue(name, filePath, sites) {
  const table = sites.map((n) => [
    n.loc.start.line,
    n.loc.start.column,
    n.loc.end.line,
    n.loc.end.column,
  ]);

  // Self-delimiting at both ends. The prologue is spliced onto the end of an
  // existing line, so it cannot rely on a newline for statement separation:
  // a file whose directive is written `'use strict'` with no semicolon would
  // otherwise produce `'use strict'function …`, which is a syntax error.
  return (
    `;function ${name}(i,v){var r=globalThis.${RECORDER_GLOBAL};` +
    `if(r){${name}=r.file(${JSON.stringify(filePath)},${JSON.stringify(table)});` +
    `return ${name}(i,v)}return v};`
  );
}

/**
 * Applies all insertions in one pass.
 *
 * Ordering at a shared offset is what keeps nested expressions balanced:
 * closers come before openers, outer opens before inner, inner closes before
 * outer. `a.b.c` opens three times at the same offset and closes three times
 * at the same offset, and only this ordering nests them correctly.
 */
function splice(code, edits) {
  edits.sort((a, b) => a.pos - b.pos || a.group - b.group || a.tie - b.tie);

  let out = '';
  let cursor = 0;
  for (const edit of edits) {
    out += code.slice(cursor, edit.pos) + edit.text;
    cursor = edit.pos;
  }
  return out + code.slice(cursor);
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

const PARSE_OPTIONS = {
  ecmaVersion: 'latest',
  locations: true,
  allowHashBang: true,
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
  allowSuperOutsideMethod: true,
};

/**
 * @param {string} code       original source
 * @param {string} filePath   path recorded with the site table
 * @param {{ maxSites?: number, sourceType?: 'module' | 'script' }} [options]
 * @returns {{ code: string, sites: object[], name: string, truncated: boolean } | null}
 *          null when the file cannot be instrumented — the caller must then
 *          use the original source unchanged.
 */
export function transform(code, filePath, options = {}) {
  try {
    const limit = options.maxSites ?? 20000;

    let ast = null;
    const order = options.sourceType
      ? [options.sourceType]
      : ['module', 'script'];
    for (const sourceType of order) {
      try {
        ast = parse(code, { ...PARSE_OPTIONS, sourceType });
        break;
      } catch {
        /* try the other goal symbol before giving up */
      }
    }
    if (!ast) return null;

    const { sites, truncated } = collectSites(ast, limit);
    if (!sites.length) return null;

    const name = uniqueName(code);
    const edits = [
      { pos: prologueOffset(code, ast), group: -2, tie: 0, text: prologue(name, filePath, sites) },
    ];

    sites.forEach((node, index) => {
      // A sequence expression is the one wrappable form whose text contains
      // top-level commas. Without parentheses of its own those commas become
      // argument separators, and the recorder returns the *first* element
      // instead of the last — a silent wrong-value bug, not a syntax error.
      const comma = node.type === 'SequenceExpression';

      // Minified code writes `case!0:` and `return!0`, with no space between
      // the keyword and the expression. Splicing an identifier straight onto
      // the end of a keyword fuses them into one token — `case__ic$(…)`.
      const fuses = /[\w$]/.test(code[node.start - 1] ?? '');

      edits.push({
        pos: node.start,
        group: 0,
        tie: -node.end,
        text: (fuses ? ' ' : '') + `${name}(${index},` + (comma ? '(' : ''),
      });
      edits.push({
        pos: node.end,
        group: -1,
        tie: -node.start,
        text: comma ? '))' : ')',
      });
    });

    return { code: splice(code, edits), sites, name, truncated };
  } catch {
    // Never let an instrumentation bug reach the application.
    return null;
  }
}
