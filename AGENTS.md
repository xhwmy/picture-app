# AGENTS.md — picture-app 开发规范

## 项目概述

Android 图片压缩应用，基于 Capacitor + Preact + TypeScript，复用 picture-zip 的压缩逻辑。
核心功能：从相册选择图片 → 压缩（支持视觉无损 SSIM）→ 一键替换原图 / 另存到相册。

## 技术栈

- **前端**：Vite + Preact + TypeScript + 传统 CSS
- **原生**：Capacitor 6 + 自定义 PicturePlugin（Java）
- **压缩**：@jsquash（JPEG/PNG/WebP/AVIF）+ gifenc + gifuct-js + libheif-js
- **构建**：Gradle 8.2.1 + Android SDK 34 + JDK 17

## 目录结构

```
picture-app/
├── src/
│   ├── App.tsx              # 主界面（相册选择 + 压缩设置 + 图片列表 + 替换/另存）
│   ├── main.tsx             # Preact 入口
│   ├── styles.css           # 移动端暗色主题样式
│   ├── lib/                 # 压缩逻辑（从 picture-zip 复用）
│   │   ├── ssim.ts          # SSIM 感知质量计算
│   │   ├── visuallyLossless.ts  # 视觉无损压缩（二分搜索最低质量）
│   │   ├── compress.ts      # 压缩入口
│   │   ├── codecs.ts        # 编解码器
│   │   ├── codecs-dom.ts    # DOM 相关编解码
│   │   ├── types.ts         # 类型定义
│   │   ├── targetSize.ts    # 目标大小计算
│   │   └── format.ts        # 格式工具
│   ├── workers/
│   │   └── compress.worker.ts  # Web Worker 压缩
│   └── native/
│       └── replacePlugin.ts # Capacitor 插件 TS 接口
├── android/
│   └── app/src/main/java/com/anxun/pictureapp/
│       ├── MainActivity.java   # 入口（注册 PicturePlugin）
│       └── PicturePlugin.java  # 自定义插件（pickImages/replaceImage/saveImage）
├── build-apk.ps1           # 一键构建脚本（自动递增版本号）
├── capacitor.config.ts     # Capacitor 配置
├── vite.config.ts
├── tsconfig.json
└── package.json
```

## Git 分支规范（必须遵守）

- `dev` 是日常开发分支，所有代码改动必须在 dev 分支上进行
- `master` 是发布分支，只通过合并 dev 更新，**禁止直接在 master 上开发**
- 远程仓库：`git@github.com:xhwmy/picture-app.git`

### 推送流程（强制顺序）

1. 在 dev 分支提交改动：
   ```
   git add <files>
   git commit -m "<type>: <描述>"
   git push origin dev
   ```
2. 用 master 分支合并 dev 分支：
   ```
   git checkout master
   git pull origin master
   git merge dev
   git push origin master
   git checkout dev
   ```
3. 保持本地 dev 与 master 同步，最后切回 dev 继续开发

### 提交信息规范

格式：`<type>: <简短描述>`

- `feat:` 新功能
- `fix:` 缺陷修复
- `refactor:` 重构（不改行为）
- `change:` 配置/流程变更
- `add:` 新增文件或配置

### 版本号规则（必须遵守）

版本号格式：`整数位.两位小数`（如 2.0、2.01）

- **大版本 = 功能更新 / 性能优化 / UI 改版** → 整数位 +1，小数归零：1.9 → 2.0 → 3.0（`build-apk.ps1 -minor`）
- **小版本 = 修大版本改动造成的 Bug** → 两位小数 +1：2.0 → 2.01 → 2.02（`build-apk.ps1` 默认）
- 小版本最多递增到 .09，若超过则提前进入下一个大版本（2.09 → 3.0）
- `versionCode` 始终 +1，`versionName` 按上述规则递增

### 自动提交规则（必须遵守）

- **每次代码改动完成后自动提交到 GitHub**，不需要用户提醒
- 按版本号规则更新版本号（功能更新用 `-minor`，bug 修复用默认 patch）
- 遵循 dev → master 推送流程
- 提交前确认 vite build 通过

### 注意事项

- **禁止 amend + force push**（会导致 master/dev 历史分叉）
- 不要直接推 `main` 分支（本项目没有 main，主分支是 master）
- 合并前确认工作区干净，避免把无关改动带进提交

## 代码风格

- camelCase 变量、PascalCase 组件文件
- Preact hooks（useState / useCallback / useEffect / useRef）
- 最小改动 + 可验证
- 不加注释（除非逻辑特别复杂）

## 构建与部署

### 环境要求

- JDK 17：`C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot\`
- Android SDK：`%LOCALAPPDATA%\Android\Sdk`（platform-tools + platforms;android-34 + build-tools;34.0.0）
- Gradle 8.2.1：`C:\gradle-8.2.1\bin\gradle.bat`

### 一键构建（推荐）

```powershell
# patch 版本: 1.3 → 1.3.1（默认）
powershell -ExecutionPolicy Bypass -File D:\picture-app\build-apk.ps1

# minor 版本: 1.3 → 1.4
powershell -ExecutionPolicy Bypass -File D:\picture-app\build-apk.ps1 -minor

# major 版本: 1.3 → 2.0
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

把 APK 传到手机（微信/QQ/数据线），点击安装即可。首次打开会弹存储权限申请。

## 版本号管理

- `android/app/build.gradle` 中 `versionCode`（整数递增）和 `versionName`（如 "1.3"）
- `package.json` 中 `version` 字段同步更新
- 构建脚本 `build-apk.ps1` 自动处理

## Capacitor 插件（PicturePlugin）

### 插件方法

| 方法 | 功能 |
|------|------|
| `requestPermissions()` | 申请存储/读写权限（App 启动时调用） |
| `pickImages()` | 调用 ACTION_OPEN_DOCUMENT 选择图片，返回 contentUri + base64 |
| `replaceImage(contentUri, base64, mimeType)` | 覆盖写入原图，遇 RecoverableSecurityException 弹授权对话框 |
| `saveImage(base64, mimeType, displayName)` | 保存新图片到 MediaStore（Pictures/PictureCompress） |

### 替换原图权限流程

1. 点击"替换原图" → JS 层 confirm 说明
2. 调用 `replaceImage` → 尝试 openOutputStream
3. 遇 `RecoverableSecurityException` → `PendingIntent.send()` 弹系统授权
4. 授权回调延迟 500ms → 重试写入（避免权限缓存未更新导致首次失败）

## 相关项目

- **picture-zip**：Web 版图片压缩工具（Astro + Preact），部署在 Cloudflare Pages
  - 仓库：`git@github.com:xhwmy/picture-zip.git`
  - 线上：https://picture-zip.pages.dev/
  - 压缩逻辑从 picture-zip 的 `src/lib/` 复用