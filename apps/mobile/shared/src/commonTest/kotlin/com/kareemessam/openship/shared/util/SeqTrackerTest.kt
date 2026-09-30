package com.kareemessam.openship.shared.util

import kotlin.test.Test
import kotlin.test.assertEquals

class SeqTrackerTest {

    @Test
    fun testInitialSequenceState() {
        val tracker = SeqTracker()
        assertEquals(0L, tracker.lastSeq)
        assertEquals("0", tracker.getResumeParam())
    }

    @Test
    fun testMonotonicSequenceUpdate() {
        val tracker = SeqTracker()
        tracker.update(100L)
        assertEquals(100L, tracker.lastSeq)
        assertEquals("100", tracker.getResumeParam())

        tracker.update(150L)
        assertEquals(150L, tracker.lastSeq)

        // Out-of-order or duplicate sequence should not regress
        tracker.update(120L)
        assertEquals(150L, tracker.lastSeq)
    }

    @Test
    fun testReset() {
        val tracker = SeqTracker()
        tracker.update(450L)
        assertEquals(450L, tracker.lastSeq)

        tracker.reset()
        assertEquals(0L, tracker.lastSeq)
        assertEquals("0", tracker.getResumeParam())
    }
}
