package com.qireader.filter;

import org.junit.Test;
import java.util.Set;
import java.util.HashSet;
import static org.junit.Assert.*;

public class RoundTest {
    @Test public void fiveConfirmedUniqueAdditionsCompleteAndExtraClicksDoNotCrossBoundary() {
        Round value = new Round(5, Set.of());
        for (int i = 0; i < 5; i++) {
            value = value.add("entry-" + i).add("entry-" + i);
            assertEquals(i + 1, value.ids.size());
            assertEquals(i == 4, value.complete());
        }
        assertEquals(5, value.add("extra").ids.size());
        assertEquals(0, new Round(5, Set.of()).ids.size());
    }
    @Test public void changingTargetRetainsProgressAndDoesNotMutateStoredSet() {
        Set<String> saved = new HashSet<>(Set.of("a", "b"));
        Round value = new Round(12, saved).add("c");
        assertEquals(2, saved.size()); assertEquals(3, value.ids.size()); assertFalse(value.complete());
        assertTrue(new Round(2, value.ids).complete());
    }
    @Test public void invalidValuesAreRejected() {
        for (int target : new int[]{0, 101, -1}) {
            assertThrows(IllegalArgumentException.class, () -> new Round(target, Set.of()));
        }
        assertThrows(IllegalArgumentException.class, () -> new Round(5, Set.of()).add(""));
    }
}
