/**
 * Sloppy-mode hazards. These cannot live in hazards.mjs because modules are
 * always strict, and direct eval / `with` behave differently or are banned.
 */

const out = [];
const say = (label, value) => out.push(`${label}: ${value}`);

/* Direct eval sees the local scope. Wrapping the callee makes it *indirect*
   eval, which evaluates in global scope — `local` would vanish. */
function directEval() {
  const local = 'visible';
  return eval('local');
}
say('direct-eval', directEval());

/* Indirect eval must stay indirect. */
globalThis.globalOnly = 'global';
const indirect = eval;
say('indirect-eval', indirect('globalOnly'));

/* `with` resolves identifiers against the object. */
function withBlock() {
  const scope = { inner: 'from-with' };
  let result;
  with (scope) {
    result = inner;
  }
  return result;
}
say('with', withBlock());

/* `arguments` is a live binding in sloppy mode. */
function usesArguments(a, b) {
  arguments[0] = 'mutated';
  return `${a} ${b} ${arguments.length}`;
}
say('arguments', usesArguments('original', 'second'));

/* typeof on an undeclared global. */
say('typeof-undeclared', typeof notDefinedAnywhere);

/* Function declarations hoist; our injected prologue must not shadow them. */
say('hoisted', hoisted());
function hoisted() {
  return 'hoisted-ok';
}

/* CommonJS module surface stays intact. */
say('module', typeof module.exports === 'object' && typeof require === 'function');

console.log(out.join('\n'));
