package com.qireader.filter;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.util.Arrays;

public final class MainActivity extends Activity {
    private static final Set<String> ORIGINS = new HashSet<>(Arrays.asList("https://www.qireader.com", "https://www.qireader.com.cn"));
    private WebView web;
    private View shade;
    private TextView error;
    private SharedPreferences prefs;
    private String account = "";
    private String origin = "https://www.qireader.com";
    private boolean storageFailed;
    private Updates updates;

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private TextView text(String value, int size) {
        TextView view = new TextView(this);
        view.setText(value); view.setTextSize(size); view.setGravity(Gravity.CENTER);
        view.setPadding(dp(16), dp(12), dp(16), dp(12));
        return view;
    }
    private String pageOrigin(String url) {
        if (url == null) return "";
        Uri uri = Uri.parse(url);
        String value = uri.getScheme() + "://" + uri.getAuthority();
        return ORIGINS.contains(value) ? value : "";
    }
    private Round round() {
        return new Round(prefs.getInt("target", 5), prefs.getStringSet("round:" + account, Collections.emptySet()));
    }
    private JSONObject state() throws Exception {
        Round value = round();
        return new JSONObject().put("target", value.target).put("count", account.isEmpty() ? 0 : value.ids.size())
            .put("blocked", storageFailed || !account.isEmpty() && value.complete());
    }
    private void showState() {
        try {
            JSONObject value = state();
            shade.setVisibility(value.getBoolean("blocked") ? View.VISIBLE : View.GONE);
            web.setImportantForAccessibility(value.getBoolean("blocked") ? View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS : View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
            web.evaluateJavascript("window.qiFilter?.update(" + value + ")", null);
        } catch (Exception exception) { fail("本地进度无法读取，请勿继续添加"); }
    }
    private void fail(String message) {
        error.setText(message); error.setVisibility(View.VISIBLE);
    }
    private void continueRound() {
        if (account.isEmpty() || storageFailed) return;
        if (!prefs.edit().putStringSet("round:" + account, new HashSet<>()).commit()) {
            fail("进度保存失败，请检查手机存储后重试"); return;
        }
        showState();
    }

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        prefs = getSharedPreferences("filter", MODE_PRIVATE);
        String savedOrigin = prefs.getString("origin", origin);
        if (ORIGINS.contains(savedOrigin)) origin = savedOrigin;
        FrameLayout root = new FrameLayout(this);
        LinearLayout column = new LinearLayout(this); column.setOrientation(LinearLayout.VERTICAL);
        root.addView(column, new FrameLayout.LayoutParams(-1, -1));
        error = text("", 13); error.setTextColor(0xff993333); error.setVisibility(View.GONE);
        error.setOnClickListener(v -> new AlertDialog.Builder(this).setItems(new String[]{"重试", "设置"}, (dialog, choice) -> {
            if (choice == 0) { error.setVisibility(View.GONE); web.reload(); } else settings();
        }).show()); column.addView(error);
        web = new WebView(this); column.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        LinearLayout overlay = new LinearLayout(this); overlay.setOrientation(LinearLayout.VERTICAL); overlay.setGravity(Gravity.CENTER);
        overlay.setBackgroundColor(0x99000000); overlay.setClickable(true); overlay.setFocusable(true);
        TextView complete = text("本轮完成", 20); complete.setTextColor(Color.WHITE); overlay.addView(complete);
        TextView next = text("继续", 15); next.setTextColor(Color.WHITE); next.setFocusable(true); next.setOnClickListener(v -> continueRound());
        GradientDrawable border = new GradientDrawable(); border.setColor(Color.TRANSPARENT); border.setStroke(dp(1), 0x99ffffff); border.setCornerRadius(dp(4)); next.setBackground(border);
        overlay.addView(next); shade = overlay; shade.setVisibility(View.GONE); root.addView(shade, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        updates = new Updates(this);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        web.getSettings().setJavaScriptEnabled(true); web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false); web.getSettings().setAllowContentAccess(false);
        web.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.getSettings().setSupportMultipleWindows(false);
        web.setOnLongClickListener(v -> !account.isEmpty());
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                String url = request.getUrl().toString();
                String path = request.getUrl().getPath();
                if (pageOrigin(url).isEmpty() || path != null && (path.contains("/entries/") || path.contains("/tags/"))) return true;
                return shade.getVisibility() == View.VISIBLE;
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                account = ""; showState();
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError detail) {
                if (request.isForMainFrame()) fail("页面加载失败，点此重试");
            }
            @Override public void onPageFinished(WebView view, String url) { CookieManager.getInstance().flush(); }
        });
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            fail("请先更新 Android System WebView 或 Chrome，再重新打开应用"); return;
        }
        WebViewCompat.addWebMessageListener(web, "qireaderMobile", ORIGINS, (view, message, source, mainFrame, reply) -> {
            if (!mainFrame || !ORIGINS.contains(source.toString()) || !source.toString().equals(pageOrigin(web.getUrl()))) return;
            JSONObject result = new JSONObject();
            try {
                String raw = message.getData();
                if (raw == null || raw.length() > 4096) return;
                JSONObject input = new JSONObject(raw);
                result.put("request", input.getInt("request"));
                String action = input.getString("action");
                String user = input.optString("user", "");
                if (user.length() > 512) throw new IllegalArgumentException("账号无效");
                String key = user.isEmpty() ? "" : source + "|" + user;
                if (action.equals("ready")) account = key;
                else if (action.equals("settings")) settings();
                else if (action.equals("saved")) {
                    if (account.isEmpty() || !account.equals(key)) throw new IllegalArgumentException("账号已变更，请重新点击文章");
                    Round value = round().add(input.getString("id"));
                    if (!prefs.edit().putStringSet("round:" + account, value.ids).commit()) {
                        storageFailed = true; throw new IllegalStateException("本地进度保存失败，请检查手机存储");
                    }
                } else if (action.equals("error")) {
                    String detail = input.optString("message", "添加失败，请重试");
                    Toast.makeText(this, detail.substring(0, Math.min(160, detail.length())), Toast.LENGTH_LONG).show();
                } else throw new IllegalArgumentException("未知操作");
                result.put("ok", true).put("state", state());
            } catch (Exception exception) {
                try { result.put("ok", false).put("error", exception.getMessage()); } catch (Exception ignored) { }
            }
            showState(); reply.postMessage(result.toString());
        });
        try {
            String script;
            try (java.io.InputStream stream = getAssets().open("filter.js"); java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192]; int read;
                while ((read = stream.read(buffer)) != -1) output.write(buffer, 0, read);
                script = output.toString(StandardCharsets.UTF_8.name());
            }
            WebViewCompat.addDocumentStartJavaScript(web, script, ORIGINS);
            web.loadUrl(origin + "/");
            updates.check(false);
        } catch (Exception exception) { fail("筛选脚本加载失败，请重新安装应用"); }
    }

    private void settings() {
        LinearLayout content = new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL); content.setPadding(dp(24), 0, dp(24), 0);
        EditText target = new EditText(this); target.setInputType(InputType.TYPE_CLASS_NUMBER); target.setText(String.valueOf(prefs.getInt("target", 5))); target.setSelectAllOnFocus(true);
        content.addView(text("每轮加入稍后阅读的篇数（1–100）", 14)); content.addView(target);
        TextView update = text("检查更新", 14); update.setOnClickListener(v -> updates.check(true)); content.addView(update);
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("每轮数量").setView(content)
            .setPositiveButton("保存", null).setNegativeButton("取消", null)
            .setNeutralButton("切换站点", (d, w) -> new AlertDialog.Builder(this).setItems(new String[]{"qireader.com", "qireader.com.cn"}, (choice, index) -> {
                origin = index == 0 ? "https://www.qireader.com" : "https://www.qireader.com.cn";
                if (prefs.edit().putString("origin", origin).commit()) web.loadUrl(origin + "/"); else fail("设置保存失败");
            }).show()).create();
        dialog.setOnShowListener(d -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            try {
                int value = Integer.parseInt(target.getText().toString()); new Round(value, Collections.emptySet());
                if (!prefs.edit().putInt("target", value).commit()) throw new IllegalStateException("设置保存失败");
                dialog.dismiss(); showState();
            } catch (Exception exception) { target.setError("请输入 1–100 的整数"); }
        })); dialog.show();
    }
    @Override public void onBackPressed() {
        if (shade.getVisibility() == View.VISIBLE) { continueRound(); return; }
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }
    @Override protected void onPause() { super.onPause(); web.onPause(); CookieManager.getInstance().flush(); }
    @Override protected void onResume() { super.onResume(); if (web != null) { web.onResume(); web.evaluateJavascript("window.qiFilter?.refresh()", null); } }
    @Override protected void onActivityResult(int request, int result, android.content.Intent data) {
        super.onActivityResult(request, result, data);
        if (request == Updates.INSTALL_PERMISSION && updates != null && getPackageManager().canRequestPackageInstalls()) updates.install();
    }
    @Override protected void onDestroy() { web.destroy(); super.onDestroy(); }
}
