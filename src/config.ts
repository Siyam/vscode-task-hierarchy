import * as vscode from 'vscode';
import { BuildOptions } from './tree';

export const SECTION = 'taskHierarchy';

export interface Settings extends BuildOptions {
    readonly tagPrefix: string;
    readonly tagIcons: Readonly<Record<string, string>>;
    readonly tagValueIcons: Readonly<Record<string, string>>;
    readonly groupRunMode: 'sequential' | 'parallel';
    readonly confirmGroupRunThreshold: number;
    /** Whether to add a top-level node per project folder; `auto` decides from the data. */
    readonly showProjectFolders: 'auto' | 'always' | 'never';
    readonly notifyOnFailure: boolean;
    readonly clickAction: 'runDetails' | 'reveal' | 'run' | 'none';
}

export function readSettings(): Settings {
    const config = vscode.workspace.getConfiguration(SECTION);

    return {
        ungroupedLabel: config.get<string>('ungroupedLabel', 'Ungrouped'),
        shortenLabels: config.get<boolean>('shortenLabels', true),
        collapseSingleChildGroups: config.get<boolean>('collapseSingleChildGroups', false),
        // Decided per refresh from the number of distinct project folders actually found,
        // so the caller overrides this; `auto` cannot be answered from settings alone.
        groupByFolder: false,
        hideUnannotatedTasks: config.get<boolean>('hideUnannotatedTasks', false),
        sortTagValues: config.get<Record<string, string[]>>('sortTagValues', {}),
        tagPrefix: config.get<string>('tagPrefix', '@'),
        tagIcons: config.get<Record<string, string>>('tagIcons', {}),
        tagValueIcons: config.get<Record<string, string>>('tagValueIcons', {}),
        groupRunMode: config.get<'sequential' | 'parallel'>('groupRunMode', 'sequential'),
        confirmGroupRunThreshold: config.get<number>('confirmGroupRunThreshold', 1),
        showProjectFolders: config.get<'auto' | 'always' | 'never'>('showProjectFolders', 'auto'),
        notifyOnFailure: config.get<boolean>('notifyOnFailure', true),
        clickAction: config.get<'runDetails' | 'reveal' | 'run' | 'none'>('clickAction', 'runDetails'),
    };
}

/** Resolve `auto` against the project folders actually discovered. */
export function shouldGroupByFolder(settings: Settings, distinctFolders: number): boolean {
    switch (settings.showProjectFolders) {
        case 'always':
            return true;
        case 'never':
            return false;
        default:
            return distinctFolders > 1;
    }
}

/** Codicon id for a group node: exact `key:value` wins, then the key, then a default. */
export function iconFor(settings: Settings, key: string, value: string | undefined): string {
    if (key === 'folder') {
        return 'folder-opened';
    }
    if (key === '') {
        return 'question'; // the untagged bucket
    }
    if (value !== undefined) {
        const exact = settings.tagValueIcons[`${key}:${value}`];
        if (exact) {
            return exact;
        }
    }
    return settings.tagIcons[key] ?? 'folder';
}
