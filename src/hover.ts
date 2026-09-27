import * as vscode from 'vscode';
import { LogStore, LineRecord } from './store';
import { expandArgs, previewArgs } from './render';

/**
 * Full, expanded view of the values recorded for the hovered line, plus a
 * short history so you can see how a value changed across calls.
 */
export class LogHoverProvider implements vscode.HoverProvider {
  constructor(private store: LogStore) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.ProviderResult<vscode.Hover> {
    const record = this.store.recordAt(document.uri.fsPath, position.line + 1);
    if (!record || !record.values.length) return undefined;

    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = false;
    markdown.supportThemeIcons = true;

    markdown.appendMarkdown(header(record) + '\n\n');
    markdown.appendCodeblock(expandArgs(record.values[0].args), 'javascript');

    const history = record.values.slice(1, 6);
    if (history.length) {
      markdown.appendMarkdown(`\n**Previous ${history.length}**\n\n`);
      for (const value of history) {
        markdown.appendMarkdown(`- \`${escapeInline(previewArgs(value.args))}\`\n`);
      }
    }

    if (record.dropped > 0) {
      markdown.appendMarkdown(
        `\n_${record.dropped} call${record.dropped === 1 ? '' : 's'} throttled at the source._\n`,
      );
    }

    return new vscode.Hover(markdown, document.lineAt(position.line).range);
  }
}

function header(record: LineRecord): string {
  const latest = record.values[0];
  const kind = latest.uncaught ? `$(error) ${latest.uncaught}` : `console.${latest.level}`;
  const hits = record.hits > 1 ? ` · ${record.hits} calls` : '';
  return `**${kind}**${hits} · ${ago(record.lastTs)}`;
}

function ago(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 2) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function escapeInline(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').replace(/`/g, 'ˋ');
}
