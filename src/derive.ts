import { Tag, parseDetail } from './facets';

/**
 * Deriving grouping tags from the label conventions a repo already uses, so an existing
 * tasks.json can be annotated in one pass instead of by hand. Kept free of the vscode API
 * so the rules can be unit-tested directly.
 *
 * Rules are applied in the order they are declared, and that order becomes the tag order
 * - which is the tree's nesting order. So `derivationRules` reading env, then tenant,
 * then service produces `@env:… @tenant:… @service:…` and a tree nested the same way.
 */

export interface DerivationRule {
    /** Level name written before the colon. Documentation for the reader, not config. */
    readonly key: string;
    readonly pattern: string;
    /** Replacement template; `$1` etc. refer to capture groups. Defaults to `$1`. */
    readonly value?: string;
    /** Canonicalises the extracted value, e.g. `prod` -> `production`. Keys are lowercased. */
    readonly map?: Readonly<Record<string, string>>;
    /** Match case-sensitively. Off by default. */
    readonly caseSensitive?: boolean;
    /**
     * Value to use when the pattern matches nothing. Without it a task that has no
     * environment simply starts its path one level in, which puts envs, tenants and
     * services side by side at the root. Giving the level a fallback keeps the first
     * level uniform: `{ key: "env", fallback: "local" }` sweeps the strays under `local`.
     */
    readonly fallback?: string;
}

/** Apply derivation rules to a label, returning tags in rule order. */
export function deriveTags(label: string, rules: readonly DerivationRule[]): Tag[] {
    const tags: Tag[] = [];

    for (const rule of rules) {
        let regex: RegExp;
        try {
            regex = new RegExp(rule.pattern, rule.caseSensitive ? 'g' : 'gi');
        } catch {
            continue; // A malformed user-supplied pattern skips its rule, not the whole run.
        }

        const values: string[] = [];
        for (const match of label.matchAll(regex)) {
            const raw = expand(rule.value ?? '$1', match).trim();
            if (!raw) {
                continue;
            }
            const value = rule.map?.[raw.toLowerCase()] ?? raw.toLowerCase();
            if (!values.includes(value)) {
                values.push(value);
            }
        }

        if (values.length > 0) {
            tags.push({ key: rule.key, values });
        } else if (rule.fallback) {
            tags.push({ key: rule.key, values: [rule.fallback.toLowerCase()] });
        }
    }
    return tags;
}

function expand(template: string, match: RegExpMatchArray): string {
    return template.replace(/\$(\d)/g, (_, digit: string) => match[Number(digit)] ?? '');
}

/**
 * The tags a rule set would *add* to a task. A key the task already carries is left
 * alone, so re-running after hand-correcting a few tasks is safe.
 */
export function tagsToAdd(
    label: string,
    existing: readonly Tag[],
    rules: readonly DerivationRule[]
): Tag[] {
    const present = new Set(existing.map((tag) => tag.key));
    return deriveTags(label, rules).filter((tag) => !present.has(tag.key));
}

/**
 * Existing tags keep their written order - the author's chosen hierarchy is never
 * rearranged - and newly derived ones follow in rule order. For a task with no tags yet,
 * which is the whole point of a first annotation pass, that is simply rule order.
 */
export function mergeTags(existing: readonly Tag[], added: readonly Tag[]): Tag[] {
    return [...existing, ...added];
}

/** Validate a user-typed tag string, returning an error message or undefined. */
export function validateTagText(text: string, prefix: string): string | undefined {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
        return undefined; // Clearing every tag is a legitimate edit.
    }
    const { tags, description } = parseDetail(trimmed, prefix);
    if (tags.length === 0) {
        return `No tags found. Write them as ${prefix}name:value, e.g. ${prefix}env:staging`;
    }
    if (description.length > 0) {
        return `Not a tag: "${description}"`;
    }
    return undefined;
}
