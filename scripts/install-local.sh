#!/usr/bin/env bash
# Build, package and install this extension into the local VS Code.
#
# The `code` CLI is not always on PATH (it is only added by the "Shell Command:
# Install 'code' command in PATH" action), so fall back to the binary inside the
# app bundle rather than failing.
set -euo pipefail

cd "$(dirname "$0")/.."

find_code() {
    if command -v code >/dev/null 2>&1; then
        command -v code
        return
    fi
    for candidate in \
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
        "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"; do
        [ -x "$candidate" ] && { echo "$candidate"; return; }
    done
    echo "Could not find the 'code' CLI. Run 'Shell Command: Install code command in PATH' from the command palette." >&2
    exit 1
}

CODE=$(find_code)
VERSION=$(node -p "require('./package.json').version")
NAME=$(node -p "require('./package.json').name")
# VS Code names the installed folder <publisher>.<name>-<version>, lowercased. Derived
# rather than hardcoded: the publisher id changed once already, and a stale glob silently
# stops cleaning up old versions, which then shadow the new one.
EXT_ID=$(node -p "(require('./package.json').publisher + '.' + require('./package.json').name).toLowerCase()")
VSIX="${NAME}-${VERSION}.vsix"

echo "Packaging ${VSIX} ..."
# vsce runs vscode:prepublish, which type-checks, builds the production bundle and
# load-tests it - so a bundle that cannot activate fails here instead of installing.
npx --yes @vscode/vsce package >/dev/null

echo "Installing into VS Code ..."
"$CODE" --install-extension "$VSIX" --force 2>&1 | grep -v -i 'deprecat' || true

# Older versions linger as separate directories and can shadow the new one.
find "$HOME/.vscode/extensions" -maxdepth 1 -iname "${EXT_ID}-*" \
    ! -iname "*-${VERSION}" -exec rm -rf {} + 2>/dev/null || true

echo
echo "Installed ${VSIX}."
echo "Now reload VS Code:  Cmd+Shift+P -> Developer: Reload Window"
