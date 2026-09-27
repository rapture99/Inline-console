#!/usr/bin/env node
'use strict';
/**
 * A hashbang plus a directive prologue — the two things the injected
 * prologue must sit *after* without pushing any line down.
 *
 * `use strict` must survive: if the prologue were inserted before it, the
 * directive would stop being a directive and the assignment below would
 * silently create a global instead of throwing.
 */

const out = [];

let strictHeld = false;
try {
  undeclaredAssignment = 1;
} catch (err) {
  strictHeld = err instanceof ReferenceError;
}
out.push(`strict: ${strictHeld}`);

// Line number check: this must report the literal line it sits on.
const here = new Error().stack.split('\n')[1].match(/:(\d+):\d+/)[1];
out.push(`line: ${here}`);

console.log(out.join('\n'));
