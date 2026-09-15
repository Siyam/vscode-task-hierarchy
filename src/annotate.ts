import * as vscode from 'vscode';
import * as jsonc from 'jsonc-parser';
import { Tag, composeDetail, formatTags } from './facets';
import { DerivationRule, tagsToAdd, mergeTags } from './derive';
import { TaskEntry } from './taskSource';

/**
 * Reads and writes the `detail` string of tasks in tasks.json.
 *
 * Edits go through a WorkspaceEdit rather than a raw file write so they land in the
 * user's undo stack, respect an already-open unsaved buffer, and leave the file dirty
 * for the user to review before saving.
 */

export interface Proposal {
    readonly entry: TaskEntry;
    /** Only the levels the rules added; keys the task already has are never touched. */
    readonly added: readonly Tag[];
    readonly newDetail: string;
}

/** Build the set of annotations the rules would add across every editable task. */
export function buildProposals(
    entries: readonly TaskEntry[],
    rules: readonly DerivationRule[],
    prefix: string
): Proposal[] {
    const proposals: Proposal[] = [];

    for (const entry of entries) {
        // Tasks contributed by an extension (npm, dotnet, ...) have no tasks.json entry
        // for us to write a `detail` into.
        if (!entry.definition) {
            continue;
        }

        const added = tagsToAdd(entry.label, entry.tags, rules);
        if (added.length === 0) {
            continue;
        }

        proposals.push({
            entry,
            added,
            newDetail: composeDetail(mergeTags(entry.tags, added), entry.description, prefix),
        });
    }
    return proposals;
}

/** The current tags of a task rendered as an editable string. */
export function tagsAsText(entry: TaskEntry, prefix: string): string {
    return formatTags(entry.tags, prefix);
}

export interface DetailUpdate {
    readonly uri: vscode.Uri;
    readonly label: string;
    readonly detail: string;
}

/**
 * Write new `detail` values into tasks.json, grouped per file so each file takes one
 * edit and therefore one undo step.
 */
export async function writeDetails(updates: readonly DetailUpdate[]): Promise<number> {
    const byFile = new Map<string, { uri: vscode.Uri; items: DetailUpdate[] }>();
    for (const update of updates) {
        const key = update.uri.toString();
        const bucket = byFile.get(key) ?? { uri: update.uri, items: [] };
        bucket.items.push(update);
        byFile.set(key, bucket);
    }

    const edit = new vscode.WorkspaceEdit();
    let written = 0;

    for (const { uri, items } of byFile.values()) {
        const document = await vscode.workspace.openTextDocument(uri);
        const original = document.getText();
        let text = original;

        for (const item of items) {
            // Re-resolving the index against the running text after every edit keeps the
            // batch correct even though earlier edits shift later offsets.
            const index = findTaskIndex(text, item.label);
            if (index === undefined) {
                continue;
            }
            const edits = jsonc.modify(text, ['tasks', index, 'detail'], item.detail, {
                formattingOptions: formattingOptionsFor(document),
            });
            text = jsonc.applyEdits(text, edits);
            written++;
        }

        if (text !== original) {
            const whole = new vscode.Range(
                document.positionAt(0),
                document.positionAt(original.length)
            );
            edit.replace(uri, whole, text);
        }
    }

    if (written > 0 && !(await vscode.workspace.applyEdit(edit))) {
        throw new Error('VS Code rejected the edit to tasks.json.');
    }
    return written;
}

function formattingOptionsFor(document: vscode.TextDocument): jsonc.FormattingOptions {
    // Match whatever the file already uses, so annotating does not reindent a hand-tuned
    // tasks.json and turn a one-property change into a whole-file diff.
    const detected = detectIndent(document.getText());
    return {
        tabSize: detected.tabSize ?? 4,
        insertSpaces: detected.insertSpaces ?? true,
        eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
    };
}

export function detectIndent(text: string): { tabSize?: number; insertSpaces?: boolean } {
    const match = /\n([\t ]+)\S/.exec(text);
    if (!match) {
        return {};
    }
    return match[1].startsWith('\t')
        ? { insertSpaces: false, tabSize: 4 }
        : { insertSpaces: true, tabSize: match[1].length };
}

function findTaskIndex(text: string, label: string): number | undefined {
    const root = jsonc.parseTree(text);
    const tasks = root && jsonc.findNodeAtLocation(root, ['tasks']);
    if (!tasks?.children) {
        return undefined;
    }
    const index = tasks.children.findIndex((node) => {
        const value = jsonc.getNodeValue(node) as { label?: unknown } | undefined;
        return value?.label === label;
    });
    return index === -1 ? undefined : index;
}
