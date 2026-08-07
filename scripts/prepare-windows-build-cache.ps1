[CmdletBinding()]
param(
  [string]$CacheRoot = (Join-Path $env:LOCALAPPDATA 'PrimeAgentBuildCache\electron-builder-26.8.1-winCodeSign-2.6.0-e8b408d9'),
  [string]$SevenZipPath
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
$requiredFileSha256 = @{
  'rcedit-x64.exe' = 'ab53500d556fd824636621bca7dbecd8583ba181891c3e9efdcf16b72a28b0cd'
  'rcedit-ia32.exe' = '8d7f9e4cdbffadf53806ea0646a6cf5a67244f16dda3cabb7b3f00dc0cddb552'
  'windows-10\x64\signtool.exe' = 'e472ab54601f9da46915a68da4d93b6d6cc61502e6bf18d5a53c0a70176119a4'
  'windows-10\x64\wintrust.dll' = 'fa647b3aab83e6566675289f93e60ba2cc045dd82fabf77e9f80adaa3daabce7'
  'windows-10\x64\mssign32.dll' = '72692c180e163e55571036438a90f02cc11c5c0f1303008c9dbd1bd743c7b078'
  'windows-10\ia32\signtool.exe' = 'a13bfd50668b2acb91b0334d36dce7e04d6fc2e3a122f9c9c145d3659fd0cd84'
  'windows-6\signtool.exe' = '854c356a9d9977fb2ed22ce04b531ab6f4417da06a4dba6e3d3d628b9cfb988c'
}

function Assert-PreparedPayload([string]$Root) {
  $missing = @($requiredFiles | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $Root $_) -PathType Leaf)
  })
  if ($missing.Count -gt 0) {
    throw "The prepared cache is missing required Windows tools: $($missing -join ', ')"
  }

  $files = @(Get-ChildItem -LiteralPath $Root -Recurse -Force -File)
  $directories = @(Get-ChildItem -LiteralPath $Root -Recurse -Force -Directory)
  $totalBytes = ($files | Measure-Object Length -Sum).Sum
  if ($files.Count -ne 81 -or $directories.Count -ne 13 -or $totalBytes -ne 24762844) {
    throw "The prepared cache inventory is invalid: files=$($files.Count), directories=$($directories.Count), bytes=$totalBytes"
  }

  foreach ($relativePath in $requiredFiles) {
    $actualHash = (Get-FileHash -LiteralPath (Join-Path $Root $relativePath) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $requiredFileSha256[$relativePath]) {
      throw "The prepared cache contains an untrusted Windows tool: $relativePath"
    }
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

$sevenZip = if ([string]::IsNullOrWhiteSpace($SevenZipPath)) {
  Get-ChildItem -Path (Join-Path $PWD 'node_modules\.pnpm\7zip-bin@*\node_modules\7zip-bin\win\x64\7za.exe') -File |
    Select-Object -First 1 -ExpandProperty FullName
}
else {
  [IO.Path]::GetFullPath($SevenZipPath)
}
if (-not $sevenZip -or -not (Test-Path -LiteralPath $sevenZip -PathType Leaf)) {
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
