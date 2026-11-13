# 订阅筛选 · Android 0.1.0

手机端只做一件事：浏览 QiReader 订阅，点击文章加入稍后阅读。默认每轮成功添加 5 篇，在「设置」中可改为 1–100 篇。没有阅读器、收藏、日／周统计或进度条。

满一轮后原窗口变暗，仅显示「本轮完成」和「继续」。点击继续或手机返回键后开始下一轮。连续点击不会把排队的添加带入下一轮；重复、已保存、失败和未获服务器确认的操作都不计数。数量设置、本轮进度和登录保存在手机；同一账号加入的稍后阅读通过 QiReader 同步到桌面，手机轮次不与桌面计数混用。

## 安装与更新

首次从 [Android 发布页](https://github.com/xxs9331/qireader-desktop/releases/tag/android-v0.1.0) 下载 APK 安装，打开后登录自己的 QiReader 账号即可。可在设置中切换 qireader.com／qireader.com.cn，两站的账号轮次分开保存。

应用启动时自动检查版本，也可在「设置 → 检查更新」手动检查。有新版时点击下载，应用校验 SHA-256、包名、版本号与现有签名，然后调起系统安装页面。首次更新可能需要允许本应用安装更新；取消该权限不会反复跳转。之后仍需按 Android 的系统要求确认安装，无需自行寻找、搬运 APK，也不要先卸载旧版。

更新元数据位于 [android/update.json](android/update.json)，更新包托管在同一 GitHub 仓库的 Android Release，桌面发布不会覆盖手机更新渠道。访问 GitHub 失败时保留当前版本，可稍后重试。更新检查不携带 QiReader 的登录 Cookie。

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

脚本验证 APK 签名，生成 `artifacts/android-<版本>/` 下的 APK、android-update.json 和 SHA256SUMS，同时更新源码中的手机更新指针。准备好产物后创建 `android-v<版本>` Release 并上传三个文件，再推送更新指针；无需发布为桌面仓库的 latest。首次用户只需安装一次，以后从应用内更新。

筛选脚本回归用隔离的手机尺寸浏览器运行，不连接真实账号：

```sh
QIREADER_PLAYWRIGHT=/path/to/playwright QIREADER_CHROME=/path/to/chrome npm run test:mobile
```

已通过：5 项 Android 单元测试、Release lint、签名 APK 构建，以及手机尺寸浏览器的成功确认／重复／已保存／失败重试／原生菜单／满轮队列停止／账号隔离／重载恢复回归。APK 签名已用 apksigner 验证。

当前没有连接 Android 真机或模拟器，尚未实测真机登录、移动网页控件和从旧版覆盖安装。浏览器模拟回归不等于真机验收。设计沿用[用户界面偏好](../docs/design-preferences.zh-CN.md)。
