package com.movix.app.cast

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.google.android.gms.cast.MediaInfo
import com.google.android.gms.cast.MediaLoadRequestData
import com.google.android.gms.cast.MediaSeekOptions
import com.google.android.gms.cast.MediaStatus
import com.google.android.gms.cast.framework.media.RemoteMediaClient
import com.google.android.gms.common.api.PendingResult

internal data class CastRemoteTextTrack(
    val contentUrl: String,
    val language: String?,
    val name: String?,
)

internal data class CastRemoteMetadata(
    val title: String,
    val poster: String?,
)

internal data class CastRemoteMedia(
    val mediaInfo: MediaInfo,
    val contentUrl: String,
    val textTracks: List<CastRemoteTextTrack>,
    val activeTrackIds: LongArray,
    val movixTransport: String,
    val protocolVersion: Int,
)

internal interface CastRemoteClient : AutoCloseable {
    interface Listener {
        fun onStatus(status: NativeCastStatus)
    }

    var listener: Listener?

    fun load(
        media: CastRemoteMedia,
        startTimeSec: Double,
        callback: (Result<Unit>) -> Unit,
    )

    fun play(callback: (Result<Unit>) -> Unit)
    fun pause(callback: (Result<Unit>) -> Unit)
    fun seekTo(seconds: Double, callback: (Result<Unit>) -> Unit)
    fun requestStatus(callback: (Result<NativeCastStatus>) -> Unit)
    fun currentStatus(callback: (Result<NativeCastStatus>) -> Unit)
    fun stop(callback: (Result<Unit>) -> Unit)
    override fun close()
}

internal class GoogleCastRemoteClient(
    private val remote: RemoteMediaClient,
    private val deviceName: String?,
    private val handler: Handler = Handler(Looper.getMainLooper()),
) : CastRemoteClient {
    private var registered = false
    private var closed = false
    private var activeListener: CastRemoteClient.Listener? = null
    private val pendingOperations =
        linkedMapOf<PendingResult<*>, () -> Unit>()

    private val callback = object : RemoteMediaClient.Callback() {
        override fun onStatusUpdated() = emitCurrent()
        override fun onMetadataUpdated() = emitCurrent()
    }
    private val progressListener = RemoteMediaClient.ProgressListener { _, _ ->
        emitCurrent()
    }

    override var listener: CastRemoteClient.Listener?
        get() = activeListener
        set(value) {
            activeListener = value
            runMain {
                if (value != null && !registered && !closed) {
                    remote.registerCallback(callback)
                    remote.addProgressListener(progressListener, 1_000L)
                    registered = true
                } else if (value == null) {
                    unregister()
                }
            }
        }

    override fun load(
        media: CastRemoteMedia,
        startTimeSec: Double,
        callback: (Result<Unit>) -> Unit,
    ) = runMain {
        Log.i(
            "MovixCastDiag",
            "remote_load url=${media.contentUrl} contentType=${media.mediaInfo.contentType} " +
                "hlsSegmentFormat=${media.mediaInfo.hlsSegmentFormat} " +
                "hlsVideoSegmentFormat=${media.mediaInfo.hlsVideoSegmentFormat} " +
                "startTimeSec=$startTimeSec tracks=${media.activeTrackIds.contentToString()}",
        )
        val request = MediaLoadRequestData.Builder()
            .setMediaInfo(media.mediaInfo)
            .setAutoplay(true)
            .setCurrentTime((startTimeSec.coerceAtLeast(0.0) * 1_000).toLong())
            .apply {
                if (media.activeTrackIds.isNotEmpty()) {
                    setActiveTrackIds(media.activeTrackIds)
                }
            }
            .build()
        val pending = remote.load(request)
        track(pending, {
            Log.w("MovixCastDiag", "remote_load_cancelled")
            callback(Result.failure(IllegalStateException("MOVIX_CAST_COMMAND_CANCELLED")))
        }) {
            Log.i(
                "MovixCastDiag",
                "remote_load_result success=${it.status.isSuccess} " +
                    "statusCode=${it.status.statusCode} statusMessage=${it.status.statusMessage}",
            )
            callback(it.status.asResult("MOVIX_CAST_LOAD_REJECTED"))
        }
    }

    override fun play(callback: (Result<Unit>) -> Unit) = runMain {
        val pending = remote.play()
        track(pending, {
            callback(Result.failure(IllegalStateException("MOVIX_CAST_COMMAND_CANCELLED")))
        }) {
            callback(it.status.asResult("MOVIX_CAST_PLAY_FAILED"))
        }
    }

    override fun pause(callback: (Result<Unit>) -> Unit) = runMain {
        val pending = remote.pause()
        track(pending, {
            callback(Result.failure(IllegalStateException("MOVIX_CAST_COMMAND_CANCELLED")))
        }) {
            callback(it.status.asResult("MOVIX_CAST_PAUSE_FAILED"))
        }
    }

    override fun seekTo(seconds: Double, callback: (Result<Unit>) -> Unit) = runMain {
        val options = MediaSeekOptions.Builder()
            .setPosition((seconds.coerceAtLeast(0.0) * 1_000).toLong())
            .build()
        val pending = remote.seek(options)
        track(pending, {
            callback(Result.failure(IllegalStateException("MOVIX_CAST_COMMAND_CANCELLED")))
        }) {
            callback(it.status.asResult("MOVIX_CAST_SEEK_FAILED"))
        }
    }

    override fun requestStatus(
        callback: (Result<NativeCastStatus>) -> Unit,
    ) = runMain {
        val pending = remote.requestStatus()
        track(pending, {
            callback(Result.failure(IllegalStateException("MOVIX_CAST_COMMAND_CANCELLED")))
        }) {
            val result = it.status.asResult("MOVIX_CAST_STATUS_FAILED")
            callback(result.map { currentStatusOnMain() })
        }
    }

    override fun currentStatus(
        callback: (Result<NativeCastStatus>) -> Unit,
    ) = runMain {
        callback(Result.success(currentStatusOnMain()))
    }

    private fun currentStatusOnMain(): NativeCastStatus {
        val status = remote.mediaStatus
        val playbackState = when (status?.playerState) {
            MediaStatus.PLAYER_STATE_LOADING -> NativeCastPlaybackState.LOADING
            MediaStatus.PLAYER_STATE_BUFFERING -> NativeCastPlaybackState.BUFFERING
            MediaStatus.PLAYER_STATE_PLAYING -> NativeCastPlaybackState.PLAYING
            MediaStatus.PLAYER_STATE_PAUSED -> NativeCastPlaybackState.PAUSED
            MediaStatus.PLAYER_STATE_IDLE -> when (status.idleReason) {
                MediaStatus.IDLE_REASON_FINISHED -> NativeCastPlaybackState.ENDED
                MediaStatus.IDLE_REASON_ERROR -> NativeCastPlaybackState.ERROR
                else -> NativeCastPlaybackState.IDLE
            }
            else -> NativeCastPlaybackState.IDLE
        }
        val idleReason = when (status?.idleReason) {
            MediaStatus.IDLE_REASON_CANCELED -> "CANCELLED"
            MediaStatus.IDLE_REASON_INTERRUPTED -> "INTERRUPTED"
            MediaStatus.IDLE_REASON_FINISHED -> "FINISHED"
            MediaStatus.IDLE_REASON_ERROR -> "ERROR"
            else -> null
        }
        Log.i(
            "MovixCastDiag",
            "remote_status playerState=${status?.playerState} idleReason=$idleReason " +
                "position=${remote.approximateStreamPosition} duration=${remote.streamDuration} " +
                "canSeek=${status?.isMediaCommandSupported(MediaStatus.COMMAND_SEEK)}",
        )
        return CastStatusMapper.map(
            CastStatusSnapshot(
                connected = true,
                deviceName = deviceName,
                mediaSessionId = null,
                playbackState = playbackState,
                positionMs = remote.approximateStreamPosition,
                durationMs = remote.streamDuration.takeIf { it >= 0L },
                canSeek =
                    status?.isMediaCommandSupported(MediaStatus.COMMAND_SEEK) == true,
                idleReason = idleReason,
                errorCode = if (playbackState == NativeCastPlaybackState.ERROR) {
                    "MOVIX_CAST_RECEIVER_ERROR"
                } else {
                    null
                },
            ),
        )
    }

    override fun stop(callback: (Result<Unit>) -> Unit) = runMain {
        val pending = remote.stop()
        track(pending, {
            callback(Result.failure(IllegalStateException("MOVIX_CAST_COMMAND_CANCELLED")))
        }) {
            callback(it.status.asResult("MOVIX_CAST_STOP_FAILED"))
        }
    }

    override fun close() = runMain {
        if (closed) return@runMain
        closed = true
        val operations = pendingOperations.toList()
        pendingOperations.clear()
        operations.forEach { (pending, onCancelled) ->
            pending.cancel()
            onCancelled()
        }
        unregister()
    }

    private fun unregister() {
        if (!registered) return
        remote.unregisterCallback(callback)
        remote.removeProgressListener(progressListener)
        registered = false
    }

    private fun emitCurrent() {
        activeListener?.onStatus(currentStatusOnMain())
    }

    private fun <R : com.google.android.gms.common.api.Result> track(
        pending: PendingResult<R>,
        onCancelled: () -> Unit,
        onResult: (R) -> Unit,
    ) {
        if (closed) {
            pending.cancel()
            onCancelled()
            return
        }
        pendingOperations[pending] = onCancelled
        pending.setResultCallback { result ->
            if (pendingOperations.remove(pending) != null) {
                onResult(result)
            }
        }
    }

    private fun runMain(block: () -> Unit) {
        if (Looper.myLooper() == handler.looper) block() else handler.post(block)
    }

    private fun com.google.android.gms.common.api.Status.asResult(
        errorCode: String,
    ): Result<Unit> {
        return if (isSuccess) {
            Result.success(Unit)
        } else {
            Result.failure(IllegalStateException(errorCode))
        }
    }
}
