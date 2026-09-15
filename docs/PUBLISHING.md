# Publishing

Three stages, deliberately separate. Only the last one can reach a marketplace, and it
cannot run without someone approving it.

| | Trigger | What it does | Credentials |
| --- | --- | --- | --- |
| **CI** | every push and PR | build, lint, test, package, upload the `.vsix` | none |
| **Release** | pushing a `v*` tag | build again, create a **pre-release** GitHub Release with the `.vsix` attached | none |
| **Publish** | manual, with approval | publish that exact `.vsix` to a marketplace | on the `marketplace` environment only |

The answer to "release without publishing" is stages 1 and 2. Both are already live once
the repo has a remote — neither needs a token, so you can push, tag, install and try
builds today without deciding anything about Marketplace auth.

## Trying a build

**From any branch** — CI attaches the `.vsix` to the run:

```sh
gh run download --name "task-hierarchy-vsix-$(git rev-parse HEAD)"
code --install-extension task-hierarchy.vsix --force
```

**From a release:**

```sh
gh release download v1.0.0 --pattern '*.vsix'
code --install-extension vscode-task-hierarchy-1.0.0.vsix --force
```

Reload the window afterwards (`Cmd+Shift+P` → Developer: Reload Window).

## Cutting a release

```sh
npm version patch        # or minor / major - updates package.json and commits
git push && git push --tags
```

The tag must match `package.json`; Release fails loudly if it doesn't, because a
mismatch would otherwise publish a version nobody named. Releases are created as
**pre-release** — promote one in the GitHub UI when you're happy with it.

## Publishing, when you're ready

Actions → **Publish** → Run workflow. Give it the tag, pick the target, and it waits for
approval before doing anything. It downloads the `.vsix` from that release and publishes
those exact bytes, so what ships is what you tested.

Before the first run, in repo Settings → Environments, create an environment named
`marketplace` and add yourself under **Required reviewers**. That approval prompt is the
thing standing between a click and a live release. Credentials live on that environment,
so nothing else in the repo can reach them.

## Marketplace authentication

**Azure DevOps retires global PATs on 1 December 2026.** Two ways forward.

### Microsoft Entra ID with federated credentials — recommended

No stored secret at all: the workflow exchanges its GitHub OIDC token for an Azure
session, and `vsce publish --azure-credential` reuses it. Nothing to rotate, nothing to
leak.

1. **Register an application** in the Entra admin centre (Microsoft Entra ID → App
   registrations → New registration). Single tenant is fine. You do *not* need an Azure
   subscription for this — an app registration is free, which is why this path uses one
   rather than a managed identity.
2. **Add a federated credential** on that app: Certificates & secrets → Federated
   credentials → Add → *GitHub Actions deploying Azure resources*.
   - Organization: `Siyam` (your GitHub account)
   - Repository: `vscode-task-hierarchy`
   - Entity type: **Environment**, name `marketplace`

   The entity binding matters: it means only runs in the approved `marketplace`
   environment can obtain this credential, so a workflow on a fork or a random branch
   cannot.
3. **Add the identity to the publisher.** In the
   [publisher management page](https://marketplace.visualstudio.com/manage/publishers/SMIITSolutionsInc),
   add the application as a member with permission to publish.
4. **Tell the workflow about it.** Repo Settings → Environments → `marketplace` →
   Environment variables (not secrets — these are identifiers, not credentials):
   - `AZURE_CLIENT_ID` — the app registration's Application (client) ID
   - `AZURE_TENANT_ID` — your directory (tenant) ID

The publish workflow picks this path automatically once `AZURE_CLIENT_ID` is set.

> `vsce` also has an `--oidc` flag. It does not work for the Marketplace — the
> trusted-publishing exchange it implies was never shipped. `--azure-credential` behind
> `azure/login` is the path that actually works, which is what the workflow uses.

### Organization-scoped PAT — interim

Faster to set up and still valid after December, as long as it is scoped to your
organization rather than "all accessible organizations".

1. Azure DevOps → User settings → Personal access tokens → New Token.
2. Organization: **your organization**, not *All accessible organizations*.
3. Scopes: **Marketplace → Manage**.
4. Add it as a **secret** named `VSCE_PAT` on the `marketplace` environment.

The workflow uses this only when `AZURE_CLIENT_ID` is absent, so setting up Entra later
switches over with no workflow change.

## Open VSX

VSCodium, **Cursor**, Windsurf and Gitpod cannot reach the Microsoft Marketplace at all —
they install from [Open VSX](https://open-vsx.org). Publishing there is a separate
release, not a mirror, and it is usually the larger reachable audience of the two.

Its tokens are its own and are unaffected by the Azure DevOps PAT retirement.

### First time

1. **Create an Eclipse account** at
   [accounts.eclipse.org](https://accounts.eclipse.org/user/register). Fill in the
   **GitHub Username** field, with the same GitHub account you will use to log in to
   open-vsx.org — the Publisher Agreement is matched on it, and a mismatch is the usual
   reason publishing is refused later.
2. **Sign the Publisher Agreement.** Log in to [open-vsx.org](https://open-vsx.org) with
   GitHub, then Settings → *Log in with Eclipse* → **Show Publisher Agreement** → Agree.
3. **Create an access token.** Avatar → Settings → Access Tokens → Generate New Token.
   The value is shown once and never again.
4. **Publish**, which also creates the namespace if it does not exist:

   ```sh
   OVSX_PAT=<token> npm run publish-openvsx
   ```

   The namespace has to match `publisher` in package.json — `SMIITSolutionsInc`.

Afterwards it lives at
`https://open-vsx.org/extension/SMIITSolutionsInc/vscode-task-hierarchy`.

### Verifying the namespace

Creating a namespace makes you a **contributor** to it, not its verified owner, and
extensions in an unverified namespace carry a *"not a verified publisher"* notice on
their listing. Removing that means claiming ownership, which is a separate request:
[Managing Namespaces](https://github.com/EclipseFdn/open-vsx.org/wiki/Managing-Namespaces).
Worth doing before the extension gets much traffic — the notice reads badly to anyone
deciding whether to install.

### From CI

Add the token as an `OVSX_PAT` secret on the `marketplace` environment. The **Publish**
workflow's `target` input then sends a release to `open-vsx`, or to `both`. It creates
the namespace if needed and publishes the `.vsix` attached to the release, so both
registries get the same bytes.

## Nice to have

- **A short GIF of the view in use.** For something interactive this sells the extension
  far better than the static screenshot does — the tree expanding, a task running, the
  tick appearing. Put it in `media/` and reference it by absolute URL, as the screenshot
  is; a relative path renders on GitHub and breaks on the listing page.
