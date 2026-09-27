import { SNode } from './protocol';

/**
 * One-line preview, matching console's own conventions: a top-level string
 * prints bare, a nested string prints quoted.
 */
export function previewArgs(args: SNode[]): string {
  return args.map((a) => preview(a, true)).join(' ');
}

export function preview(node: SNode, topLevel = false): string {
  switch (node.t) {
    case 'prim':
      return node.v;
    case 'string':
      return topLevel ? node.v + (node.trunc ? '…' : '') : quote(node.v, node.trunc);
    case 'fn':
      return (node.cls ? 'class ' : 'ƒ ') + node.name;
    case 'err':
      return node.name + ': ' + node.message;
    case 'circ':
      return '[Circular]';
    case 'deep':
      return node.ctor ? `${node.ctor} {…}` : '{…}';
    case 'arr': {
      const shown = node.items.slice(0, 6).map((i) => preview(i));
      const rest = (node.more ?? 0) + Math.max(0, node.items.length - shown.length);
      if (rest > 0) shown.push(`…+${rest}`);
      const prefix = node.ctor ? `${node.ctor}(${node.len ?? node.items.length}) ` : '';
      return `${prefix}[${shown.join(', ')}]`;
    }
    case 'set': {
      const shown = node.items.slice(0, 5).map((i) => preview(i));
      const rest = (node.more ?? 0) + Math.max(0, node.items.length - shown.length);
      if (rest > 0) shown.push(`…+${rest}`);
      return `Set(${node.len ?? node.items.length}) {${shown.join(', ')}}`;
    }
    case 'map': {
      const shown = node.entries
        .slice(0, 4)
        .map(([k, v]) => `${preview(k)} => ${preview(v)}`);
      const rest = (node.more ?? 0) + Math.max(0, node.entries.length - shown.length);
      if (rest > 0) shown.push(`…+${rest}`);
      return `Map(${node.len ?? node.entries.length}) {${shown.join(', ')}}`;
    }
    case 'obj': {
      const shown = node.entries.slice(0, 5).map(([k, v]) => `${key(k)}: ${preview(v)}`);
      const rest = (node.more ?? 0) + Math.max(0, node.entries.length - shown.length);
      if (rest > 0) shown.push(`…+${rest}`);
      const prefix = node.ctor ? node.ctor + ' ' : '';
      return `${prefix}{${shown.join(', ')}}`;
    }
    default:
      return '?';
  }
}

/** Multi-line expansion used in the hover card. */
export function expand(node: SNode, indent = 0): string {
  const pad = '  '.repeat(indent);
  const padInner = '  '.repeat(indent + 1);

  switch (node.t) {
    case 'err': {
      const head = `${node.name}: ${node.message}`;
      return node.stack ? head + '\n' + indentBlock(node.stack, padInner) : head;
    }
    case 'arr': {
      if (!node.items.length) return node.more ? '[ …' + node.more + ' more ]' : '[]';
      const body = node.items
        .map((i) => padInner + expand(i, indent + 1))
        .join(',\n');
      const tail = node.more ? `,\n${padInner}… ${node.more} more` : '';
      const prefix = node.ctor ? `${node.ctor}(${node.len ?? node.items.length}) ` : '';
      return `${prefix}[\n${body}${tail}\n${pad}]`;
    }
    case 'set': {
      if (!node.items.length) return 'Set(0) {}';
      const body = node.items.map((i) => padInner + expand(i, indent + 1)).join(',\n');
      const tail = node.more ? `,\n${padInner}… ${node.more} more` : '';
      return `Set(${node.len ?? node.items.length}) {\n${body}${tail}\n${pad}}`;
    }
    case 'map': {
      if (!node.entries.length) return 'Map(0) {}';
      const body = node.entries
        .map(([k, v]) => `${padInner}${preview(k)} => ${expand(v, indent + 1)}`)
        .join(',\n');
      const tail = node.more ? `,\n${padInner}… ${node.more} more` : '';
      return `Map(${node.len ?? node.entries.length}) {\n${body}${tail}\n${pad}}`;
    }
    case 'obj': {
      if (!node.entries.length) return node.ctor ? `${node.ctor} {}` : '{}';
      const body = node.entries
        .map(([k, v]) => `${padInner}${key(k)}: ${expand(v, indent + 1)}`)
        .join(',\n');
      const tail = node.more ? `,\n${padInner}… ${node.more} more` : '';
      const prefix = node.ctor ? node.ctor + ' ' : '';
      return `${prefix}{\n${body}${tail}\n${pad}}`;
    }
    default:
      return preview(node);
  }
}

export function expandArgs(args: SNode[]): string {
  return args.map((a) => (a.t === 'string' ? a.v + (a.trunc ? '…' : '') : expand(a))).join('\n');
}

function indentBlock(text: string, pad: string): string {
  return text
    .split('\n')
    .map((l) => pad + l.trim())
    .join('\n');
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function key(k: string): string {
  return IDENT.test(k) ? k : quote(k);
}

function quote(value: string, trunc?: boolean): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `'${escaped}${trunc ? '…' : ''}'`;
}
