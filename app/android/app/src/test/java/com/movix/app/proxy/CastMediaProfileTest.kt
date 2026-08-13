package com.movix.app.proxy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CastMediaProfileTest {
    @Test
    fun canonicalizesHlsMimeAndDetectsTransportStream() {
        val profile = CastMediaProfile.detect(
            "application/vnd.apple.mpegurl; charset=utf-8",
            "#EXTM3U\n#EXTINF:6,\nsegment-001.ts\n".toByteArray(),
        )

        assertEquals("application/x-mpegurl", profile?.contentType)
        assertEquals("ts", profile?.hlsSegmentFormat)
        assertEquals("mpeg2_ts", profile?.hlsVideoSegmentFormat)
        assertEquals(false, CastMediaProfile.hlsTs().requiresPngTsUnwrap)
        assertEquals(true, CastMediaProfile.hlsTs(true).requiresPngTsUnwrap)
    }

    @Test
    fun detectsFragmentedMp4FromMapOrM4s() {
        val fromMap = CastMediaProfile.detect(
            "application/octet-stream",
            "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6,\nchunk.m4s\n".toByteArray(),
        )
        val fromSegment = CastMediaProfile.detect(
            "application/x-mpegurl",
            "#EXTM3U\n#EXTINF:6,\nchunk-001.m4s\n".toByteArray(),
        )

        assertEquals("fmp4", fromMap?.hlsSegmentFormat)
        assertEquals("fmp4", fromMap?.hlsVideoSegmentFormat)
        assertEquals(fromMap, fromSegment)
    }

    @Test
    fun refusesAmbiguousHlsTransport() {
        assertNull(
            CastMediaProfile.detect(
                "application/vnd.apple.mpegurl",
                "#EXTM3U\n#EXT-X-TARGETDURATION:6\n".toByteArray(),
            ),
        )
    }

    @Test
    fun preservesSupportedProgressiveMime() {
        assertEquals(
            CastMediaProfile(
                contentType = "video/mp4",
                hlsSegmentFormat = null,
                hlsVideoSegmentFormat = null,
            ),
            CastMediaProfile.progressive("video/mp4; charset=binary"),
        )
        assertNull(CastMediaProfile.progressive("application/octet-stream"))
    }
}
