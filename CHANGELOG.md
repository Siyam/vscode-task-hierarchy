# Changelog

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
- **Labels are shown exactly as written.** The tags decide where a task sits, not what it
  is called. `taskHierarchy.shortenLabels` will trim the parts a task's levels already
  state, and leaves a label in full if trimming it would stop telling two tasks apart.
- **Annotate Tasks from Labels…** derives tags from label conventions you already use,
  as one reviewed, undoable edit.

Running a task is always VS Code executing that one task. Nothing here resolves
`dependsOn`, sequences steps or decides what runs next.
