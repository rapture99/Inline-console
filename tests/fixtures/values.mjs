/**
 * Exercises the recorder end to end with values known ahead of time, so the
 * wire check can assert on them rather than just eyeballing traffic.
 *
 * The hot loop is the point: 50,000 iterations must not become 50,000 events.
 */

const order = { id: 'a1', total: 99.5, tags: ['new', 'paid'] };
const items = [1, 2, 3, 4];

const sum = items.reduce((acc, n) => acc + n, 0);
const label = `${order.id} / ${sum}`;

let last = 0;
for (let i = 0; i < 50000; i++) {
  last = i * 2;
}

const nested = { a: { b: { c: [1, 2, { deep: true }] } } };
const cyclic = { name: 'loop' };
cyclic.self = cyclic;

function classify(value) {
  const kind = typeof value;
  return kind === 'number' ? value * 2 : String(value);
}

const classified = [classify(21), classify('x')];

console.log('done', label, last, classified.join(','), nested.a.b.c.length, cyclic.name);
