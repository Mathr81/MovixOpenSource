package com.movix.app.cast

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CastStatusMapperTest {
    @Test
    fun mapsStablePlaybackStatesAndTiming() {
        val status = CastStatusMapper.map(
            CastStatusSnapshot(
                connected = true,
                deviceName = "Salon",
                mediaSessionId = 42,
                playbackState = NativeCastPlaybackState.PLAYING,
                positionMs = 12_500L,
                durationMs = 90_000L,
                canSeek = true,
            ),
        )

        assertEquals("playing", status.state)
        assertEquals(12.5, status.positionSec, 0.0)
        assertEquals(90.0, status.durationSec ?: 0.0, 0.0)
        assertEquals(42, status.mediaSessionId)
        assertEquals("Salon", status.deviceName)
        assertTrue(status.canSeek)
        assertNull(status.errorCode)
    }

    @Test
    fun preservesOnlyStableIdleAndErrorCodes() {
        val ended = CastStatusMapper.map(
            CastStatusSnapshot(
                connected = true,
                playbackState = NativeCastPlaybackState.ENDED,
                idleReason = "FINISHED",
            ),
        )
        val error = CastStatusMapper.map(
            CastStatusSnapshot(
                connected = true,
                playbackState = NativeCastPlaybackState.ERROR,
                idleReason = "ERROR",
                errorCode = "MOVIX_RELAY_UPSTREAM_ERROR",
            ),
        )

        assertEquals("ended", ended.state)
        assertEquals("FINISHED", ended.idleReason)
        assertEquals("error", error.state)
        assertEquals("MOVIX_RELAY_UPSTREAM_ERROR", error.errorCode)
        assertFalse(error.canSeek)
    }
}
