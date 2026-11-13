package com.qireader.filter;

import org.junit.Test;
import static org.junit.Assert.*;

public class RestCountdownTest {
    @Test public void stateRefreshDoesNotExtendThreeSecondsAndFinishesOnlyOnce() {
        RestCountdown timer = new RestCountdown();
        assertEquals(3000, timer.update(true, "a", 100));
        assertEquals(2000, timer.update(true, "a", 1100));
        assertFalse(timer.finish("a", 3099));
        assertTrue(timer.finish("a", 3100));
        assertFalse(timer.finish("a", 3101));
    }

    @Test public void cancellationPreventsBackgroundResetAndResumeStartsFresh() {
        RestCountdown timer = new RestCountdown();
        timer.update(true, "a", 100);
        assertEquals(-1, timer.update(false, "a", 1100));
        assertFalse(timer.finish("a", 10000));
        assertEquals(3000, timer.update(true, "a", 10000));
        assertFalse(timer.finish("a", 12999));
        assertTrue(timer.finish("a", 13000));
    }

    @Test public void changedAccountAndLogoutCannotFinishAnOldRound() {
        RestCountdown timer = new RestCountdown();
        timer.update(true, "a", 100);
        assertFalse(timer.finish("b", 3100));
        assertEquals(3000, timer.update(true, "b", 3100));
        assertFalse(timer.finish("b", 3100));
        assertEquals(-1, timer.update(true, "", 4000));
        assertFalse(timer.finish("b", 10000));
        timer.update(true, "b", 11000);
        timer.cancel();
        assertFalse(timer.finish("b", 14000));
    }
}
