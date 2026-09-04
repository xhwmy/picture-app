# build-apk.ps1 — 递增版本号 + 构建 APK
# 用法: powershell -ExecutionPolicy Bypass -File build-apk.ps1
# 可传参数: -major 或 -minor 或 -patch（默认 patch）
#   -patch: 1.0 -> 1.0.1  (默认)
#   -minor: 1.0 -> 1.1
#   -major: 1.0 -> 2.0

param(
    [switch]$major,
    [switch]$minor,
    [switch]$patch
)

$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$gradleFile = Join-Path $projectDir "android\app\build.gradle"

# 读取当前版本
$content = Get-Content $gradleFile -Raw
if ($content -match 'versionCode\s+(\d+)') { $currentCode = [int]$Matches[1] }
if ($content -match 'versionName\s+"([^"]+)"') { $currentName = $Matches[1] }

Write-Host "当前版本: v$currentName (code=$currentCode)" -ForegroundColor Cyan

# 解析版本号
$parts = $currentName.Split('.')
$vMajor = [int]$parts[0]
$vMinor = if ($parts.Length -gt 1) { [int]$parts[1] } else { 0 }
$vPatch = if ($parts.Length -gt 2) { [int]$parts[2] } else { 0 }

# 递增
if ($major) {
    $vMajor++; $vMinor = 1; $vPatch = 0
} elseif ($minor) {
    $vMinor++; $vPatch = 0
} else {
    $vPatch++
}

$newName = if ($vPatch -gt 0) { "$vMajor.$vMinor.$vPatch" } else { "$vMajor.$vMinor" }
$newCode = $currentCode + 1

Write-Host "新版本: v$newName (code=$newCode)" -ForegroundColor Green

# 更新 build.gradle
$content = $content -replace 'versionCode\s+\d+', "versionCode $newCode"
$content = $content -replace 'versionName\s+"[^"]+"', "versionName `"$newName`""
Set-Content $gradleFile $content -NoNewline

# 更新 package.json
$pkgFile = Join-Path $projectDir "package.json"
$pkg = Get-Content $pkgFile -Raw | ConvertFrom-Json
$pkg.version = $newName
$pkg | ConvertTo-Json -Depth 10 | Set-Content $pkgFile

Write-Host "`n[1/4] 构建 Web assets..." -ForegroundColor Yellow
Push-Location $projectDir
npx vite build 2>&1 | Out-Null
if (-not $?) { Write-Host "Web 构建失败" -ForegroundColor Red; Pop-Location; exit 1 }
Pop-Location

Write-Host "[2/4] 同步 Capacitor..." -ForegroundColor Yellow
Push-Location $projectDir
npx cap sync android 2>&1 | Out-Null
if (-not $?) { Write-Host "Cap sync 失败" -ForegroundColor Red; Pop-Location; exit 1 }
Pop-Location

Write-Host "[3/4] 构建 APK..." -ForegroundColor Yellow
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$androidDir = Join-Path $projectDir "android"
$result = cmd /c "cd /d `"$androidDir`" && C:\gradle-8.2.1\bin\gradle.bat assembleDebug --no-daemon 2>&1" | Select-String "BUILD SUCCESSFUL|BUILD FAILED"
if ($result -match "FAILED") { Write-Host "APK 构建失败" -ForegroundColor Red; exit 1 }

Write-Host "[4/4] 完成!" -ForegroundColor Green
$apk = Join-Path $androidDir "app\build\outputs\apk\debug\app-debug.apk"
$size = [math]::Round((Get-Item $apk).Length / 1MB, 1)
Write-Host "`nAPK: $apk" -ForegroundColor Cyan
Write-Host "大小: $size MB" -ForegroundColor Cyan
Write-Host "版本: v$newName" -ForegroundColor Cyan