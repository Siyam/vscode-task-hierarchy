# Changelog

## 1.0.1

- **Task labels are no longer rewritten by default.** Removing from a label the parts its
  levels already state sounds tidy and often is not: `npm: test`, `npm: lint` and
  `npm: package` under levels named test, lint and package all became `npm` — the
  informative half stripped, the generic half kept. The tags decide where a task sits;
  they no longer change what it is called. `taskHierarchy.shortenLabels` turns it back on.
- When shortening is on, a label that would no longer tell two tasks apart is left in
  full, so it can no longer make the tree ambiguous.

## 1.0.0

First release.

- **A tree of your tasks**, grouped by `@name:value` tags written into each task's
  `detail` field. The order the tags are written is the nesting, so `tasks.json` is the
  only place the shape of the tree is recorded and there is no setting to keep in sync
  with it. Depth is whatever you write.
- **Tasks are found anywhere in the workspace**, not only at a workspace folder root —
  so opening a folder of checkouts shows every project's tasks, which VS Code itself
  cannot do. Tasks from a file VS Code did not load are rebuilt well enough to run, and
  anything that cannot be reproduced faithfully is listed with the reason rather than
  approximated.
- **Run a task, or every task under a node**, sequentially or in parallel, with a
  confirmation before starting a batch.
- **Each task shows its last run** — how long it took, how long ago, and a mark if it
  failed. Clicking one shows the detail; a failure raises a notification naming the task.
- **Filter** across labels, descriptions and tags.
- **Annotate Tasks from Labels…** derives tags from label conventions you already use,
  as one reviewed, undoable edit.

Running a task is always VS Code executing that one task. Nothing here resolves
`dependsOn`, sequences steps or decides what runs next.
