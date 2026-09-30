package com.kareemessam.openship.shared.util

import kotlin.jvm.Synchronized
import kotlin.jvm.Volatile

class SeqTracker {
    @Volatile
    private var _lastSeq: Long = 0L

    val lastSeq: Long get() = _lastSeq

    @Synchronized
    fun update(seq: Long) {
        if (seq > _lastSeq) {
            _lastSeq = seq
        }
    }

    fun getResumeParam(): String = _lastSeq.toString()

    @Synchronized
    fun reset() {
        _lastSeq = 0L
    }
}


