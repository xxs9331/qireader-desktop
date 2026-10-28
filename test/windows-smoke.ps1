param([Parameter(Mandatory = $true)][string]$RuntimeZip, [ValidateSet('first', 'restart', 'budget')][string[]]$Phases = @('first', 'restart', 'budget'))
$ErrorActionPreference = 'Stop'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('qireader-smoke-' + [guid]::NewGuid().ToString('N'))
$runtime = Join-Path $testRoot 'runtime'
$profile = Join-Path $testRoot 'profile'
$smoke = Join-Path $PSScriptRoot 'smoke.cjs'
try {
    New-Item -ItemType Directory -Path $profile -Force | Out-Null
    Expand-Archive -LiteralPath $RuntimeZip -DestinationPath $runtime
    $env:QIREADER_TEST_PROFILE = $profile
    foreach ($phase in $Phases) {
        $env:QIREADER_TEST_PHASE = $phase
        $stdout = Join-Path $testRoot ($phase + '.out.log')
        $stderr = Join-Path $testRoot ($phase + '.err.log')
        $process = Start-Process -FilePath (Join-Path $runtime 'electron.exe') -ArgumentList ('"' + $smoke + '"') -WorkingDirectory $runtime -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        $null = $process.Handle # Retain the exit code when the process exits before Refresh.
        if (-not $process.WaitForExit(150000)) {
            $process.Kill()
            throw "Windows browser test timed out: $phase"
        }
        $process.WaitForExit()
        Get-Content -LiteralPath $stdout
        Get-Content -LiteralPath $stderr
        if ($process.ExitCode -ne 0) { throw "Windows browser test failed: $phase ($($process.ExitCode))" }
    }
} finally {
    Remove-Item Env:QIREADER_TEST_PROFILE -ErrorAction SilentlyContinue
    Remove-Item Env:QIREADER_TEST_PHASE -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $testRoot -Recurse -Force
}
