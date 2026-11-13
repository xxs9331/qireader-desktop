package com.qireader.filter;

import java.util.LinkedHashSet;
import java.util.Set;

final class Round {
    final int target;
    final Set<String> ids;

    Round(int target, Set<String> ids) {
        if (target < 1 || target > 100 || ids.size() > 100 || ids.stream().anyMatch(id -> id == null || id.isEmpty() || id.length() > 512)) {
            throw new IllegalArgumentException("每轮数量须为 1–100");
        }
        this.target = target;
        this.ids = new LinkedHashSet<>(ids);
    }

    boolean complete() { return ids.size() >= target; }

    Round add(String id) {
        if (id == null || id.isEmpty() || id.length() > 512) throw new IllegalArgumentException("文章编号无效");
        Set<String> next = new LinkedHashSet<>(ids);
        if (!complete()) next.add(id);
        return new Round(target, next);
    }
}
