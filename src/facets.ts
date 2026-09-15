/**
 * Grouping tags live inside a task's `detail` string:
 *
 *   "detail": "@env:staging @tenant:acme @service:web-api Ship the API"
 *
 * `@` introduces a grouping level and the order the tags are written is the hierarchy,
 * so the line above nests staging > acme > web-api. The key before the colon
 * names the level for whoever is editing the file - it is documentation, not
 * configuration, and nothing has to be declared anywhere else for the tree to appear.
 *
 * `detail` is used because it is the only free-form string the tasks.json schema accepts
 * on every task type, so annotating a task never produces a schema squiggle and never
 * changes how VS Code itself runs the task.
 */

/** One grouping level. `values` normally holds one entry; `@tenant:a,b` gives two. */
export interface Tag {
    readonly key: string;
    readonly values: readonly string[];
}

export interface ParsedDetail {
    /** In written order - this is the hierarchy, outermost first. */
    readonly tags: readonly Tag[];
    /** `detail` with every tag removed, whitespace-collapsed. May be empty. */
    readonly description: string;
}

const EMPTY: ParsedDetail = { tags: [], description: '' };

/**
 * The value is either a quoted string (so it can contain spaces) or an unquoted run that
 * stops at whitespace - and also at `,`, so `@tenant:acme,globex` reads as two values.
 */
function tagPattern(prefix: string): RegExp {
    const p = escapeRegExp(prefix);
    return new RegExp(`${p}([A-Za-z_][A-Za-z0-9_-]*):("[^"]*"|'[^']*'|[^\\s]+)`, 'g');
}

export function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitValues(raw: string): string[] {
    const quoted = /^"(.*)"$|^'(.*)'$/.exec(raw);
    if (quoted) {
        // A quoted value is taken whole - commas inside it are part of the name.
        const inner = quoted[1] ?? quoted[2] ?? '';
        return inner.trim() ? [inner.trim()] : [];
    }
    return raw
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
}

export function parseDetail(detail: string | undefined, prefix = '@'): ParsedDetail {
    if (!detail || !prefix) {
        return detail ? { tags: [], description: detail.trim() } : EMPTY;
    }

    const tags: Tag[] = [];
    const re = tagPattern(prefix);
    let match: RegExpExecArray | null;

    while ((match = re.exec(detail)) !== null) {
        const values = splitValues(match[2]);
        if (values.length > 0) {
            // Repeats are kept as separate levels rather than merged: writing the same
            // key twice is how you nest under it twice, and order is what matters here.
            tags.push({ key: match[1], values });
        }
    }

    const description = detail.replace(tagPattern(prefix), '').replace(/\s+/g, ' ').trim();
    return { tags, description };
}

/** Render tags back into their written form, for writing into `detail`. */
export function formatTags(tags: readonly Tag[], prefix = '@'): string {
    return tags
        .map((tag) => `${prefix}${tag.key}:${tag.values.map(quoteIfNeeded).join(',')}`)
        .join(' ');
}

function quoteIfNeeded(value: string): string {
    return /[\s,]/.test(value) ? `"${value}"` : value;
}

/** Compose a `detail` string from tags plus any trailing prose. */
export function composeDetail(tags: readonly Tag[], description: string, prefix = '@'): string {
    return [formatTags(tags, prefix), description.trim()].filter((s) => s.length > 0).join(' ');
}

/** Identity of one group node: key and value together, so `env:staging` is its own node. */
export function tagId(key: string, value: string): string {
    return `${key}:${value}`;
}

/** First value written for `key`, if the task has that level at all. */
export function valueOf(tags: readonly Tag[], key: string): string | undefined {
    return tags.find((tag) => tag.key === key)?.values[0];
}

/** Every distinct tag key across a set of tasks, in first-seen order. */
export function collectTagKeys(taskTags: readonly (readonly Tag[])[]): string[] {
    const seen: string[] = [];
    for (const tags of taskTags) {
        for (const tag of tags) {
            if (!seen.includes(tag.key)) {
                seen.push(tag.key);
            }
        }
    }
    return seen;
}
