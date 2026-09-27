/**
 * Every row of the exclusion table, as executable code.
 *
 * Each block prints something that changes if the transform wrapped a
 * position it should not have. Run it with and without instrumentation and
 * diff stdout: identical output is the whole pass condition.
 */

const out = [];
const say = (label, value) => out.push(`${label}: ${value}`);

/* 1. Method receiver — wrapping the callee detaches `this`. */
const counter = {
  n: 41,
  bump() {
    return ++this.n;
  },
};
say('receiver', counter.bump());

/* 2. Optional chaining must still short-circuit. */
const missing = null;
say('optional', missing?.a.b.c === undefined);
const nested = { a: { b: { c: 'deep' } } };
say('optional-hit', nested?.a.b.c);
say('optional-call', missing?.fn().toString() === undefined);

/* 3. typeof on an undeclared binding is legal and must not throw. */
say('typeof-undeclared', typeof neverDeclared);
say('typeof-declared', typeof counter);

/* 4. delete needs a reference, not a value. */
const removable = { gone: 1, kept: 2 };
delete removable.gone;
say('delete', JSON.stringify(removable));

/* 5. Assignment and update targets. */
let plain = 1;
plain = plain + 1;
plain += 3;
plain++;
++plain;
const holder = { v: 0, arr: [0, 0, 0] };
holder.v = 7;
holder.v += 1;
const idx = 2;
holder.arr[idx] = 9;
holder.arr[idx] += 1;
say('assign', `${plain} ${holder.v} ${holder.arr.join(',')}`);

/* 6. Destructuring: targets are bindings, defaults are expressions. */
const source = { x: 1, y: 2, deep: { z: 3 }, list: [4, 5, 6] };
const { x, y: renamed, missingKey = 'fallback', deep: { z }, ...rest } = source;
const [first, , third = 'unused', ...tail] = source.list;
say('destructure', `${x} ${renamed} ${missingKey} ${z} ${first} ${third} ${tail.join(',')} ${Object.keys(rest).join(',')}`);

/* 7. Shorthand properties cannot hold an expression. */
const shorthandValue = 'kept';
const shorthand = { shorthandValue, computed: x + 1, [`key${x}`]: 'dynamic' };
say('shorthand', JSON.stringify(shorthand));

/* 8. Tagged templates: the strings array is cached per call site, and its
      identity is observable across calls. */
const seen = new Set();
function tag(strings, ...values) {
  seen.add(strings);
  return strings.raw.join('|') + '#' + values.join(',');
}
function callTag(v) {
  return tag`a${v}b`;
}
callTag(1);
callTag(2);
say('tagged', `${callTag(3)} cached=${seen.size === 1}`);

/* 9. A getter must be evaluated exactly once per read. */
let getterCalls = 0;
const lazy = {
  get once() {
    getterCalls++;
    return 'value';
  },
};
const readOnce = lazy.once;
say('getter', `${readOnce} calls=${getterCalls}`);

/* 10. Function name inference dies if the initializer is wrapped. */
const namedArrow = () => {};
const namedFn = function () {};
class NamedClass {}
say('names', `${namedArrow.name} ${namedFn.name} ${NamedClass.name}`);

/* 11. Classes: derived constructors, super, and static blocks. */
class Base {
  constructor(seed) {
    this.seed = seed;
  }
  describe() {
    return `base(${this.seed})`;
  }
  static kind = 'base';
}
class Derived extends Base {
  #secret = 'hidden';
  constructor(seed) {
    super(seed * 2);
    this.extra = this.seed + 1;
  }
  describe() {
    return `derived(${super.describe()}, ${this.extra}, ${this.#secret})`;
  }
  static tally = 0;
  static {
    Derived.tally = 1;
  }
}
say('class', `${new Derived(5).describe()} ${Base.kind} ${Derived.tally}`);

/* 12. new.target */
function target() {
  return new.target === undefined ? 'plain' : 'constructed';
}
say('new-target', `${target()} ${new target() instanceof target ? 'constructed' : '?'}`);

/* 13. Labels, break, continue. */
let hops = 0;
outer: for (let i = 0; i < 3; i++) {
  for (let j = 0; j < 3; j++) {
    if (j === 1) continue outer;
    if (i === 2) break outer;
    hops++;
  }
}
say('labels', hops);

/* 14. Generators, async, await. */
function* gen() {
  const received = yield 1;
  yield received * 2;
}
const iterator = gen();
const genOut = [iterator.next().value, iterator.next(10).value];

async function work() {
  const value = await Promise.resolve('awaited');
  for await (const chunk of (async function* () {
    yield 'a';
    yield 'b';
  })()) {
    out.push(`stream: ${chunk}`);
  }
  return value;
}

/* 15. Sequence expressions and comma operator. */
let seqTracker = 0;
const seq = ((seqTracker = 1), (seqTracker += 1), seqTracker * 10);
say('sequence', seq);

/* 16. for-in / for-of bindings. */
const keys = [];
for (const key in { a: 1, b: 2 }) keys.push(key);
const values = [];
for (const value of [1, 2, 3]) values.push(value * 2);
say('loops', `${keys.join(',')} ${values.join(',')}`);

/* 17. try/catch binding, optional catch binding. */
let caught = 'none';
try {
  throw new Error('boom');
} catch (err) {
  caught = err.message;
}
try {
  throw new Error('ignored');
} catch {
  caught += '+bare';
}
say('catch', caught);

/* 18. import.meta is a restricted form. */
say('import-meta', typeof import.meta.url === 'string');

/* 19. Default parameters, rest parameters, spread. */
function defaults(a, b = a * 2, ...more) {
  return [a, b, more.length].join(':');
}
say('params', `${defaults(1)} ${defaults(1, 5, 6, 7)}`);
say('spread', Math.max(...[3, 9, 4]));
say('object-spread', JSON.stringify({ ...source.deep, added: true }));

/* 20. Exponent, nullish, logical assignment. */
let nullish = null;
nullish ??= 'defaulted';
let andAssign = 1;
andAssign &&= 5;
let orAssign = 0;
orAssign ||= 6;
say('operators', `${2 ** 10} ${nullish} ${andAssign} ${orAssign}`);

await work().then((value) => say('async', value));

console.log(out.join('\n'));
