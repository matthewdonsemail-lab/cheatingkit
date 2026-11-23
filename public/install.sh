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

bun add -g "cheatingkit@$track"
ck --version
