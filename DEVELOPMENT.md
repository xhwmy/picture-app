# picture-app 开发环境搭建

Windows 为主的开发环境清单与下载安装方法。按顺序装完即可一键构建 APK。

## 环境总览

| 组件 | 版本 | 用途 |
|------|------|------|
| Node.js | 18 LTS 或更高 | 前端构建（Vite + Preact + TypeScript） |
| JDK | 17 (Temurin) | Android 编译 |
| Android SDK | platform 34 / build-tools 34.0.0 | Android 编译与设备通信 |
| Gradle | 8.2.1 | Android 构建工具 |
| Capacitor | 6.x | Web ↔ 原生桥接（项目依赖自带 CLI） |

## 1. Node.js

下载：https://nodejs.org/zh-cn/download （选 LTS 版本，Windows Installer）

安装后验证：
```powershell
node -v
npm -v
```

## 2. JDK 17（Eclipse Temurin）

下载：https://adoptium.net/temurin/releases/?version=17&os=windows&arch=x64

选择 `.msi` 安装包，安装时勾选"Set JAVA_HOME variable"。

本项目预期路径：
```
C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot\
```

验证：
```powershell
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot"
& "$env:JAVA_HOME\bin\java" -version
```

注意：若机器同时装了 JDK 1.8，构建前务必显式设置 `JAVA_HOME` 指向 17，避免 PATH 冲突导致 Gradle 用错 JDK。

## 3. Android SDK

### 方式 A：Android Studio（推荐新手）

下载：https://developer.android.com/studio

安装后打开 → Settings → SDK Manager，勾选：
- Android SDK Platform 34
- Android SDK Build-Tools 34.0.0
- Android SDK Platform-Tools
- Android SDK Command-line Tools (latest)

默认安装路径：
```
%LOCALAPPDATA%\Android\Sdk
```

### 方式 B：仅命令行工具（轻量）

下载 commandline-tools：https://developer.android.com/studio#command-line-tools-only

解压到 `%LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest\`，然后用 sdkmanager 安装：
```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
& "$env:ANDROID_HOME\cmdline-tools\latest\bin\sdkmanager.bat" "platform-tools" "platforms;android-34" "build-tools;34.0.0"
```

验证：
```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
Test-Path "$env:ANDROID_HOME\platform-tools\adb.exe"
Test-Path "$env:ANDROID_HOME\platforms\android-34"
Test-Path "$env:ANDROID_HOME\build-tools\34.0.0"
```

## 4. Gradle 8.2.1

下载：https://services.gradle.org/distributions/gradle-8.2.1-bin.zip

解压到 `C:\gradle-8.2.1\`，确保存在：
```
C:\gradle-8.2.1\bin\gradle.bat
```

验证：
```powershell
C:\gradle-8.2.1\bin\gradle.bat -v
```

## 5. 环境变量配置

构建脚本会临时设置 `JAVA_HOME` 和 `ANDROID_HOME`，但建议也加到系统环境变量，方便手动操作：

```powershell
# 以管理员 PowerShell 运行
[System.Environment]::SetEnvironmentVariable("JAVA_HOME", "C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot", "Machine")
[System.Environment]::SetEnvironmentVariable("ANDROID_HOME", "$env:LOCALAPPDATA\Android\Sdk", "Machine")
```

## 6. 项目依赖安装

```powershell
cd D:\picture-app
npm install
```

Capacitor CLI 通过 `npx cap` 调用，无需全局安装。

## 7. 开发调试

### Web 端调试（浏览器）
```powershell
npm run dev
```

### Android 真机调试
1. 手机开启"开发者选项" → "USB 调试"
2. 数据线连接，验证：
   ```powershell
   & "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" devices
   ```
3. 同步资源到 Android 工程：
   ```powershell
   npx vite build
   npx cap sync android
   ```
4. 运行到设备：
   ```powershell
   npx cap run android
   ```

## 8. 构建 APK

### 一键构建（推荐）
```powershell
# patch 版本: 3.05 → 3.06（默认）
powershell -ExecutionPolicy Bypass -File D:\picture-app\build-apk.ps1

# minor 版本: 3.05 → 3.06（功能更新）
powershell -ExecutionPolicy Bypass -File D:\picture-app\build-apk.ps1 -minor

# major 版本: 3.05 → 4.0
powershell -ExecutionPolicy Bypass -File D:\picture-app\build-apk.ps1 -major
```

脚本自动完成：递增版本号 → vite build → cap sync → gradle assembleDebug

### 手动构建
```powershell
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"

npx vite build
npx cap sync android
cd android
C:\gradle-8.2.1\bin\gradle.bat assembleDebug --no-daemon
```

### APK 产物
```
D:\picture-app\android\app\build\outputs\apk\debug\app-debug.apk
```

### 安装到手机
把 APK 传到手机（微信/QQ/数据线），点击安装。首次打开会弹存储权限申请。

## 9. 环境自检清单

逐项确认无误后再开始构建：

- [ ] `node -v` 输出 18 或更高
- [ ] `JAVA_HOME` 指向 JDK 17，`java -version` 显示 17
- [ ] `ANDROID_HOME` 下存在 `platform-tools`、`platforms\android-34`、`build-tools\34.0.0`
- [ ] `C:\gradle-8.2.1\bin\gradle.bat -v` 显示 8.2.1
- [ ] `npm install` 已执行，`node_modules` 存在
- [ ] 手机已开 USB 调试且 `adb devices` 能列出设备（调试时）

## 常见问题

### Gradle 报 JDK 版本不对
显式设置 `JAVA_HOME` 指向 17，关闭旧 JDK 的 PATH 项，重开终端。

### sdkmanager 报 SDK XML version 4
属警告，不影响构建，可忽略。

### cap sync 报找不到 Android 工程
确认 `android/` 目录存在且 `cap sync android` 在项目根执行。

### 构建报 `Could not find tools.jar`
`JAVA_HOME` 指向了 JRE 而非 JDK，改为 JDK 17 路径。