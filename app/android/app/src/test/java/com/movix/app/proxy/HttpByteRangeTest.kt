package com.movix.app.proxy

import org.junit.Assert.assertEquals
import org.junit.Test

class HttpByteRangeTest {
    @Test
    fun parsesClosedOpenAndSuffixRanges() {
        assertEquals(HttpByteRange.None, HttpByteRange.parse(null, 1_000))
        assertEquals(HttpByteRange.Valid(10, 19, 1_000), HttpByteRange.parse("bytes=10-19", 1_000))
        assertEquals(HttpByteRange.Valid(990, 999, 1_000), HttpByteRange.parse("bytes=-10", 1_000))
        assertEquals(HttpByteRange.Valid(900, 999, 1_000), HttpByteRange.parse("bytes=900-", 1_000))
        assertEquals(HttpByteRange.Valid(995, 999, 1_000), HttpByteRange.parse("bytes=995-2000", 1_000))
    }

    @Test
    fun rejectsMultipleMalformedAndUnsatisfiableRanges() {
        for (value in listOf("bytes=0-1,4-5", "items=0-1", "bytes=-0", "bytes=1000-", "bytes=9-2")) {
            assertEquals(HttpByteRange.Unsatisfiable, HttpByteRange.parse(value, 1_000))
        }
    }

    @Test
    fun acceptsCaseInsensitiveBytesUnit() {
        assertEquals(HttpByteRange.Valid(0, 187, 1_000), HttpByteRange.parse("BYTES=0-187", 1_000))
    }
}
