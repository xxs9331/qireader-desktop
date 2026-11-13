package com.qireader.filter;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.widget.Toast;
import androidx.core.content.FileProvider;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;

final class Updates {
    static final int INSTALL_PERMISSION = 18;
    private final Activity activity;
    private boolean busy;
    private File pending;
    private int expectedVersion;
    Updates(Activity activity) { this.activity = activity; }

    private void ui(Runnable action) { activity.runOnUiThread(() -> { if (!activity.isFinishing() && !activity.isDestroyed()) action.run(); }); }
    private void toast(String message) { ui(() -> Toast.makeText(activity, message, Toast.LENGTH_LONG).show()); }
    private HttpURLConnection connect(String address) throws Exception {
        for (int i = 0; i < 5; i++) {
            if (!UpdatePolicy.redirect(address)) throw new Exception("更新下载地址无效");
            HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
            connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(15000); connection.setReadTimeout(30000);
            connection.setUseCaches(false); connection.setRequestProperty("Cache-Control", "no-cache");
            connection.setRequestProperty("User-Agent", "QiReader-Filter-Android"); connection.setRequestProperty("Accept", "application/json");
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) {
                String next = connection.getHeaderField("Location"); connection.disconnect();
                if (next == null) throw new Exception("更新重定向无效");
                address = next; continue;
            }
            if (status != 200) { connection.disconnect(); throw new Exception("更新服务暂不可用（HTTP " + status + "）"); }
            return connection;
        }
        throw new Exception("更新重定向次数过多");
    }
    private String json(String address) throws Exception {
        HttpURLConnection connection = connect(address);
        try (InputStream stream = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096]; int read;
            while ((read = stream.read(buffer)) != -1) {
                if (output.size() + read > 256 * 1024) throw new Exception("更新信息过大");
                output.write(buffer, 0, read);
            }
            return output.toString("UTF-8");
        } finally { connection.disconnect(); }
    }
    void check(boolean manual) {
        if (busy) { if (manual) toast("正在检查或下载更新"); return; }
        busy = true;
        if (manual) toast("正在检查更新");
        new Thread(() -> {
            try {
                JSONObject info = new JSONObject(json(UpdatePolicy.MANIFEST));
                int installed = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionCode;
                if (info.getInt("versionCode") <= installed) { if (manual) toast("当前已是最新版本"); }
                else {
                    if (!UpdatePolicy.releaseAsset(info.getString("url")) || !info.getString("sha256").matches("[a-f0-9]{64}") || !info.getString("versionName").matches("[0-9]+\\.[0-9]+\\.[0-9]+")) throw new Exception("更新信息无效");
                    ui(() -> new AlertDialog.Builder(activity).setMessage("发现新版本 " + info.optString("versionName"))
                        .setPositiveButton("下载更新", (dialog, which) -> download(info)).setNegativeButton("稍后", null).show());
                }
            } catch (Exception exception) { if (manual) toast("检查更新失败，请稍后重试"); }
            finally { ui(() -> busy = false); }
        }, "qireader-update-check").start();
    }
    private void download(JSONObject info) {
        if (busy) return;
        busy = true; toast("正在下载更新");
        new Thread(() -> {
            File partial = null;
            try {
                File directory = new File(activity.getCacheDir(), "updates");
                if (!directory.isDirectory() && !directory.mkdirs()) throw new Exception("无法创建更新目录");
                partial = new File(directory, "update.part");
                HttpURLConnection connection = connect(info.getString("url"));
                MessageDigest digest = MessageDigest.getInstance("SHA-256"); long size = 0;
                try (InputStream stream = connection.getInputStream(); FileOutputStream output = new FileOutputStream(partial)) {
                    byte[] buffer = new byte[32768]; int read;
                    while ((read = stream.read(buffer)) != -1) {
                        size += read; if (size > 32 * 1024 * 1024) throw new Exception("更新包过大");
                        digest.update(buffer, 0, read); output.write(buffer, 0, read);
                    }
                } finally { connection.disconnect(); }
                StringBuilder hash = new StringBuilder();
                for (byte value : digest.digest()) hash.append(String.format(Locale.ROOT, "%02x", value & 255));
                if (!hash.toString().equals(info.getString("sha256"))) throw new Exception("更新包校验失败");
                expectedVersion = info.getInt("versionCode"); verify(partial);
                File ready = new File(directory, "update.apk");
                if (!partial.renameTo(ready)) throw new Exception("无法保存更新包");
                pending = ready; ui(this::install);
            } catch (Exception exception) { if (partial != null) partial.delete(); toast("更新失败：" + exception.getMessage()); }
            finally { ui(() -> busy = false); }
        }, "qireader-update-download").start();
    }
    private Signature[] signatures(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? info.signingInfo.getApkContentsSigners() : info.signatures;
    }
    private void verify(File file) throws Exception {
        PackageManager manager = activity.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo current = manager.getPackageInfo(activity.getPackageName(), flags);
        PackageInfo archive = manager.getPackageArchiveInfo(file.getPath(), flags);
        if (archive == null || !current.packageName.equals(archive.packageName) || archive.versionCode != expectedVersion || archive.versionCode <= current.versionCode ||
            !Arrays.equals(signatures(current), signatures(archive))) throw new Exception("更新包应用身份或签名不匹配");
    }
    void install() {
        if (pending == null || !pending.isFile()) return;
        try {
            verify(pending);
            if (!activity.getPackageManager().canRequestPackageInstalls()) {
                activity.startActivityForResult(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.getPackageName())), INSTALL_PERMISSION); return;
            }
            Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".updates", pending);
            activity.startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
        } catch (Exception exception) { toast("无法安装更新：" + exception.getMessage()); }
    }
}
