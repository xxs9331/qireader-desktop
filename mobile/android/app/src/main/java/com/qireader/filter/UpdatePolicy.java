package com.qireader.filter;

import java.net.URI;

final class UpdatePolicy {
    static final String BASE = "https://download.swlyes.top/updates/qireader-filter/";
    static final String MANIFEST = BASE + "latest.json";
    static boolean releaseAsset(String value) {
        try {
            URI uri = URI.create(value);
            return "https".equals(uri.getScheme()) && "download.swlyes.top".equals(uri.getHost()) && uri.getUserInfo() == null &&
                uri.getPort() == -1 && uri.getQuery() == null && uri.getFragment() == null &&
                uri.getPath().matches("/updates/qireader-filter/QiReader-Filter-[0-9]+\\.[0-9]+\\.[0-9]+\\.apk");
        } catch (IllegalArgumentException exception) { return false; }
    }
    static boolean redirect(String value) {
        try {
            URI uri = URI.create(value);
            return "https".equals(uri.getScheme()) && uri.getUserInfo() == null && uri.getPort() == -1 &&
                (releaseAsset(value) || MANIFEST.equals(value));
        } catch (IllegalArgumentException exception) { return false; }
    }
}
