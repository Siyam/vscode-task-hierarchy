# Configuration

Everything beyond the basics. The [README](../README.md) covers getting started.

## Where tasks come from

VS Code itself only reads `.vscode/tasks.json` **at each workspace folder root**. Open a
folder of checkouts — `~/Documents/GitHub`, say — and every project's tasks are invisible
to it, including to the task Quick Pick.

This extension searches the whole workspace instead (`taskHierarchy.discoveryInclude`,
default `**/.vscode/tasks.json`) and shows every task it finds. A task from a file VS Code
did not load is built and launched by the extension itself: shell and process execution,
args, `cwd`, `env`, `osx`/`windows`/`linux` overrides, `isBackground`, named problem
matchers, `dependsOn` ordering, and `npm` script tasks all carry over. `${workspaceFolder}`
resolves to the folder holding the `.vscode` directory, which is what a tasks.json written
for that project meant by it.

Three things need VS Code itself and cannot be reproduced: `${command:...}` and
`${input:...}` variables, inline (non-named) problem matchers, and provider task types
other than `npm` (`dotnet`, `gulp`, `typescript`, …). Tasks blocked by the first or third
are still listed, marked with a warning icon, and offer **Add Project Folder to Workspace**
— which makes VS Code load that tasks.json natively and take the tasks over.

When more than one project folder has tasks, a folder level is added at the top of the
tree (`taskHierarchy.showProjectFolders`).

If the tree is empty or missing something, **Show Diagnostics** prints exactly what was
searched, which files were found, how many tasks each held, and why any were skipped.
## How grouping works

`@` introduces a grouping level, and **the order the tags are written is the hierarchy**:

```jsonc
{
  "label": "publish: web-api (staging)",
  "type": "process",
  "command": "dotnet",
  "detail": "@env:staging @tenant:acme @service:web-api @action:publish"
}
```

That nests **staging › acme › web-api › publish**. Swap two tags and the tree
re-nests; add a fifth tag and it goes five deep. There is no setting for any of this —
`tasks.json` is the only place the hierarchy is written down.

The name before the colon is **documentation for whoever is editing the file**, not
configuration. Nothing has to declare that `env` exists. It labels the level so the line
reads clearly a year later, it shows in the tooltip, and it can carry an icon — but the
tree is built from position, not from the name.

Two names are still distinct even when their values match: `@env:acme` and
`@tenant:acme` are different levels and will not merge.

`detail` is used because it is the only free-form string the `tasks.json` schema accepts
on every task type. Tagging a task produces no schema warning and changes nothing about
how VS Code itself runs it. Any text left after the tags stays as the task's description
and is shown beside it in the tree.

### Rules the tree follows

- **A task with fewer tags becomes a leaf where its path ends** — that is meaningful, not
  an error. `@env:staging` alone puts the task directly under staging, beside the groups
  its longer-tagged siblings create. Groups sort before tasks at each level.
- **A task with no tags at all** collects in an `Ungrouped` node, listed last.
- **A tag can carry several values.** `@tenant:acme,globex` puts the task under both;
  running the group still starts it only once.
- **Labels are shown exactly as written.** The tags decide where a task sits; they do not
  change what it is called. [Shortening](#shortening-labels) is available but off.
- **Sibling order** is alphabetical. `taskHierarchy.sortTagValues` overrides it per
  level, which is how you get `staging` before `production` rather than the reverse.

### Ragged first levels

Because position is everything, a task with no `@env:` starts its path at whatever its
first tag is. Tag some tasks with an environment and others without, and the root fills
with a mix of environments, tenants and services side by side. That is the model being
faithful, and the fix lives in the file: give the strays an environment too. A rule
`fallback` does it in bulk during annotation — see the example below.
## Tagging tasks you already have

You do not have to hand-edit every task. **Annotate Tasks from Labels…** (view toolbar,
`⋯` menu) runs a set of regexes over your current labels, shows every proposed annotation
as a checklist, and writes the accepted ones into `tasks.json` as one undoable edit you
review before saving. A level a task already declares is never overwritten, so you can
run it, hand-fix a few, and run it again.

**Rule order is the hierarchy.** The first rule becomes the outermost level, so the rule
list is where you decide the shape of the tree for a first pass. After that the tags in
the file are the truth, and reordering them by hand re-nests those tasks.

No rules come with the extension. The levels worth grouping by are particular to each
repo, and guessing them would mostly produce a tree nobody wanted — so the command asks
you to write them, and offers a starting point to copy.

The example below is a real one, for a repo whose labels look like
`publish: web-api (staging)` and `staging:billing-worker`. Note that the `env`
pattern reads environments **positionally** — in brackets, before the leading colon, or
at the end of the label — rather than as bare words, so `kill: web dev server` is
correctly left with no environment:

```jsonc
// .vscode/settings.json
{
  "taskHierarchy.derivationRules": [
    {
      "key": "env",
      "pattern": "[-\\s:(\\[]\\s*(local|staging|stage|prod|production)\\s*[)\\]]?\\s*$|^(local|staging|stage|prod|production)\\s*:",
      "value": "$1$2",
      "map": { "stage": "staging", "prod": "production" },
      // Everything with no environment in its label is local-only. Without this the
      // root mixes environments, tenants and services; with it there are three roots.
      "fallback": "local"
    },
    { "key": "tenant",  "pattern": "\\b(acme|globex)\\b" },
    { "key": "service", "pattern": "\\b(orders-api|orders|web-api|worklist|reports-offline|reports|sync-service|web|all|billing-worker)\\b" },
    { "key": "action",  "pattern": "^\\s*(build|clean|publish|package|deploy|serve|launch|kill|config)\\b" }
  ]
}
```

Order matters inside a single `pattern` too: list `reports-offline` before
`reports`, or the shorter alternative wins and both collapse into one level.

Values are lowercased, so `SyncService` and `sync-service` do not split into two
nodes. Use `map` to fold spelling variants together.

To change one task's grouping afterwards, **Edit Tags…** on its row takes the tag line
directly — or just edit `detail` in `tasks.json`; the tree follows the file.
## Icons

Nothing is themed out of the box — every level starts with a folder icon, because the
extension has no idea what your levels mean. Two settings change that, and both take
[Codicon](https://microsoft.github.io/vscode-codicons/dist/codicon.html) ids (the names
on that page, without the `$(...)` wrapper).

**Per level name** — every node at that level gets the icon:

```jsonc
// .vscode/settings.json
{
  "taskHierarchy.tagIcons": {
    "env": "server-environment",
    "tenant": "organization",
    "service": "package",
    "action": "gear"
  }
}
```

**Per specific value** — overrides the level's icon for one value, which is how the
environment you care about stops looking like the others:

```jsonc
{
  "taskHierarchy.tagValueIcons": {
    "env:production": "flame",
    "env:staging": "beaker",
    "env:local": "vm"
  }
}
```

The key is the whole `name:value` pair, so `env:production` and `tenant:production` can
differ. Resolution runs most specific first: `tagValueIcons[name:value]`, then
`tagIcons[name]`, then a folder.

A few icons are fixed because they carry meaning rather than taxonomy:

| | |
| --- | --- |
| project folder level | `folder-opened` |
| the `Ungrouped` bucket | `question` |
| a task | `terminal` |
| a `dependsOn` aggregate | `list-ordered` |
| a running task | a spinner |
| a task that cannot run here | `warning` |

Sibling **order** is a separate setting — `taskHierarchy.sortTagValues` — since
alphabetical puts `production` before `staging`, which is rarely what you want:

```jsonc
{
  "taskHierarchy.sortTagValues": {
    "env": ["local", "dev", "staging", "production"]
  }
}
```
## Running tasks

| Action | Where |
| --- | --- |
| Run one task | ▶ on the task row |
| Stop one task | ■ on a running task row |
| Run a whole group | ▶ on a group row |
| Stop everything running | ■ in the view toolbar |
| Filter | 🔍 in the view toolbar |
| Change one task's grouping | **Edit Tags…** on its row |
| See what was searched and found | **Show Diagnostics** in the `⋯` menu |

**Run a whole group** collects every task beneath the node and, by default, runs them
**sequentially**, stopping at the first non-zero exit — these groups are usually
pipelines where packaging a failed publish is worse than not packaging at all. You get a
cancellable progress notification, and a prompt offering *Continue Anyway* on a failure.
Background tasks (`"isBackground": true`, e.g. a dev server) are started and stepped over
rather than waited on. Set `taskHierarchy.groupRunMode` to `parallel` to fire them all at
once instead.

Because these trees usually contain deploy and publish tasks, a group run asks for
confirmation and lists what it is about to start. `taskHierarchy.confirmGroupRunThreshold`
sets the size that triggers the prompt (`-1` disables it).

For the same reason a plain click on a task **does not run it** — it opens the task's
declaration in `tasks.json`. Set `taskHierarchy.clickAction` to `run` if you would rather
it ran, or `none` for neither.
## Who runs a task

Starting a task from the tree is always VS Code executing that one task. This extension
resolves no `dependsOn`, sequences nothing and decides nothing about what runs next — a
task that only lists other tasks is handed to VS Code exactly as written, and VS Code
runs its steps with its own semantics: names resolved across the whole workspace, tasks
other extensions provide, the object form of `dependsOn`, and waiting for a background
step to signal it is ready.

The one exception is **Run All Tasks in Group**, which runs the tasks under a node you
clicked. That is a set you chose in the tree, not an interpretation of anything in
`tasks.json`.

A task VS Code has not loaded, and that only lists other tasks to run, cannot be started
from here — running it would mean resolving and sequencing those steps, which is exactly
what this does not do. It is shown with a warning and an **Add Project Folder to
Workspace** action, after which VS Code loads the file and runs it properly. Its
individual steps still run on their own.

### Shortening labels

`taskHierarchy.shortenLabels` removes from a label the parts its levels already state, so
`publish: api (staging)` reads as `publish` under **staging › api**. It is off by
default: the label in `tasks.json` is what you wrote, and quietly rewriting it is
surprising.

It also is not always an improvement. `npm: test` under a level named `test` shortens to
`npm` — the informative half removed and the generic half kept. Any label that would no
longer tell two tasks apart is left in full, so turning this on cannot make the tree
ambiguous, only occasionally blunt.

## Run status

Once a task has run, the tree shows what happened beside it: how long it took and how
long ago, and a red ✗ if it exited non-zero. A failure also raises a notification naming
the task — turn that off with `taskHierarchy.notifyOnFailure` — and is written to the
**Task Hierarchy** output channel either way.

Starting a run clears what the previous one left behind, for that task and — when it
only lists other tasks — for the steps it is about to run, so the marks on screen always
belong to the run in front of you.

Stopping a group stops the group: the run is cancelled, so nothing after the task being
terminated starts. Stopping a task that only lists other tasks terminates it as well as
its running step, since that is what VS Code drives the sequence from.

Clicking a task shows its last run: status, exit code, when it started, how long it took,
and the command that ran. A task that has never run opens its declaration instead.
`taskHierarchy.clickAction` changes that.

A task that only lists other tasks has no process, so VS Code reports nothing about it.
Its status is inferred from the steps it names — started when it is launched, finished
when those have finished. That can be wrong at the edges, such as two of them sharing a
step, and an inaccurate badge is the right thing to risk rather than interfering with how
the tasks run.

**What is not there: the task's own output.** VS Code does not expose a task's stdout or
stderr to extensions, so the error text itself stays in the task's terminal and cannot be
repeated here. The details view says so and points at the terminal rather than pretending
otherwise.

History is kept per workspace and survives a reload. **Clear Run History** in the `...`
menu empties it.

## Filtering

The filter takes space-separated terms and requires all of them. Each is matched
case-insensitively against the label, the description and both halves of every facet, so
`staging web` and `tenant:globex publish` both work. Matching tasks are shown with
their ancestor groups expanded.
## Settings

Nothing below has to be set for the tree to work — the tags in `tasks.json` are enough.

| Setting | | |
| --- | --- | --- |
| `taskHierarchy.tagPrefix` | `@` | Character introducing a tag in `detail` |
| `taskHierarchy.tagIcons` | *empty* | Codicon per level name — see [Icons](#icons) |
| `taskHierarchy.tagValueIcons` | *empty* | Codicon for one `name:value`, overriding the level — see [Icons](#icons) |
| `taskHierarchy.sortTagValues` | *empty* | Sibling order within a level — see [Icons](#icons) |
| `taskHierarchy.derivationRules` | *empty* | Regexes for bulk annotation; rule order is the hierarchy |
| `taskHierarchy.shortenLabels` | `false` | Strip ancestor tag values from leaf labels |
| `taskHierarchy.ungroupedLabel` | `Ungrouped` | Name of the bucket for untagged tasks |
| `taskHierarchy.hideUnannotatedTasks` | `false` | Omit untagged tasks entirely |
| `taskHierarchy.collapseSingleChildGroups` | `false` | Merge single-child chains into `a › b` |
| `taskHierarchy.showProjectFolders` | `auto` | Top-level node per project folder |
| `taskHierarchy.clickAction` | `runDetails` | What a single click does |
| `taskHierarchy.notifyOnFailure` | `true` | Notify when a task exits non-zero |
| `taskHierarchy.groupRunMode` | `sequential` | How a group run executes |
| `taskHierarchy.confirmGroupRunThreshold` | `1` | Confirm above this many tasks; `-1` never |
| `taskHierarchy.discoveryInclude` | `**/.vscode/tasks.json` | Glob for finding task files |
| `taskHierarchy.discoveryExclude` | node_modules, bin, obj, … | Glob excluded from the search |
| `taskHierarchy.discoveryMaxFiles` | `200` | Cap on files searched |

All of these are `resource`-scoped, so they belong in a committed
`.vscode/settings.json` and travel with the repo.
## Scope

The tree covers every discovered `tasks.json` plus every task
`vscode.tasks.fetchTasks()` returns — so extension-contributed tasks (npm, dotnet, …)
appear too. Facets come from `detail` either way, but only tasks declared in a
`tasks.json` file can be annotated or revealed, since there is no file to write to for
the others. Tasks marked `"hide": true` are omitted, matching the task Quick Pick.

Because a folder of checkouts can hold a lot of tasks, **Annotate Tasks from Labels…**
asks which project folder to work on before proposing anything, rather than editing
every repo at once.

Facets in a multi-root `.code-workspace` file's own `tasks` section are read from the
task's `detail` at runtime, but such tasks cannot be annotated in bulk or revealed.
