#!/usr/bin/env bash
# Publish the current version to Open VSX.
#
# Open VSX is the registry VSCodium, Cursor, Windsurf and Gitpod install from - they
# cannot reach the Microsoft Marketplace at all, so this is a separate publish rather
# than a mirror of one.
#
#   OVSX_PAT=... npm run publish-openvsx
#
# The token comes from open-vsx.org: Avatar > Settings > Access Tokens. See
# docs/PUBLISHING.md for the Eclipse account and Publisher Agreement that come first.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -z "${OVSX_PAT:-}" ]; then
    echo "OVSX_PAT is not set." >&2
    echo "Create a token at https://open-vsx.org (Avatar > Settings > Access Tokens)," >&2
    echo "then run: OVSX_PAT=<token> npm run publish-openvsx" >&2
    exit 1
fi

VERSION=$(node -p "require('./package.json').version")
NAME=$(node -p "require('./package.json').name")
NAMESPACE=$(node -p "require('./package.json').publisher")
VSIX="${NAME}-${VERSION}.vsix"

if [ ! -f "$VSIX" ]; then
    echo "Building ${VSIX} ..."
    npx @vscode/vsce package >/dev/null
fi

# The namespace must exist before anything can be published into it. Creating one that
# already exists is an error rather than a no-op, so this only reports rather than fails.
echo "Ensuring the '${NAMESPACE}' namespace exists ..."
if npx ovsx create-namespace "$NAMESPACE" -p "$OVSX_PAT" 2>/dev/null; then
    echo "  created."
else
    echo "  already exists, or could not be created - continuing."
fi

echo "Publishing ${VSIX} to Open VSX ..."
npx ovsx publish "$VSIX" -p "$OVSX_PAT"

cat <<EOF

Published. It will appear at:
  https://open-vsx.org/extension/${NAMESPACE}/${NAME}

Note: creating a namespace makes you a *contributor* to it, not its verified owner, and
extensions in an unverified namespace carry a "not a verified publisher" notice. To
remove it, claim ownership of the namespace:
  https://github.com/EclipseFdn/open-vsx.org/wiki/Managing-Namespaces
EOF
