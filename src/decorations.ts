import * as vscode from 'vscode';
import { LogStore, fileKey } from './store';
import { previewArgs } from './render';
import { LogLevel } from './protocol';

interface Settings {
  maxInlineLength: number;
  showHitCount: boolean;
}

/**
 * Paints the most recent value for each line at the end of that line.
 *
 * One decoration *type* per severity (colours are baked into the type), with
 * the text supplied per range via renderOptions.
 */
export class DecorationManager implements vscode.Disposable {
  private types: Record<LogLevel, vscode.TextEditorDecorationType>;
  private pending?: NodeJS.Timeout;

  constructor(private store: LogStore, private settings: Settings) {
    this.types = {
      log: makeType('editorCodeLens.foreground'),
      info: makeType('editorCodeLens.foreground'),
      debug: makeType('editorCodeLens.foreground'),
      warn: makeType('editorWarning.foreground'),
      error: makeType('editorError.foreground'),
    };
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
    this.refreshAll();
  }

  /** Redraw only the editors showing one of `changedKeys`. */
  scheduleRefresh(changedKeys?: Set<string>): void {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      for (const editor of vscode.window.visibleTextEditors) {
        if (changedKeys && !changedKeys.has(fileKey(editor.document.uri.fsPath))) continue;
        this.apply(editor);
      }
    }, 40);
  }

  refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) this.apply(editor);
  }

  clearAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      for (const type of Object.values(this.types)) editor.setDecorations(type, []);
    }
  }

  private apply(editor: vscode.TextEditor): void {
    const lines = this.store.linesFor(editor.document.uri.fsPath);
    const buckets: Record<LogLevel, vscode.DecorationOptions[]> = {
      log: [],
      info: [],
      debug: [],
      warn: [],
      error: [],
    };

    if (lines) {
      for (const record of lines.values()) {
        const index = record.line - 1;
        if (index < 0 || index >= editor.document.lineCount) continue;

        const latest = record.values[0];
        if (!latest) continue;

        const text = this.inlineText(previewArgs(latest.args), record.hits, record.dropped);
        const end = editor.document.lineAt(index).range.end;

        buckets[record.level].push({
          range: new vscode.Range(end, end),
          renderOptions: { after: { contentText: text } },
        });
      }
    }

    for (const level of Object.keys(buckets) as LogLevel[]) {
      editor.setDecorations(this.types[level], buckets[level]);
    }
  }

  private inlineText(preview: string, hits: number, dropped: number): string {
    let text = preview.replace(/\s*\n\s*/g, ' ').trim();
    const limit = Math.max(20, this.settings.maxInlineLength);
    if (text.length > limit) text = text.slice(0, limit - 1) + '…';

    if (this.settings.showHitCount && hits > 1) {
      text += dropped > 0 ? `  ×${hits}+ (throttled)` : `  ×${hits}`;
    }
    return '  ' + text;
  }

  dispose(): void {
    if (this.pending) clearTimeout(this.pending);
    for (const type of Object.values(this.types)) type.dispose();
  }
}

function makeType(themeColor: string): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor(themeColor),
      fontStyle: 'italic',
      margin: '0 0 0 1.5rem',
    },
    // Values belong to the line, not to whatever the user types next.
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
}
