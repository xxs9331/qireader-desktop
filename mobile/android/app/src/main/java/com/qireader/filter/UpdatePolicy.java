package com.qireader.filter;

import java.net.URI;

final class UpdatePolicy {
    static boolean releaseAsset(String value) {
        try {
            URI uri = URI.create(value);
            return "https".equals(uri.getScheme()) && "github.com".equals(uri.getHost()) && uri.getUserInfo() == null &&
                uri.getPort() == -1 && uri.getQuery() == null && uri.getFragment() == null &&
                uri.getPath().matches("/xxs9331/qireader-desktop/releases/download/android-v[0-9]+\\.[0-9]+\\.[0-9]+/(android-update\\.json|QiReader-Filter-[0-9]+\\.[0-9]+\\.[0-9]+\\.apk)");
        } catch (IllegalArgumentException exception) { return false; }
    }
    static boolean redirect(String value) {
        try {
            URI uri = URI.create(value);
            return "https".equals(uri.getScheme()) && uri.getUserInfo() == null && uri.getPort() == -1 &&
                (releaseAsset(value) || "release-assets.githubusercontent.com".equals(uri.getHost()) || "objects.githubusercontent.com".equals(uri.getHost()));
        } catch (IllegalArgumentException exception) { return false; }
    }
}
