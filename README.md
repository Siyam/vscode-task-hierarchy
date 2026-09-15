# Task Hierarchy

A GUI for your VS Code tasks. Groups them into a tree so you can find one, and runs them
from the sidebar.

## Getting started

Add a `detail` property to any task in `.vscode/tasks.json`. Each `@name:value` is one
level of the tree, and the order you write them is the order they nest.

```jsonc
{
  "label": "deploy api to production",
  "type": "shell",
  "command": "./deploy.sh",
  "detail": "@env:production @service:api @action:deploy"
}
```

That task lands under **production › api › deploy**. Tag the rest the same way and the
tree builds itself:

```
production
  api
    deploy
    publish
  web
    deploy
staging
  api
    deploy
    publish
  web
    deploy
```

The name before the colon is there so the line still makes sense to whoever reads the
file. Nothing has to be declared anywhere else — add a fourth tag and you get a fourth
level, reorder two tags and that task moves.

![The Task Hierarchy view](https://raw.githubusercontent.com/Siyam/vscode-task-hierarchy/master/media/screenshot.png)

## Running a group

Press ▶ on any group to run every task beneath it, one after another, stopping at the
first failure. So ▶ on **production › api** runs that service's whole pipeline in order,
and ▶ on **production** runs everything for that environment.

▶ on a single task runs just that one. ■ stops it.

## More

- [Configuration](https://github.com/Siyam/vscode-task-hierarchy/blob/master/docs/CONFIGURATION.md)
  — icons per level, sibling ordering, bulk-tagging tasks you already have, and finding
  `tasks.json` files in subfolders.
- [Report a bug or ask for a feature](https://github.com/Siyam/vscode-task-hierarchy/issues)
  — for a bug, **Task Hierarchy: Show Diagnostics** from the Command Palette prints what
  was found and what ran, which is usually the whole answer.

## License

MIT
