# Development

```sh
npm install
npm run watch          # esbuild, rebuilds on save
npm test               # unit tests, plus a load test of the built bundle
npm run lint
npm run install-local  # package and install into the local VS Code, then reload the window
npm run package        # vsce package -> .vsix only
```

`npm test` includes `test/bundle.smoke.js`, which loads `dist/extension.js` with `vscode`
stubbed and calls `activate()`. The unit tests import from `src/` through tsc's output and
never touch the bundle, so only this catches a bundling fault — and one did ship: esbuild
resolved jsonc-parser's UMD entry and left `require('./impl/format')` in the output, so the
extension threw on load and never activated. Packaging runs the same test against the
minified bundle.

`F5` launches an Extension Development Host. The second launch configuration,
**Run Extension in sample-project**, opens a sibling checkout so you can test against
a real `tasks.json`.

The grouping (`src/tree.ts`, a trie over each task's tag sequence), tag parsing
(`src/facets.ts`) and label derivation (`src/derive.ts`) import nothing from `vscode`,
which is what makes them unit-testable without an extension host. `test/workspaces.test.js`
drives discovery against real fixture directories through an fs-backed stub.

Releasing and publishing are covered in [PUBLISHING.md](PUBLISHING.md).
