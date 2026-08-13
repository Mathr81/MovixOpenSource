package com.movix.app.cast

internal data class NativeCastStatus(
    val connected: Boolean,
    val deviceName: String?,
    val mediaSessionId: Int?,
    val state: String,
    val positionSec: Double,
    val durationSec: Double?,
    val canSeek: Boolean,
    val idleReason: String? = null,
    val errorCode: String? = null,
)

internal data class CastStatusSnapshot(
    val connected: Boolean,
    val deviceName: String? = null,
    val mediaSessionId: Int? = null,
    val playbackState: NativeCastPlaybackState = NativeCastPlaybackState.IDLE,
    val positionMs: Long = 0L,
    val durationMs: Long? = null,
    val canSeek: Boolean = false,
    val idleReason: String? = null,
    val errorCode: String? = null,
)

internal object CastStatusMapper {
    private val stableIdleReasons = setOf(
        "CANCELLED",
        "INTERRUPTED",
        "FINISHED",
        "ERROR",
    )
    private val safeErrorPattern = Regex("^MOVIX_[A-Z0-9_]{3,80}$")

    fun map(snapshot: CastStatusSnapshot): NativeCastStatus {
        val state = when (snapshot.playbackState) {
            NativeCastPlaybackState.IDLE -> "idle"
            NativeCastPlaybackState.LOADING -> "loading"
            NativeCastPlaybackState.BUFFERING -> "buffering"
            NativeCastPlaybackState.PLAYING -> "playing"
            NativeCastPlaybackState.PAUSED -> "paused"
            NativeCastPlaybackState.ENDED -> "ended"
            NativeCastPlaybackState.ERROR -> "error"
        }
        return NativeCastStatus(
            connected = snapshot.connected,
            deviceName = snapshot.deviceName?.take(80),
            mediaSessionId = snapshot.mediaSessionId,
            state = state,
            positionSec = snapshot.positionMs.coerceAtLeast(0L) / 1_000.0,
            durationSec = snapshot.durationMs
                ?.takeIf { it >= 0L }
                ?.div(1_000.0),
            canSeek = snapshot.connected && snapshot.canSeek,
            idleReason = snapshot.idleReason
                ?.uppercase()
                ?.takeIf(stableIdleReasons::contains),
            errorCode = snapshot.errorCode?.takeIf(safeErrorPattern::matches),
        )
    }

    fun disconnected(errorCode: String? = null): NativeCastStatus {
        return map(
            CastStatusSnapshot(
                connected = false,
                playbackState = if (errorCode == null) {
                    NativeCastPlaybackState.IDLE
                } else {
                    NativeCastPlaybackState.ERROR
                },
                errorCode = errorCode,
            ),
        )
    }
}
