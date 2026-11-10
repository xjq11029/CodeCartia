param(
    [string]$FixtureRoot = (Join-Path $PSScriptRoot 'fixtures'),
    [string]$RoslynRoot = $PSHOME,
    [string]$OutFile = (Join-Path $PSScriptRoot 'reports/actual.json')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$taskUtf8 = [System.Text.UTF8Encoding]::new($false, $true)

function Get-Fingerprint([byte[]]$Bytes) {
    return 'sha256:' + [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}

function Get-ContainedPath([string]$Root, [string]$Relative, [bool]$MustExist = $true) {
    $taskRootPath = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $taskFullPath = [IO.Path]::GetFullPath((Join-Path $taskRootPath $Relative))
    if (-not $taskFullPath.StartsWith($taskRootPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "输入/输出越过登记根：$Relative"
    }
    $taskWalk = $taskFullPath
    while ($taskWalk -and $taskWalk.Length -ge $taskRootPath.Length) {
        if (Test-Path -LiteralPath $taskWalk) {
            if ((Get-Item -LiteralPath $taskWalk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "登记根内拒绝链接或重解析点：$taskWalk"
            }
        }
        $taskWalk = [IO.Path]::GetDirectoryName($taskWalk)
    }
    if ($MustExist -and -not (Test-Path -LiteralPath $taskFullPath -PathType Leaf)) {
        throw "登记输入不存在：$Relative"
    }
    return $taskFullPath
}

function Read-Source([string]$Relative) {
    $taskPath = Get-ContainedPath $FixtureRoot $Relative
    $taskBytes = [IO.File]::ReadAllBytes($taskPath)
    $taskBomLength = 0
    if ($taskBytes.Length -ge 3 -and $taskBytes[0] -eq 239 -and $taskBytes[1] -eq 187 -and $taskBytes[2] -eq 191) {
        $taskBomLength = 3
    }
    $taskText = $taskUtf8.GetString($taskBytes, $taskBomLength, $taskBytes.Length - $taskBomLength)
    return @{
        inputId = 'csharp-input:' + $Relative
        relativePath = $Relative
        inputFingerprint = Get-Fingerprint $taskBytes
        encoding = $(if ($taskBomLength) { 'UTF-8-with-BOM' } else { 'UTF-8-no-BOM' })
        byteLength = $taskBytes.Length
        bomLength = $taskBomLength
        text = $taskText
    }
}

function Get-Position([string]$Text, [int]$Offset) {
    $taskLine = 1
    $taskColumn = 1
    $taskNativeColumn = 0
    for ($taskIndex = 0; $taskIndex -lt $Offset; $taskIndex++) {
        $taskChar = $Text[$taskIndex]
        if ($taskChar -eq [char]13 -or $taskChar -eq [char]10) {
            if ($taskChar -eq [char]13 -and $taskIndex + 1 -lt $Offset -and $Text[$taskIndex + 1] -eq [char]10) { $taskIndex++ }
            $taskLine++
            $taskColumn = 1
            $taskNativeColumn = 0
        } else {
            if ([char]::IsHighSurrogate($taskChar)) { $taskIndex++; $taskNativeColumn++ }
            $taskColumn++
            $taskNativeColumn++
        }
    }
    return @{ line = $taskLine; column = $taskColumn; nativeLine = $taskLine - 1; nativeColumn = $taskNativeColumn }
}

function Get-SourceSpan($Source, [int]$Start, [int]$Length) {
    $taskEnd = $Start + $Length
    $taskFailure = $null
    foreach ($taskOffset in @($Start, $taskEnd)) {
        if ($taskOffset -lt 0 -or $taskOffset -gt $Source.text.Length) { $taskFailure = 'UTF16_ENDPOINT_OUTSIDE_INPUT'; break }
        if ($taskOffset -gt 0 -and $taskOffset -lt $Source.text.Length) {
            if ([char]::IsHighSurrogate($Source.text[$taskOffset - 1]) -and [char]::IsLowSurrogate($Source.text[$taskOffset])) {
                $taskFailure = 'UTF16_ENDPOINT_INSIDE_SURROGATE'; break
            }
            if ($Source.text[$taskOffset - 1] -eq [char]13 -and $Source.text[$taskOffset] -eq [char]10) {
                $taskFailure = 'UTF16_ENDPOINT_INSIDE_CRLF'; break
            }
        }
    }
    $taskSpan = [ordered]@{
        inputId = $Source.inputId
        inputFingerprint = $Source.inputFingerprint
        coordinatePolicyId = 'raw-bytes-codepoints-v0.1'
        normalized = $null
        nativePositions = @([ordered]@{
            tool = 'Roslyn'
            toolVersion = $taskRoslynVersion
            inputId = $Source.inputId
            offsetUnit = 'UTF16-code-unit'
            offsetBase = 0
            lineBase = 0
            columnBase = 0
            endConvention = 'exclusive'
            startUtf16 = $Start
            endUtf16 = $taskEnd
        })
        mappingIds = @()
        mappingStatus = 'unavailable'
        diagnosticCode = $taskFailure
    }
    if (-not $taskFailure) {
        $taskStartPosition = Get-Position $Source.text $Start
        $taskEndPosition = Get-Position $Source.text $taskEnd
        $taskSpan.normalized = [ordered]@{
            startByte = $Source.bomLength + $taskUtf8.GetByteCount($Source.text.Substring(0, $Start))
            endByte = $Source.bomLength + $taskUtf8.GetByteCount($Source.text.Substring(0, $taskEnd))
            startLine = $taskStartPosition.line
            startColumn = $taskStartPosition.column
            endLine = $taskEndPosition.line
            endColumn = $taskEndPosition.column
        }
        $taskSpan.nativePositions[0].startLine = $taskStartPosition.nativeLine
        $taskSpan.nativePositions[0].startColumn = $taskStartPosition.nativeColumn
        $taskSpan.nativePositions[0].endLine = $taskEndPosition.nativeLine
        $taskSpan.nativePositions[0].endColumn = $taskEndPosition.nativeColumn
        $taskSpan.mappingStatus = 'exact'
    }
    return $taskSpan
}

$taskManifestPath = Join-Path $PSScriptRoot 'inputs.json'
$taskManifestBytes = [IO.File]::ReadAllBytes($taskManifestPath)
$taskManifest = $taskUtf8.GetString($taskManifestBytes) | ConvertFrom-Json
if ($taskManifest.references -ne 'runtime-core-library-only') { throw '仅支持显式的 runtime-core-library-only 实验配置' }
foreach ($taskAssembly in @('Microsoft.CodeAnalysis.dll', 'Microsoft.CodeAnalysis.CSharp.dll')) {
    Add-Type -Path (Join-Path $RoslynRoot $taskAssembly)
}
$taskRoslynVersion = [Microsoft.CodeAnalysis.CSharp.CSharpCompilation].Assembly.GetName().Version.ToString()
$taskCorePath = [object].Assembly.Location
$taskReference = [Microsoft.CodeAnalysis.MetadataReference]::CreateFromFile($taskCorePath)
$taskLanguageVersion = [Enum]::Parse([Microsoft.CodeAnalysis.CSharp.LanguageVersion], $taskManifest.languageVersion)
$taskParseOptions = [Microsoft.CodeAnalysis.CSharp.CSharpParseOptions]::Default.WithLanguageVersion($taskLanguageVersion)
$taskCompilationOptions = [Microsoft.CodeAnalysis.CSharp.CSharpCompilationOptions]::new([Microsoft.CodeAnalysis.OutputKind]::DynamicallyLinkedLibrary)
$taskSources = @{}
$taskCaseReports = [Collections.Generic.List[object]]::new()

foreach ($taskCase in $taskManifest.cases) {
    $taskTrees = [Collections.Generic.List[Microsoft.CodeAnalysis.SyntaxTree]]::new()
    foreach ($taskRelative in $taskCase.sources) {
        if ([IO.Path]::GetExtension($taskRelative) -ne '.cs') { throw "源码扩展名不在实验登记范围：$taskRelative" }
        $taskSource = Read-Source $taskRelative
        $taskSources[$taskRelative] = $taskSource
        $taskTree = [Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree]::ParseText($taskSource.text, $taskParseOptions, $taskRelative)
        $taskTrees.Add($taskTree)
    }
    $taskCompilation = [Microsoft.CodeAnalysis.CSharp.CSharpCompilation]::Create(
        'Experiment_' + $taskCase.id.Replace('-', '_'),
        [Microsoft.CodeAnalysis.SyntaxTree[]]$taskTrees.ToArray(),
        [Microsoft.CodeAnalysis.MetadataReference[]]@($taskReference),
        $taskCompilationOptions
    )
    $taskCalls = [Collections.Generic.List[object]]::new()
    $taskDeclarations = [Collections.Generic.List[object]]::new()
    foreach ($taskTree in $taskTrees) {
        $taskSource = $taskSources[$taskTree.FilePath]
        $taskModel = $taskCompilation.GetSemanticModel($taskTree)
        foreach ($taskNode in $taskTree.GetRoot().DescendantNodes()) {
            if ($taskNode -is [Microsoft.CodeAnalysis.CSharp.Syntax.MethodDeclarationSyntax]) {
                $taskDeclared = $taskModel.GetDeclaredSymbol($taskNode)
                $taskDeclarations.Add([ordered]@{
                    signature = $taskDeclared.ToDisplayString([Microsoft.CodeAnalysis.SymbolDisplayFormat]::CSharpErrorMessageFormat)
                    sourceSpan = Get-SourceSpan $taskSource $taskNode.Identifier.Span.Start $taskNode.Identifier.Span.Length
                })
            }
            if ($taskNode -isnot [Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax]) { continue }
            $taskSymbolInfo = $taskModel.GetSymbolInfo($taskNode)
            $taskOperation = $taskModel.GetOperation($taskNode)
            $taskSymbol = $taskSymbolInfo.Symbol
            $taskTarget = $null
            $taskReason = 'no-bound-symbol'
            $taskResolution = 'unresolved'
            $taskTargetMode = 'unknown'
            $taskTargetCompleteness = 'unknown'
            if (($null -ne $taskOperation -and $taskOperation.Kind.ToString() -eq 'DynamicInvocation') -or $taskSymbolInfo.CandidateReason.ToString() -eq 'LateBound') {
                $taskReason = 'dynamic-dispatch'
            } elseif ($null -ne $taskSymbol -and $taskSymbol -is [Microsoft.CodeAnalysis.IMethodSymbol] -and $taskSymbol.IsStatic) {
                $taskTargetMode = 'exact'
                $taskTargetCompleteness = 'complete'
                $taskResolution = 'confirmed'
                $taskReason = 'compiler-bound-static-method'
                $taskDeclarationLocation = @($taskSymbol.Locations | Where-Object { $_.IsInSource } | Select-Object -First 1)
                $taskTarget = [ordered]@{
                    signature = $taskSymbol.ToDisplayString([Microsoft.CodeAnalysis.SymbolDisplayFormat]::CSharpErrorMessageFormat)
                    declarationSpan = $null
                    locationKind = 'metadata'
                }
                if ($taskDeclarationLocation.Count) {
                    $taskLocation = $taskDeclarationLocation[0]
                    $taskTarget.declarationSpan = Get-SourceSpan $taskSources[$taskLocation.SourceTree.FilePath] $taskLocation.SourceSpan.Start $taskLocation.SourceSpan.Length
                    $taskTarget.locationKind = 'source'
                }
            } elseif ($null -ne $taskSymbol) {
                $taskReason = 'instance-dispatch-outside-experiment'
            }
            $taskCandidates = @($taskSymbolInfo.CandidateSymbols | ForEach-Object { $_.ToDisplayString([Microsoft.CodeAnalysis.SymbolDisplayFormat]::CSharpErrorMessageFormat) })
            $taskCalls.Add([ordered]@{
                sampleKey = $taskCase.id + ':' + $taskTree.FilePath + ':' + $taskNode.Span.Start
                text = $taskNode.ToString()
                sourceSpan = Get-SourceSpan $taskSource $taskNode.Span.Start $taskNode.Span.Length
                targetMode = $taskTargetMode
                targetSetCompleteness = $taskTargetCompleteness
                resolution = $taskResolution
                target = $taskTarget
                candidateSignatures = $taskCandidates
                candidateReason = $taskSymbolInfo.CandidateReason.ToString()
                operationKind = $(if ($null -ne $taskOperation) { $taskOperation.Kind.ToString() } else { $null })
                reason = $taskReason
                production = 'automatic'
                semanticKind = 'implementation-fact'
                runtimeObserved = $false
            })
        }
    }
    $taskDiagnostics = @($taskCompilation.GetDiagnostics() | ForEach-Object {
        $taskDiagnosticSpan = $null
        if ($_.Location.IsInSource) {
            $taskDiagnosticSpan = Get-SourceSpan $taskSources[$_.Location.SourceTree.FilePath] $_.Location.SourceSpan.Start $_.Location.SourceSpan.Length
        }
        [ordered]@{
            id = $_.Id
            severity = $_.Severity.ToString()
            message = $_.GetMessage([Globalization.CultureInfo]::InvariantCulture)
            sourceSpan = $taskDiagnosticSpan
        }
    })
    $taskCaseReports.Add([ordered]@{
        caseId = $taskCase.id
        declarations = $taskDeclarations.ToArray()
        calls = $taskCalls.ToArray()
        diagnostics = $taskDiagnostics
        localCompilerDiagnosticsClear = ($taskDiagnostics.Count -eq 0)
        completeness = [ordered]@{
            complete = $false
            missingInputs = $(if ($taskCase.id -eq 'missing-reference') { @('ExternalApi reference') } else { @() })
            unsupportedModes = @('full-project-and-framework-semantics', 'dataflow', 'runtime-dispatch')
            freshness = 'current'
        }
    })
}

$taskCoordinateSource = Read-Source $taskManifest.coordinateInput
$taskSources[$taskManifest.coordinateInput] = $taskCoordinateSource
$taskProbes = @($taskManifest.coordinateProbes | ForEach-Object {
    [ordered]@{ id = $_.id; sourceSpan = Get-SourceSpan $taskCoordinateSource $_.startUtf16 $_.lengthUtf16 }
})
$taskPublicInputs = @($taskSources.Values | Sort-Object relativePath | ForEach-Object {
    [ordered]@{
        inputId = $_.inputId; relativePath = $_.relativePath; inputFingerprint = $_.inputFingerprint
        encoding = $_.encoding; byteLength = $_.byteLength; bomLength = $_.bomLength
    }
})
$taskReport = [ordered]@{
    reportFormatVersion = 'csharp-exploration-report-v1'
    schemaVersion = '0.1-draft'
    contractSubset = 'M1-02 source-span, local static binding, unknown target and diagnostics only'
    inputVersion = $taskManifest.inputVersion
    analysisMode = 'static'
    generatedAt = [DateTime]::UtcNow.ToString('o')
    analysisProfile = [ordered]@{
        extractorVersion = 'csharp-experiment-v1'
        extractorFingerprint = Get-Fingerprint ([IO.File]::ReadAllBytes($PSCommandPath))
        inputManifestFingerprint = Get-Fingerprint $taskManifestBytes
        fixtureRoot = [IO.Path]::GetFullPath($FixtureRoot)
        fileSpacePolicy = 'Windows lexical containment; OrdinalIgnoreCase; reject reparse points within registered root'
        powershellVersion = $PSVersionTable.PSVersion.ToString()
        runtimeVersion = [Runtime.InteropServices.RuntimeInformation]::FrameworkDescription
        roslynVersion = $taskRoslynVersion
        roslynRoot = [IO.Path]::GetFullPath($RoslynRoot)
        languageVersion = $taskManifest.languageVersion
        preprocessorSymbols = @()
        outputKind = 'DynamicallyLinkedLibrary'
        emit = $false
        projectLoad = $false
        fixtureExecuted = $false
        references = @([ordered]@{
            path = $taskCorePath
            fingerprint = Get-Fingerprint ([IO.File]::ReadAllBytes($taskCorePath))
            role = 'explicit runtime core metadata; no SDK/reference-pack claim'
        })
        answerInputsRead = $false
    }
    inputs = $taskPublicInputs
    cases = $taskCaseReports.ToArray()
    coordinateProbes = $taskProbes
}
$taskOutPath = Get-ContainedPath $PSScriptRoot ([IO.Path]::GetRelativePath($PSScriptRoot, [IO.Path]::GetFullPath($OutFile))) $false
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($taskOutPath)) | Out-Null
[IO.File]::WriteAllText($taskOutPath, ($taskReport | ConvertTo-Json -Depth 40), $taskUtf8)
Write-Output "已生成局部实验报告：$taskOutPath"
