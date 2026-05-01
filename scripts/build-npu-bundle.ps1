#requires -Version 5.1
<#
Builds a fully self-contained OpenWhispr NPU bundle for distribution to
machines that have no Python install, no PyPI access, and no HuggingFace
access. Output: ~900 MB zip the recipient unzips and runs.

Pipeline:
  1. (cached) Build vendor/python-runtime/ — Python 3.12 embeddable + pip + OpenVINO wheels
  2. (cached) Stage vendor/npu-models/whisper-base/ — copy from %APPDATA% if missing
  3. Run `npm run pack` (rebuilds dist/win-unpacked from current source)
  4. Inject vendor/python-runtime  -> dist/win-unpacked/resources/python-runtime
  5. Inject vendor/npu-models      -> dist/win-unpacked/resources/npu-models
  6. Zip dist/win-unpacked         -> Documents/OpenWhispr-Backup/OpenWhispr-NPU-Bundle.zip

Re-run any time. Heavy steps (Python download, pip install) are cached via vendor/.
Force a fresh runtime with -Force.
#>

param(
    [switch]$Force,
    [switch]$SkipPack,        # skip "npm run pack" if you've just built
    [string]$PythonVersion = "3.12.7"
)

$ErrorActionPreference = "Stop"

$repoRoot         = Split-Path -Parent $PSScriptRoot
$vendorDir        = Join-Path $repoRoot "vendor"
$pythonRuntimeDir = Join-Path $vendorDir "python-runtime"
$bundledModelDir  = Join-Path $vendorDir "npu-models\whisper-base"
$winUnpackedDir   = Join-Path $repoRoot "dist\win-unpacked"
$outputDir        = Join-Path $env:USERPROFILE "Documents\OpenWhispr-Backup"
$outputZip        = Join-Path $outputDir "OpenWhispr-NPU-Bundle.zip"

$wheels = @(
    "openvino==2025.4.1",
    "openvino-genai==2025.4.1.0",
    "openvino-tokenizers==2025.4.1.0",
    "fastapi",
    "uvicorn",
    "python-multipart",
    "soundfile",
    "librosa"
)

# ---------- Step 1: Build vendor/python-runtime (cached) ----------

if ($Force -and (Test-Path $pythonRuntimeDir)) {
    Write-Host "[1/6] -Force: removing existing python-runtime..."
    Remove-Item $pythonRuntimeDir -Recurse -Force
}

if (Test-Path "$pythonRuntimeDir\python.exe") {
    Write-Host "[1/6] python-runtime already built (use -Force to rebuild)"
}
else {
    Write-Host "[1/6] Building Python $PythonVersion runtime..."
    New-Item -ItemType Directory -Path $pythonRuntimeDir -Force | Out-Null

    $embedZip = Join-Path $vendorDir "python-embed.zip"
    if (-not (Test-Path $embedZip)) {
        $url = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
        Write-Host "      Downloading $url"
        Invoke-WebRequest -Uri $url -OutFile $embedZip -UseBasicParsing
    }

    Write-Host "      Extracting embeddable..."
    Expand-Archive -Path $embedZip -DestinationPath $pythonRuntimeDir -Force

    # Embeddable Python ships with `import site` commented out in <ver>._pth.
    # Without uncommenting it, pip won't see anything in Lib\site-packages.
    $pthFile = Get-ChildItem -Path $pythonRuntimeDir -Filter "python*._pth" | Select-Object -First 1
    Write-Host "      Patching $($pthFile.Name) to enable site-packages..."
    (Get-Content $pthFile.FullName) -replace '#\s*import site', 'import site' |
        Set-Content $pthFile.FullName

    # Bootstrap pip
    $getPip = Join-Path $pythonRuntimeDir "get-pip.py"
    if (-not (Test-Path $getPip)) {
        Write-Host "      Downloading get-pip.py..."
        Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $getPip -UseBasicParsing
    }
    Write-Host "      Bootstrapping pip..."
    & "$pythonRuntimeDir\python.exe" $getPip --no-warn-script-location | Out-Null

    Write-Host "      Installing wheels (this is the slow step)..."
    $pipArgs = @("-m", "pip", "install", "--no-warn-script-location", "--no-cache-dir") + $wheels
    & "$pythonRuntimeDir\python.exe" @pipArgs
    if ($LASTEXITCODE -ne 0) { throw "pip install failed (exit $LASTEXITCODE)" }

    Remove-Item $getPip -Force -ErrorAction SilentlyContinue

    $size = "{0:N0}" -f ((Get-ChildItem $pythonRuntimeDir -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB)
    Write-Host "      python-runtime built ($size MB)"
}

# ---------- Step 2: Stage whisper-base model (cached) ----------

if (Test-Path "$bundledModelDir\openvino_encoder_model.xml") {
    Write-Host "[2/6] whisper-base already staged in vendor/"
}
else {
    $userModel = Join-Path $env:APPDATA "open-whispr\npu-models\whisper-base"
    if (-not (Test-Path "$userModel\openvino_encoder_model.xml")) {
        throw "whisper-base not found at $userModel — launch the app once with NPU+whisper-base selected to download it"
    }
    Write-Host "[2/6] Copying whisper-base from $userModel..."
    New-Item -ItemType Directory -Path $bundledModelDir -Force | Out-Null
    Copy-Item -Path "$userModel\*" -Destination $bundledModelDir -Recurse -Force
}

# ---------- Step 3: npm run pack ----------

if ($SkipPack) {
    if (-not (Test-Path "$winUnpackedDir\OpenWhispr.exe")) {
        throw "-SkipPack but $winUnpackedDir doesn't exist. Run without -SkipPack."
    }
    Write-Host "[3/6] -SkipPack: using existing dist/win-unpacked"
}
else {
    Write-Host "[3/6] Running npm run pack..."
    Push-Location $repoRoot
    try {
        npm run pack 2>&1 | ForEach-Object {
            # Don't fail on the cosmetic winCodeSign symlink errors —
            # the unpacked folder is still produced correctly.
            $_
        }
    }
    finally { Pop-Location }
    if (-not (Test-Path "$winUnpackedDir\OpenWhispr.exe")) {
        throw "npm run pack did not produce $winUnpackedDir\OpenWhispr.exe"
    }
}

# ---------- Step 4: Inject python-runtime ----------

$bundlePythonDest = Join-Path $winUnpackedDir "resources\python-runtime"
if (Test-Path $bundlePythonDest) {
    Remove-Item $bundlePythonDest -Recurse -Force
}
Write-Host "[4/6] Injecting python-runtime into resources/..."
Copy-Item -Path $pythonRuntimeDir -Destination $bundlePythonDest -Recurse -Force

# ---------- Step 5: Inject npu-models/whisper-base ----------

$bundleModelDest = Join-Path $winUnpackedDir "resources\npu-models\whisper-base"
if (Test-Path $bundleModelDest) {
    Remove-Item $bundleModelDest -Recurse -Force
}
Write-Host "[5/6] Injecting whisper-base model..."
New-Item -ItemType Directory -Path (Split-Path $bundleModelDest -Parent) -Force | Out-Null
Copy-Item -Path $bundledModelDir -Destination $bundleModelDest -Recurse -Force

# ---------- Step 5b: Inject launcher (Setup-OpenWhispr.bat + README.txt) ----------

$launcherSrc = Join-Path $repoRoot "scripts\launcher"
Write-Host "[5b/6] Injecting launcher script + README..."
Copy-Item -Path (Join-Path $launcherSrc "Setup-OpenWhispr.bat") -Destination $winUnpackedDir -Force
Copy-Item -Path (Join-Path $launcherSrc "README.txt") -Destination $winUnpackedDir -Force

# ---------- Step 6: Zip ----------

Write-Host "[6/6] Zipping bundle..."
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
if (Test-Path $outputZip) { Remove-Item $outputZip -Force }
Compress-Archive -Path "$winUnpackedDir\*" -DestinationPath $outputZip -CompressionLevel Optimal

$sizeMb = [math]::Round((Get-Item $outputZip).Length / 1MB, 1)
Write-Host ""
Write-Host "Bundle: $outputZip ($sizeMb MB)"
Write-Host ""
Write-Host "Recipient instructions:"
Write-Host "  1. Unzip into a writable location (e.g. %LOCALAPPDATA%\Programs\OpenWhispr)"
Write-Host "  2. Run OpenWhispr.exe"
Write-Host "  3. In onboarding: pick 'Intel NPU' and 'whisper-base' — no downloads needed"
