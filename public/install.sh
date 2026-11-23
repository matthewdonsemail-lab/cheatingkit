#!/bin/sh
set -eu

if ! command -v bun >/dev/null 2>&1; then
  echo 'Bun is required: https://bun.sh/docs/installation' >&2
  exit 1
fi

track="${CK_TRACK:-latest}"
case "$track" in
  latest|next) ;;
  *) echo 'CK_TRACK must be latest or next' >&2; exit 1 ;;
esac

version="${CK_VERSION:-}"
if [ -z "$version" ]; then
  version="$(CK_INSTALL_TRACK="$track" bun -e '
    const response = await fetch("https://registry.npmjs.org/-/package/cheatingkit/dist-tags");
    if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
    const tags = await response.json();
    const version = tags[process.env.CK_INSTALL_TRACK];
    if (!version) throw new Error(`No published ${process.env.CK_INSTALL_TRACK} release`);
    console.log(version);
  ')"
fi

if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-nightly\.[0-9]{12}\.[0-9a-f]{7})?$'; then
  echo 'Invalid CK_VERSION or registry version' >&2
  exit 1
fi
echo "Installing cheatingkit@$version"
bun add -g "cheatingkit@$version"
actual="$(ck --version)"
case "$actual" in
  "ck $version "*) echo "$actual" ;;
  *) echo "Installed version mismatch: expected $version, got $actual" >&2; exit 1 ;;
esac
