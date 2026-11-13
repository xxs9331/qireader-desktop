# 订阅筛选 · Android 0.1.5

手机端只做一件事：浏览 QiReader 订阅，点击文章加入稍后阅读。默认每轮成功添加 5 篇，在「设置」中可改为 1–100 篇。没有阅读器、收藏、日／周统计或进度条。

顶部只保留 QiReader 原来的导航栏，在同一栏内显示本轮灯和设置入口，成功添加一篇亮一盏。设置数量后灯数同步调整。登录页等没有原生导航的页面才使用临时单栏，原生导航出现就自动合并；页面加载失败时仍可从错误提示进入设置。

灯和设置只挂到屏幕内的主导航，排除收起的侧栏，并预留右侧空间防止被裁剪；目标较多时灯列可横向滑动。系统状态栏固定黑底、白色时间和信号图标，不随网页主题改变。状态栏、刘海和键盘区域通过系统 Insets 留出空间。

自动添加需要使用原生菜单时，整个菜单及退场动画保持隐藏；文章点击高亮、长按菜单也被抑制，避免点击出现右键菜单残影。

满一轮后原窗口变暗，默认只显示「本轮完成」和「返回桌面」。在「设置 → 本轮完成后」可选择：仅显示返回桌面、显示返回桌面和继续、3 秒后自动进入下一轮。自动模式保留返回桌面按钮；重复刷新进度不延长计时，进入后台、打开设置或账号变更会取消原计时，重新显示休息页时从 3 秒开始，不在后台重置进度。

点击「返回桌面」会先保存本轮重置，再调用手机主页，回来即可直接开始下一轮，不必再次确认。保存失败时不会跳转。点击继续或手机返回键也能开始下一轮。连续点击不会把排队的添加带入下一轮；重复、已保存、失败和未获服务器确认的操作都不计数。数量设置、休息页模式、本轮进度和登录保存在手机；同一账号加入的稍后阅读通过 QiReader 同步到桌面，手机轮次不与桌面计数混用。

## 安装与更新

首次从 [OSS 国内直链](https://download.swlyes.top/updates/qireader-filter/QiReader-Filter-0.1.5.apk) 下载 APK 安装，打开后登录自己的 QiReader 账号即可。可在设置中切换 qireader.com／qireader.com.cn，两站的账号轮次分开保存。

应用启动时自动检查版本，也可在「设置 → 检查更新」手动检查。有新版时点击下载，应用校验 SHA-256、包名、版本号与现有签名，然后调起系统安装页面。首次更新可能需要允许本应用安装更新；取消该权限不会反复跳转。之后仍需按 Android 的系统要求确认安装，无需自行寻找、搬运 APK，也不要先卸载旧版。

从 0.1.2 开始，更新检查和 APK 下载都走阿里云 OSS 国内域名，入口为 [latest.json](https://download.swlyes.top/updates/qireader-filter/latest.json)，不再依赖 GitHub。更新检查不携带 QiReader 的登录 Cookie。

0.1.0／0.1.1 的旧更新器写死了 GitHub 地址，因此保留一个同签名 0.1.2 的 GitHub 迁移包，以及固定指向它的 [旧更新指针](android/update.json)。旧版可先从应用内升级一次；如果 GitHub 连不上，可使用上面的 OSS 直链覆盖安装一次。升级后后续版本全部走 OSS。旧指针保持在 0.1.2，不随以后的 OSS 版本改变。

## 运行要求与边界

Android 8.0 及以上，并使用较新的 Android System WebView／Chrome。应用会在缺少所需 WebView 能力时明确提示更新，避免在无法限制网页桥接来源的环境中降级运行。

采用官方 QiReader 网页完成登录和订阅导航，在页面创建之初接入点击筛选。保留订阅源导航；拦截文章阅读入口，隐藏列表内的阅读／收藏操作。不会自动开启「滚动标记已读」。仅在官方两个 HTTPS 来源的主框架接收有限的计数消息；不开启文件访问，不对任意网页暴露原生接口。

原生控件和移动端网页结构可能随 QiReader 更新；无法确定已保存状态或服务器未确认时宁可停止添加并提示，不盲目切换或增加进度。第三方弹窗登录未做适配，优先使用站内登录。

## 构建与发布

使用 JDK 17+、Android SDK 36、Build Tools 36.0.0。仓库含 Gradle 8.14 wrapper，首次构建需下载官方依赖。

```sh
cd mobile/android
./gradlew :app:testDebugUnitTest :app:lintRelease :app:assembleRelease
```

Release 签名从 `$QIREADER_SIGNING_DIR` 读取，默认是 `~/.local/share/qireader-filter/signing/`，包含 `release.jks` 与 `password` 两个私有文件，alias 为 `qireader-filter`。**私钥和密码不得提交或上传，必须安全备份；后续更新必须沿用同一私钥。** 未配置签名时不能生成可供原应用覆盖安装的正式包。

修改 Android versionCode 和 versionName 后，构建、验收，再准备更新产物：

```sh
ANDROID_HOME=/path/to/android-sdk node scripts/prepare-mobile-release.cjs
```

脚本验证固定发布签名，生成 `artifacts/android-<版本>/` 下的 APK、latest.json、android-update.json 和 SHA256SUMS。发布到已有 `xxs-apk` 桶的独立 `updates/qireader-filter/` 前缀：

```sh
ANDROID_HOME=/path/to/android-sdk node scripts/publish-mobile.cjs
```

发布器使用本机 ossutil 的私有凭据，不将 AccessKey 放进源码或 APK。先上传不可覆盖的版本 APK、校验文件和版本元数据，逐一通过国内公开地址回读校验 SHA-256，成功后才推进 latest.json，并再次回读确认；拒绝降级或修改已经发布的同一版本。版本文件长期缓存，latest.json 使用 no-cache/no-store。其他应用前缀和桶配置保持不动。

以后只需更新版本、构建验收并运行发布器；不必再往 GitHub 上传 APK。Git 仍用于同步源码。0.1.2 额外保留的 GitHub 包仅用于旧更新器迁移。

筛选脚本回归用隔离的手机尺寸浏览器运行，不连接真实账号：

```sh
QIREADER_PLAYWRIGHT=/path/to/playwright QIREADER_CHROME=/path/to/chrome npm run test:mobile
```

Android 单元测试覆盖计数、更新来源和休息页计时，发布前运行 Release lint 和签名 APK 构建。此前已通过手机尺寸浏览器的成功确认／重复／已保存／失败重试／原生菜单／满轮队列停止／账号隔离／重载恢复回归。APK 签名由发布器验证。

当前没有连接 Android 真机或模拟器，尚未实测真机登录、移动网页控件和从旧版覆盖安装。浏览器模拟回归不等于真机验收。设计沿用[用户界面偏好](../docs/design-preferences.zh-CN.md)。
