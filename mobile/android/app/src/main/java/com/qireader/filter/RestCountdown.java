package com.qireader.filter;

final class RestCountdown {
    private String account = "";
    private long deadline;

    long update(boolean enabled, String key, long now) {
        if (!enabled || key.isEmpty()) { cancel(); return -1; }
        if (!key.equals(account)) {
            account = key;
            deadline = now + 3000;
        }
        return Math.max(0, deadline - now);
    }

    boolean finish(String key, long now) {
        if (account.isEmpty() || !account.equals(key) || now < deadline) return false;
        cancel();
        return true;
    }

    void cancel() { account = ""; }
}
