$ErrorActionPreference = 'Stop'
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  throw 'Bun is required: https://bun.sh/docs/installation'
}

$track = if ($env:CK_TRACK) { $env:CK_TRACK } else { 'latest' }
if ($track -notin @('latest', 'next')) { throw 'CK_TRACK must be latest or next' }

$version = $env:CK_VERSION
if (-not $version) {
  $tags = Invoke-RestMethod -Uri 'https://registry.npmjs.org/-/package/cheatingkit/dist-tags'
  $version = $tags.$track
  if (-not $version) { throw "No published $track release" }
}
if ($version -notmatch '^\d+\.\d+\.\d+(?:-nightly\.\d{12}\.[0-9a-f]{7})?$') {
  throw 'Invalid CK_VERSION or registry version'
}

Write-Host "Installing cheatingkit@$version"
& bun add -g "cheatingkit@$version"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$installed = & ck --version
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($installed -notlike "ck $version *") {
  throw "Installed version mismatch: expected $version, got $installed"
}
Write-Host $installed
