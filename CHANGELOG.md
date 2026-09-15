# Changelog

## 0.6.1

- **The view says what it is doing while it looks for tasks.** Searching the workspace
  takes a moment, and an empty tree meanwhile is indistinguishable from a workspace with
  no tasks — so the welcome view claimed there were none before anything had been
  searched. It now shows a progress bar and "Looking for tasks…", and the empty state
  only appears once a search has actually finished. Subsequent refreshes stay quiet.
- **Fixed: a finished composite showed neither a tick nor a cross.** VS Code raises start
  and end for a composite but reports no exit code, having no process — and recording
  that as a generic "finished, outcome unknown" overwrote the result its steps had
  already established. Its own end event now settles the outcome the steps produced,
  which is also a better signal than waiting for the steps to go quiet.

## 0.6.0

**This extension no longer takes part in running tasks.** Starting one from the tree is
now always VS Code executing that single task, and nothing here resolves `dependsOn`,
sequences steps or decides what runs next.

0.5.2 through 0.5.5 had it resolving a composite's steps and running them, to learn
something VS Code does not report. That was a second task engine, and it disagreed with
the real one in ways that all failed silently toward "success":

- `dependsOn` was resolved only within the same `tasks.json`, so a reference to a task in
  another workspace folder, or to one another extension provides such as `npm: build`,
  found nothing — and the composite reported success having run fewer steps than written.
- The object form of `dependsOn` was dropped entirely, so a composite using it ran nothing
  and still reported success.
- A background step was stepped over instead of waited on, so "start the server, then run
  the tests" raced.

A composite is handed to VS Code exactly as written now, and all of that is correct
because VS Code does it. Its status is inferred from the steps it names — an inaccurate
badge at the edges is the right thing to risk instead.

- A composite in a `tasks.json` VS Code has not loaded cannot be started from here; it is
  shown with a warning and the **Add Project Folder to Workspace** action that makes VS
  Code load it. Its individual steps still run on their own.
- **Run All Tasks in Group** is unchanged. That runs a set you picked in the tree, not an
  interpretation of anything in `tasks.json`.

## 0.5.5

- **Fixed: a parallel group reported success the moment it started.** `executeTask`
  resolves when a task *starts*, not when it finishes, so awaiting it and calling the
  group done recorded a zero-duration success before anything had happened — and since
  0.5.4 made parallel the default, that was most composites. Each step is now waited on.
- **Fixed: a step that could not be run counted as success.** A blocked step — an
  unsupported provider type, or an unresolvable variable — returned no exit code, and
  "no exit code" was read as "nothing went wrong". It fails its group now.

## 0.5.4

Two defects in how composite tasks are run, both introduced in 0.5.2.

- **Fixed: a dependency cycle recursed without end.** The visited set guarding
  `dependsOn` resolution was created fresh at every level, so a task naming another that
  names it back would recurse forever, starting real processes the whole way down. One
  set now covers an entire run.
- **A task that several steps depend on is started once**, not once per path to it,
  which follows from the same change.
- **Fixed: `dependsOrder` defaulted to `sequence`.** VS Code's documented default is
  `parallel`; only `"dependsOrder": "sequence"` opts out. Running a file's steps in a
  different order than VS Code would have is a silent change of meaning, so the default
  now matches.

## 0.5.3

- **Fixed: composite tasks still showed no status when the project is opened directly.**
  0.5.2 recognised a composite by the extension having synthesized it, which only holds
  when the project is opened from a parent folder. Open the project itself and VS Code
  loads its tasks.json, so the entry carries a real Task and the check never fired — no
  spinner while running, no record afterwards. A composite is now recognised by having no
  execution, which is true however it was loaded.
- `dependsOn` is read from tasks.json for every task rather than only for synthesized
  ones, since a VS Code Task does not carry it — a natively-loaded composite otherwise
  looked like an ordinary task with nothing to run.
- A native task that has its own command still leaves its `dependsOn` to VS Code, so
  dependencies are not run twice.

## 0.5.2

- **Fixed: `dependsOn` aggregates never showed a run status.** A task that only lists
  dependencies has no command, so no VS Code task lifecycle event ever fires for it and
  nothing recorded that it ran — while the tasks it runs recorded theirs normally. Every
  `staging:*` / `production:*` task that fans out to clean → publish → package was
  affected; the ones that run a single command were not. An aggregate now records its own
  run, taking its outcome from whether its steps succeeded, and reports a failure the
  same way a task with an exit code does.
- A failed aggregate reads as `failed` rather than `exit undefined`, since there is no
  process to report a code.

## 0.5.1

- **Fixed: run status never appeared.** History was keyed by the `vscode.Task` object
  from the lifecycle event, but the task VS Code hands back is not the one `fetchTasks()`
  returned — so every run was recorded under a key the tree never looked up, and the rows
  never changed. It is keyed by the tree entry now, resolved from the task by identity,
  then by folder and name, then by name alone.
- Tasks started outside the tree — the build shortcut, the task Quick Pick — are matched
  to their entry too, so their status shows as well.
- **Show Diagnostics** lists which tasks have a recorded run, with status and timing.

## 0.5.0

The tree now shows what happened, not just what exists.

- **Run status per task.** How long it took and how long ago, beside the task. A red ✗
  marks one that exited non-zero, a green check one that succeeded.
- **Failures are reported.** A task exiting non-zero raises a notification naming it,
  with buttons to open the details or the terminal, and is logged to the output channel.
  Previously a task started from the tree could fail silently once its terminal scrolled
  away. `taskHierarchy.notifyOnFailure` turns the notification off.
- **Clicking a task shows its last run** — status, exit code, start time, duration and
  the command that ran. A task that has never run opens its declaration, as before.
  VS Code does not expose task output to extensions, so the error text itself stays in
  the task's terminal; the details view says so rather than pretending otherwise.
- History is kept per workspace and survives a reload. A run left unfinished by a closed
  window is not shown as still running. **Clear Run History** empties it.
- Stopping a task is recorded as stopped, not as a failure, so killing a dev server does
  not leave an error marker on it.

## 0.4.0

First release prepared for the Marketplace.

- **Marketplace icon.** A 128x128 PNG, with its vector source kept in the repo and out of
  the package. The activity-bar icon stays a separate monochrome SVG, because VS Code
  tints that one for its active and inactive states.
- **Declared Workspace Trust as required.** The extension discovers tasks.json files
  anywhere in the workspace and can run the commands they declare, including from files
  VS Code itself never loaded — which is exactly the risk Workspace Trust exists for. It
  now stays disabled in an untrusted workspace rather than being able to run anything.
- **Declared no virtual-workspace support**, since running a task needs a real filesystem
  and a shell, and `extensionKind: workspace` so discovery and execution happen on the
  remote side of a remote or container session rather than the local UI host.
- Listing metadata: gallery banner, pricing, homepage and issue links.
- Fixed: `npm run install-local` matched old installs by a hardcoded publisher id, so
  after the publisher changed it stopped cleaning up stale versions — which then linger
  and can shadow the new one. It derives the id from `package.json` now.
- LICENSE holder matches the publisher.

## 0.3.2

- **Fixed: label shortening ate fragments of hyphenated words.** Stripping an ancestor's
  value used a `\b` boundary, and `-` counts as one, so a level named `install` turned
  `npm: install-local` into `npm-local` and a level named `types` turned `npm: check-types`
  into `npm: check`. Only whole tokens are removed now; a hyphenated value still matches
  when all of it is present.
- The project's own `.vscode/tasks.json` now covers every npm script and is tagged
  develop / verify / ship, so the repo is a working example of the tree it produces.

## 0.3.1

- **No opinionated defaults.** `tagIcons`, `tagValueIcons`, `sortTagValues` and
  `derivationRules` now ship empty. `env`, `tenant`, `service` and `staging`/`production`
  are one repo's vocabulary, not everyone's, and seeding them described a stranger's
  tasks in terms they never chose. Only structural settings — the `@` prefix, the
  discovery glob, click and run behaviour — keep a value, because the extension cannot
  work without one.
- **Annotate Tasks from Labels…** now explains what rules are when none are set, and
  offers to open settings or a worked example to copy, instead of refusing.
- A manifest test asserts no shipped default names a level or value, so this cannot
  creep back.

## 0.3.0

**The tag order in `tasks.json` is now the hierarchy.** `@` introduces a grouping level
and the levels nest in the order they are written, so
`@env:staging @tenant:acme @service:api` means staging › acme › api. The name
before the colon is documentation for whoever edits the file — it labels the level and
can carry an icon, but the tree is built from position, not from the name.

- **Removed `taskHierarchy.groupBy` and the Change Grouping… command.** There is nothing
  left to configure: reordering the tags in the file reorders the tree, and adding a tag
  adds a level. Nesting is unlimited.
- **Rule order is the hierarchy** for `derivationRules`, so the rule list decides the
  shape of the tree on a first annotation pass. Renamed each rule's `facet` to `key`.
- **New `fallback` on a rule.** A task with no match for a level starts its path one
  level in, which puts environments, tenants and services side by side at the root.
  `"fallback": "local"` on the env rule sweeps the strays under one root — on
  sample-project that turns a ragged 11-node root into `local`, `staging`, `production`.
- Renamed to match: `facetPrefix` → `tagPrefix`, `facetIcons` → `tagIcons`,
  `facetValueIcons` → `tagValueIcons`, `sortFacetValues` → `sortTagValues`,
  **Edit Facets…** → **Edit Tags…**.
- A tag written twice is two levels rather than one merged level, since writing a name
  twice is how you nest under it twice.

## 0.2.1

- **Fixed: the extension never activated.** esbuild resolved jsonc-parser's UMD entry,
  whose indirect `require()` calls it cannot follow, so they survived into the bundle and
  threw `Cannot find module './impl/format'` at load. Every command was reported as "not
  found" and the tree was always empty — in 0.1.0 as well. Dependencies now resolve to
  their ESM builds.
- Added a smoke test that loads the built bundle with `vscode` stubbed, asserts nothing
  is left as an unresolvable runtime require, and calls `activate()`. It runs on
  `npm test` and again against the minified bundle at package time, so a bundling fault
  cannot ship. The unit tests run against tsc output and could never have caught this.

## 0.2.0

Tasks are now found anywhere in the workspace, not only at a workspace folder root.

- **Workspace-wide discovery.** Every `.vscode/tasks.json` under the open folders is
  found and shown. Opening a folder of checkouts now lists each project's tasks, which
  VS Code itself cannot do — it only reads the file at a folder root.
- **Tasks VS Code never loaded are runnable.** Shell and process execution, args, `cwd`,
  `env`, OS-specific overrides, `isBackground`, named problem matchers, `dependsOn`
  ordering and `npm` script tasks are all reproduced, with `${workspaceFolder}` resolving
  to the folder holding the `.vscode` directory.
- **Blocked tasks say so instead of vanishing.** A task needing `${command:...}`,
  `${input:...}` or a non-npm provider type is listed with a warning and an
  **Add Project Folder to Workspace** action that hands it back to VS Code.
- **Project folder level** in the tree when more than one project has tasks.
- **Show Diagnostics** prints what was searched, what was found and what was skipped.
- **Annotate Tasks from Labels…** asks which project folder to work on first.
- Fixed: the empty-view link opened the *user-level* tasks file in Application Support
  instead of anything in the workspace. It now opens a discovered file, or offers to
  create one in a workspace folder.

## 0.1.0

Initial release.

- Faceted tree view of every task VS Code knows about, grouped by `@key:value` tags
  written into each task's `detail` field.
- Pivotable grouping: reorder the nesting facets from the view toolbar.
- Run and stop individual tasks; run a whole group sequentially or in parallel.
- Filter across labels, descriptions and facet values.
- `Annotate Tasks from Labels…` bulk-derives facets from existing label conventions.
