package com.qireader.filter;

import org.junit.Test;
import static org.junit.Assert.*;

public class UpdatePolicyTest {
    @Test public void acceptsOnlyThisAppsOssReleaseAssets() {
        String base = UpdatePolicy.BASE;
        assertTrue(UpdatePolicy.releaseAsset(base + "QiReader-Filter-0.1.0.apk"));
        for (String address : new String[]{base + "evil.apk", base.replace("https", "http") + "QiReader-Filter-0.1.0.apk", base.replace("download.swlyes.top", "download.swlyes.top.evil.test") + "QiReader-Filter-0.1.0.apk", base.replace("qireader-filter", "serial-reader") + "QiReader-Filter-0.1.0.apk", base + "QiReader-Filter-0.1.0.apk?other=1"}) assertFalse(address, UpdatePolicy.releaseAsset(address));
    }
    @Test public void limitsRedirectsToOurOssPrefix() {
        assertTrue(UpdatePolicy.redirect(UpdatePolicy.MANIFEST));
        assertFalse(UpdatePolicy.redirect(UpdatePolicy.BASE.replace("https", "http") + "latest.json"));
        assertFalse(UpdatePolicy.redirect("https://evil.test/asset"));
        assertFalse(UpdatePolicy.redirect("https://user@download.swlyes.top/updates/qireader-filter/latest.json"));
        assertFalse(UpdatePolicy.redirect("https://github.com/xxs9331/qireader-desktop/releases/download/android-v0.1.0/QiReader-Filter-0.1.0.apk"));
    }
}
