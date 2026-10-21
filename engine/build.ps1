# Build the engine. Compiles in a temporary folder (Windows can block compilers from writing inside Documents)
# and copies the WebAssembly files next to the app. Usage: powershell -File engine/build.ps1 [-Out folder]
param([string]$Out = '')
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
if ($Out -eq '') { $Out = Join-Path $root 'app' }; New-Item -ItemType Directory -Force $Out | Out-Null
$work = Join-Path $env:TEMP 'hwscan_engine_build'
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
New-Item -ItemType Directory -Force $work | Out-Null
robocopy $here $work /E /XD target /NFL /NDL /NJH /NJS /NP | Out-Null
Push-Location $work
try {
  $env:RUSTFLAGS = '-C target-feature=+simd128'
  cargo build --release --target wasm32-unknown-unknown 2>&1 | Write-Host
  if ($LASTEXITCODE -ne 0) { throw 'cargo build (simd) failed' }
  Copy-Item target\wasm32-unknown-unknown\release\hwscan_engine.wasm (Join-Path $Out 'engine-simd.wasm') -Force
  $env:RUSTFLAGS = ''
  cargo build --release --target wasm32-unknown-unknown --target-dir target-nosimd 2>&1 | Write-Host
  if ($LASTEXITCODE -ne 0) { throw 'cargo build (plain) failed' }
  Copy-Item target-nosimd\wasm32-unknown-unknown\release\hwscan_engine.wasm (Join-Path $Out 'engine.wasm') -Force
} finally { Pop-Location }
Get-ChildItem (Join-Path $Out 'engine*.wasm') | ForEach-Object { '{0}  {1:N0} bytes' -f $_.Name, $_.Length }
