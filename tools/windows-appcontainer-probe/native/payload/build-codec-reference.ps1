[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $OutputDirectory,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $MsvcRoot,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $WindowsKitsRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-ExactKeys {
    param(
        [Parameter(Mandatory = $true)] [object] $Value,
        [Parameter(Mandatory = $true)] [string[]] $Keys,
        [Parameter(Mandatory = $true)] [string] $Label
    )
    $actual = @($Value.PSObject.Properties.Name | Sort-Object -CaseSensitive)
    $expected = @($Keys | Sort-Object -CaseSensitive)
    if (($actual -join "`n") -cne ($expected -join "`n")) {
        throw "$Label has unexpected keys"
    }
}

function Resolve-RequiredDirectory {
    param([Parameter(Mandatory = $true)] [string] $Path)
    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
    if (-not (Test-Path -LiteralPath $resolved.Path -PathType Container)) {
        throw "required directory is absent"
    }
    return [System.IO.Path]::GetFullPath($resolved.Path)
}

function Assert-FileDigest {
    param(
        [Parameter(Mandatory = $true)] [string] $Path,
        [Parameter(Mandatory = $true)] [string] $ExpectedSha256,
        [Parameter(Mandatory = $true)] [long] $ExpectedBytes
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "pinned input is absent"
    }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "pinned input must not be a reparse point"
    }
    if ($item.Length -ne $ExpectedBytes) {
        throw "pinned input byte length differs"
    }
    $actualSha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha256 -cne $ExpectedSha256) {
        throw "pinned input digest differs"
    }
}

$sourceRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$manifestPath = Join-Path $sourceRoot 'codec-reference-build-manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

Assert-ExactKeys $manifest @(
    'schemaVersion', 'kind', 'artifact', 'toolchain', 'inputs', 'compileFlags',
    'archiveFlags', 'sourceStatus', 'limitations', 'recipeSha256'
) 'build manifest'
Assert-ExactKeys $manifest.artifact @('name', 'format', 'machine') 'artifact'
Assert-ExactKeys $manifest.toolchain @(
    'family', 'toolsetVersion', 'compilerFileVersion', 'archiverFileVersion',
    'windowsSdkVersion', 'host', 'target', 'language'
) 'toolchain'
Assert-ExactKeys $manifest.sourceStatus @(
    'classification', 'compiledLocally', 'executedLocally', 'liveProbeActions',
    'productIntegrated'
) 'source status'

$expectedCompileFlags = @(
    '/nologo', '/c', '/TC', '/std:c17', '/O2', '/Oi', '/GL', '/GS',
    '/guard:cf', '/sdl', '/W4', '/WX', '/MT', '/ZH:SHA_256', '/Brepro',
    '/volatile:iso', '/Zc:inline', '/diagnostics:caret',
    '/D_CRT_SECURE_NO_WARNINGS'
)
$expectedArchiveFlags = @('/NOLOGO', '/MACHINE:X64', '/LTCG', '/BREPRO', '/WX')

if ($manifest.schemaVersion -ne 1 -or
    $manifest.kind -cne 'prime_continuim_appcontainer_payload_codec_reference_build_v1' -or
    $manifest.artifact.name -cne 'prime-continuim-appcontainer-payload-codec-reference-x64.lib' -or
    $manifest.artifact.format -cne 'coff_static_library' -or
    $manifest.artifact.machine -cne 'x64' -or
    $manifest.toolchain.family -cne 'msvc' -or
    $manifest.toolchain.toolsetVersion -cne '14.44.35207' -or
    $manifest.toolchain.compilerFileVersion -cne '19.44.35219.0' -or
    $manifest.toolchain.archiverFileVersion -cne '14.44.35219.0' -or
    $manifest.toolchain.windowsSdkVersion -cne '10.0.26100.0' -or
    $manifest.toolchain.host -cne 'x64' -or
    $manifest.toolchain.target -cne 'x64' -or
    $manifest.toolchain.language -cne 'c17' -or
    $manifest.sourceStatus.classification -cne 'source_only_codec_reference' -or
    $manifest.sourceStatus.compiledLocally -ne $false -or
    $manifest.sourceStatus.executedLocally -ne $false -or
    $manifest.sourceStatus.liveProbeActions -ne $false -or
    $manifest.sourceStatus.productIntegrated -ne $false -or
    (@($manifest.compileFlags) -join "`n") -cne ($expectedCompileFlags -join "`n") -or
    (@($manifest.archiveFlags) -join "`n") -cne ($expectedArchiveFlags -join "`n")) {
    throw 'build manifest identity differs'
}

$recipeSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($recipeSha256 -cne $manifest.recipeSha256) {
    throw 'build recipe digest differs'
}

$resolvedMsvcRoot = Resolve-RequiredDirectory $MsvcRoot
$resolvedKitsRoot = Resolve-RequiredDirectory $WindowsKitsRoot
if ((Split-Path -Leaf $resolvedMsvcRoot) -cne $manifest.toolchain.toolsetVersion) {
    throw 'MSVC toolset version differs'
}

$compilerPath = Join-Path $resolvedMsvcRoot 'bin\Hostx64\x64\cl.exe'
$archiverPath = Join-Path $resolvedMsvcRoot 'bin\Hostx64\x64\lib.exe'
if (-not (Test-Path -LiteralPath $compilerPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $archiverPath -PathType Leaf)) {
    throw 'pinned x64 MSVC tools are absent'
}
$compilerVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($compilerPath).FileVersion
$archiverVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($archiverPath).FileVersion
if ($compilerVersion -cne $manifest.toolchain.compilerFileVersion -or
    $archiverVersion -cne $manifest.toolchain.archiverFileVersion) {
    throw 'MSVC executable version differs'
}

$sdkIncludeRoot = Join-Path $resolvedKitsRoot (Join-Path 'Include' $manifest.toolchain.windowsSdkVersion)
$ucrtInclude = Join-Path $sdkIncludeRoot 'ucrt'
if (-not (Test-Path -LiteralPath $ucrtInclude -PathType Container)) {
    throw 'pinned Windows SDK version is absent'
}

foreach ($influentialVariable in @('CL', '_CL_', 'LINK', 'INCLUDE', 'LIB', 'LIBPATH')) {
    $value = [System.Environment]::GetEnvironmentVariable($influentialVariable, 'Process')
    if (-not [string]::IsNullOrEmpty($value)) {
        throw "influential environment variable $influentialVariable must be empty"
    }
}

$expectedInputs = @(
    [ordered]@{
        path = 'payload_codec_reference.c'
        sha256 = 'de5c3af47dd8e358d944f92bd5c948e8b5e9dec18b4d928bdc4a4023ff24df67'
        bytes = 25974
    },
    [ordered]@{
        path = 'payload_codec_reference.h'
        sha256 = '154342948071282f30f3a31aa9e801e75b9cc78bad3b79bed792cbf8433e8745'
        bytes = 1742
    },
    [ordered]@{
        path = 'payload_contract.h'
        sha256 = '037cf5f8408c4db6df3fc6433c803a28878d381f5db355e412b1d1f518e6cb43'
        bytes = 10584
    }
)
$actualInputNames = @($manifest.inputs | ForEach-Object { $_.path })
if (($actualInputNames -join "`n") -cne (@($expectedInputs | ForEach-Object { $_.path }) -join "`n")) {
    throw 'build input order or set differs'
}
for ($inputIndex = 0; $inputIndex -lt $manifest.inputs.Count; $inputIndex += 1) {
    $inputRecord = $manifest.inputs[$inputIndex]
    $expectedInput = $expectedInputs[$inputIndex]
    Assert-ExactKeys $inputRecord @('path', 'sha256', 'bytes') 'build input'
    if ($inputRecord.path -notmatch '^[a-z0-9_]+\.(?:c|h)$') {
        throw 'build input name is invalid'
    }
    if ($inputRecord.path -cne $expectedInput.path -or
        $inputRecord.sha256 -cne $expectedInput.sha256 -or
        [long]$inputRecord.bytes -ne [long]$expectedInput.bytes) {
        throw 'build input declaration differs'
    }
    Assert-FileDigest (Join-Path $sourceRoot $inputRecord.path) `
        $inputRecord.sha256 ([long]$inputRecord.bytes)
}

$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $outputPath) {
    throw 'output directory must not already exist'
}
[void](New-Item -ItemType Directory -Path $outputPath)

$objectPath = Join-Path $outputPath 'payload_codec_reference.obj'
$libraryPath = Join-Path $outputPath $manifest.artifact.name
$sourcePath = Join-Path $sourceRoot 'payload_codec_reference.c'
$compileArguments = @($manifest.compileFlags)
$compileArguments += "/I$resolvedMsvcRoot\include"
$compileArguments += "/I$ucrtInclude"
$compileArguments += "/Fo$objectPath"
$compileArguments += $sourcePath

& $compilerPath @compileArguments
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $objectPath -PathType Leaf)) {
    throw 'codec reference compilation failed'
}

$archiveArguments = @($manifest.archiveFlags)
$archiveArguments += "/OUT:$libraryPath"
$archiveArguments += $objectPath
& $archiverPath @archiveArguments
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $libraryPath -PathType Leaf)) {
    throw 'codec reference archive failed'
}

$libraryItem = Get-Item -LiteralPath $libraryPath -Force
$receipt = [ordered]@{
    schemaVersion = 1
    kind = 'prime_continuim_appcontainer_payload_codec_reference_build_receipt_v1'
    artifact = [ordered]@{
        name = $manifest.artifact.name
        machine = 'x64'
        sha256 = (Get-FileHash -LiteralPath $libraryPath -Algorithm SHA256).Hash.ToLowerInvariant()
        bytes = $libraryItem.Length
    }
    buildManifestSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    recipeSha256 = $recipeSha256
    compiled = $true
    executed = $false
    peImportClosureInspected = $false
    productIntegrated = $false
}
$receiptPath = Join-Path $outputPath 'build-receipt.json'
$receipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $receiptPath -Encoding UTF8 -NoNewline
