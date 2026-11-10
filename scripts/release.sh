#!/usr/bin/env bash
# Builds and packages the plugin, then records the archive URL and checksum in
# artifacthub-pkg.yml for the given version. Used by .github/workflows/release.yml.
set -euo pipefail
version="${1:?usage: scripts/release.sh <version>}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must be X.Y.Z" >&2; exit 1; }
repo="${GITHUB_REPOSITORY:-moonlysoftware/headlamp-elevated-access}"
cd "$(dirname "$0")/.."

npm version "$version" --no-git-tag-version --allow-same-version >/dev/null
npm run -s lint
npm run -s tsc
CI=1 npm test -s
npm run -s build
npm run -s package >/dev/null

tarball="headlamp-elevated-access-${version}.tar.gz"
[[ -f "$tarball" ]] || { echo "missing $tarball" >&2; exit 1; }
checksum="$(sha256sum "$tarball" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$tarball" | cut -d' ' -f1)"
url="https://github.com/${repo}/releases/download/v${version}/${tarball}"
created="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

python3 - "$version" "$url" "$checksum" "$created" <<'PY'
import re, sys
version, url, checksum, created = sys.argv[1:]
p = "artifacthub-pkg.yml"
s = open(p).read()
s = re.sub(r"(?m)^version: .*$", f"version: {version}", s)
s = re.sub(r'(?m)^createdAt: .*$', f'createdAt: "{created}"', s)
s = re.sub(r'(?m)^(\s*headlamp/plugin/archive-url: ).*$', rf'\g<1>"{url}"', s)
s = re.sub(r'(?m)^(\s*headlamp/plugin/archive-checksum: ).*$', rf'\g<1>"SHA256:{checksum}"', s)
open(p, "w").write(s)
PY
echo "tarball=$tarball"
echo "checksum=$checksum"
