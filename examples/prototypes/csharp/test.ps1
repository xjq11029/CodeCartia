Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Get-ReportPath([string]$Name) {
    $taskReportRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'reports'))
    $taskPath = [IO.Path]::GetFullPath((Join-Path $taskReportRoot $Name))
    if (-not $taskPath.StartsWith($taskReportRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($taskPath) -ne '.json') { throw 'Report path refused' }
    $taskWalk = $taskPath
    while ($taskWalk -and $taskWalk.Length -ge $taskReportRoot.Length) {
        $taskItem = Get-Item -LiteralPath $taskWalk -Force -ErrorAction SilentlyContinue
        if ($null -ne $taskItem -and ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Report link refused' }
        $taskWalk = [IO.Path]::GetDirectoryName($taskWalk)
    }
    return $taskPath
}
$taskMarker = Join-Path $PSScriptRoot 'fixtures/project.executed'
if (Test-Path -LiteralPath $taskMarker) { throw '项目执行哨兵已存在，不能验证未执行。' }
& (Join-Path $PSScriptRoot 'analyze.ps1')
$taskChecks = [Collections.Generic.List[object]]::new()
$taskManifest = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'inputs.json') | ConvertFrom-Json
$taskBoundaryPath = Get-ReportPath 'boundary-inputs.json'
foreach ($taskItem in @(
    @{ name = 'project-file-refused-before-loading'; source = 'rejected.csproj'; reason = '源码扩展名' },
    @{ name = 'path-traversal-refused'; source = '../analyze.ps1.cs'; reason = '越过登记根' }
)) {
    $taskManifest.cases = @(@{ id = 'boundary'; sources = @($taskItem.source) })
    [IO.File]::WriteAllText($taskBoundaryPath, ($taskManifest | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    $taskRejected = $false
    try { & (Join-Path $PSScriptRoot 'analyze.ps1') -InputManifest $taskBoundaryPath -OutFile (Join-Path $PSScriptRoot 'reports/rejected.json') }
    catch { $taskRejected = $_.Exception.Message.Contains($taskItem.reason) }
    $taskChecks.Add(@{ name = $taskItem.name; passed = $taskRejected })
}
$taskRejected = $false
try { & (Join-Path $PSScriptRoot 'analyze.ps1') -OutFile (Join-Path $PSScriptRoot 'expected.json') }
catch { $taskRejected = $_.Exception.Message.Contains('越过登记根') }
$taskChecks.Add(@{ name = 'output-cannot-overwrite-input-or-oracle'; passed = $taskRejected })
$taskChecks.Add(@{ name = 'project-execution-sentinel-absent'; passed = -not (Test-Path -LiteralPath $taskMarker) })
$taskProbeName = '.runner-output-probe-' + [Guid]::NewGuid().ToString('N')
$taskProbeRoot = Join-Path $PSScriptRoot $taskProbeName
$taskProbeLink = Join-Path $PSScriptRoot ('reports/' + $taskProbeName)
[IO.Directory]::CreateDirectory($taskProbeRoot) | Out-Null
$taskProbeFile = Join-Path $taskProbeRoot 'sentinel.json'
[IO.File]::WriteAllText($taskProbeFile, 'unchanged')
try {
    New-Item -ItemType Junction -Path $taskProbeLink -Target $taskProbeRoot | Out-Null
    $taskRejected = $false
    try { [IO.File]::WriteAllText((Get-ReportPath ($taskProbeName + '/sentinel.json')), 'must not write') }
    catch { $taskRejected = $_.Exception.Message.Contains('Report link refused') }
    $taskChecks.Add(@{ name = 'runner-directory-link-refused'; passed = $taskRejected -and [IO.File]::ReadAllText($taskProbeFile) -eq 'unchanged' })
} finally {
    if (Test-Path -LiteralPath $taskProbeLink) { Remove-Item -LiteralPath $taskProbeLink -Force }
    Remove-Item -LiteralPath $taskProbeFile -Force
    Remove-Item -LiteralPath $taskProbeRoot -Force
}
$taskPolicy = @{ scope = 'Explicit refusal of project files only; actual MSBuild/JDT project loading untested'; testFingerprint = 'sha256:' + [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($PSCommandPath))).ToLowerInvariant(); checks = $taskChecks.ToArray() }
[IO.File]::WriteAllText((Get-ReportPath 'boundary-policy.json'), ($taskPolicy | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
& python (Join-Path $PSScriptRoot 'verify.py')
if ($LASTEXITCODE -ne 0) { throw '独立验证未通过。' }
