$ErrorActionPreference = 'Stop'
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  throw 'Bun is required: https://bun.sh/docs/installation'
}

$track = if ($env:CK_TRACK) { $env:CK_TRACK } else { 'latest' }
if ($track -notin @('latest', 'next')) { throw 'CK_TRACK must be latest or next' }

& bun add -g "cheatingkit@$track"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& ck --version
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
