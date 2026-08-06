[CmdletBinding()]
param(
  [string]$CacheRoot = (Join-Path $env:LOCALAPPDATA 'PrimeAgentBuildCache\electron-builder-26.8.1-winCodeSign-2.6.0-e8b408d9')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'This cache preparation script is only for Windows packaging.'
}
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw 'LOCALAPPDATA is required for the user-scoped build cache.'
}

$artifactUrl = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z'
$expectedSha512 = 'e8b408d9df413c2dd7b346684d07b5a37b4f880dbc73bf8f63af50f62fe90fc958e39a6c32d1ee2f0bf7bd1724895af7671d5c6cdc8b94147c493c0275c1f0b4'
$resolvedCacheRoot = [IO.Path]::GetFullPath($CacheRoot)
$artifactRoot = Join-Path $resolvedCacheRoot 'winCodeSign'
$finalDirectory = Join-Path $artifactRoot 'winCodeSign-2.6.0'
$archive = Join-Path $artifactRoot 'winCodeSign-2.6.0.7z'
$requiredFiles = @(
  'rcedit-x64.exe',
  'rcedit-ia32.exe',
  'windows-10\x64\signtool.exe',
  'windows-10\x64\wintrust.dll',
  'windows-10\x64\mssign32.dll',
  'windows-10\ia32\signtool.exe',
  'windows-6\signtool.exe'
)

function Assert-PreparedPayload([string]$Root) {
  $missing = @($requiredFiles | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $Root $_) -PathType Leaf)
  })
  if ($missing.Count -gt 0) {
    throw "The prepared cache is missing required Windows tools: $($missing -join ', ')"
  }

  $reparsePoints = @(Get-ChildItem -LiteralPath $Root -Recurse -Force | Where-Object {
    $_.Attributes -band [IO.FileAttributes]::ReparsePoint
  })
  if ($reparsePoints.Count -gt 0) {
    throw "The prepared cache contains unexpected reparse points: $($reparsePoints.FullName -join ', ')"
  }
}

if (Test-Path -LiteralPath $finalDirectory -PathType Container) {
  Assert-PreparedPayload $finalDirectory
  Write-Output $resolvedCacheRoot
  exit 0
}
if (Test-Path -LiteralPath $finalDirectory) {
  throw "Refusing to overwrite a non-directory cache target: $finalDirectory"
}

New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null

if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
  $download = "$archive.download-$([guid]::NewGuid().ToString('N'))"
  try {
    Invoke-WebRequest -Uri $artifactUrl -OutFile $download
    $downloadHash = (Get-FileHash -LiteralPath $download -Algorithm SHA512).Hash.ToLowerInvariant()
    if ($downloadHash -ne $expectedSha512) {
      throw "winCodeSign archive SHA-512 mismatch: $downloadHash"
    }
    Move-Item -LiteralPath $download -Destination $archive
  }
  finally {
    if (Test-Path -LiteralPath $download -PathType Leaf) {
      Remove-Item -LiteralPath $download -Force
    }
  }
}

$archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA512).Hash.ToLowerInvariant()
if ($archiveHash -ne $expectedSha512) {
  throw "Refusing an untrusted winCodeSign archive: $archiveHash"
}

$sevenZip = Get-ChildItem -Path (Join-Path $PWD 'node_modules\.pnpm\7zip-bin@*\node_modules\7zip-bin\win\x64\7za.exe') -File |
  Select-Object -First 1 -ExpandProperty FullName
if (-not $sevenZip) {
  throw 'Bundled 7za.exe was not found. Run pnpm install first.'
}

& $sevenZip t -bd $archive | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "winCodeSign archive validation failed with exit code $LASTEXITCODE"
}

$stagingDirectory = Join-Path $artifactRoot "winCodeSign-2.6.0.staging-$([guid]::NewGuid().ToString('N'))"
$resolvedArtifactRoot = [IO.Path]::GetFullPath($artifactRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
$resolvedStagingDirectory = [IO.Path]::GetFullPath($stagingDirectory)
if (-not $resolvedStagingDirectory.StartsWith("$resolvedArtifactRoot$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing a staging path outside the controlled cache: $resolvedStagingDirectory"
}

New-Item -ItemType Directory -Path $resolvedStagingDirectory | Out-Null
try {
  & $sevenZip x -bd -y $archive "-o$resolvedStagingDirectory" `
    '-x!darwin\10.12\lib\libcrypto.dylib' `
    '-x!darwin\10.12\lib\libssl.dylib' | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "winCodeSign extraction failed with exit code $LASTEXITCODE"
  }
  Assert-PreparedPayload $resolvedStagingDirectory
  Move-Item -LiteralPath $resolvedStagingDirectory -Destination $finalDirectory
}
finally {
  if (Test-Path -LiteralPath $resolvedStagingDirectory -PathType Container) {
    Remove-Item -LiteralPath $resolvedStagingDirectory -Recurse -Force
  }
}

Write-Output $resolvedCacheRoot
