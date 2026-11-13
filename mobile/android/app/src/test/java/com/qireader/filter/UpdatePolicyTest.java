package com.qireader.filter;

import org.junit.Test;
import static org.junit.Assert.*;

public class UpdatePolicyTest {
    @Test public void acceptsOnlyThisReposAndroidReleaseAssets() {
        String base = "https://github.com/xxs9331/qireader-desktop/releases/download/android-v0.1.0/";
        assertTrue(UpdatePolicy.releaseAsset(base + "android-update.json"));
        assertTrue(UpdatePolicy.releaseAsset(base + "QiReader-Filter-0.1.0.apk"));
        for (String address : new String[]{base + "evil.apk", base.replace("https", "http") + "android-update.json", base.replace("github.com", "github.com.evil.test") + "android-update.json", base.replace("xxs9331", "someone") + "android-update.json", base + "android-update.json?other=1"}) assertFalse(address, UpdatePolicy.releaseAsset(address));
    }
    @Test public void limitsRedirectsToHttpsGithubReleaseHosts() {
        assertTrue(UpdatePolicy.redirect("https://release-assets.githubusercontent.com/asset?signature=value"));
        assertFalse(UpdatePolicy.redirect("http://release-assets.githubusercontent.com/asset"));
        assertFalse(UpdatePolicy.redirect("https://evil.test/asset"));
        assertFalse(UpdatePolicy.redirect("https://user@release-assets.githubusercontent.com/asset"));
    }
}
