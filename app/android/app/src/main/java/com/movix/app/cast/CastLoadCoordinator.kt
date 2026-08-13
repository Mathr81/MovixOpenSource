package com.movix.app.cast

import android.net.Uri
import com.google.android.gms.cast.MediaInfo
import com.google.android.gms.cast.MediaMetadata
import com.google.android.gms.cast.MediaTrack
import com.google.android.gms.common.images.WebImage
import com.movix.app.proxy.CastPreparedTextTrack
import com.movix.app.proxy.MediaProxyPolicy
import com.movix.app.proxy.PreparedCastMedia
import com.movix.app.proxy.PreparedCastTextTrack
import java.net.InetAddress
import java.net.URI
import org.json.JSONObject

internal class CastLoadCoordinator(
    private val relay: CastRelayClient,
    private val remote: CastRemoteClient,
    private val statusListener: (NativeCastStatus) -> Unit = {},
) {
    private var cancelled = false
    private var acceptedLoad = false
    private var loadSequence = 0L
    private var preparedSessionId: String? = null
    private var pendingLoadCallback: ((Result<Unit>) -> Unit)? = null
    private var statusListenerActive = false

    val hasAcceptedLoad: Boolean
        get() = acceptedLoad

    fun activateStatusListener() {
        if (statusListenerActive) return
        statusListenerActive = true
        remote.listener = object : CastRemoteClient.Listener {
            override fun onStatus(status: NativeCastStatus) {
                relay.updatePlaybackState(status.toPlaybackState())
                statusListener(status)
            }
        }
    }

    fun load(
        request: CastRelayRequest,
        metadata: CastRemoteMetadata,
        startTimeSec: Double,
        callback: (Result<Unit>) -> Unit,
    ) {
        finishPendingLoad(
            Result.failure(IllegalStateException("MOVIX_CAST_LOAD_REPLACED")),
        )
        loadSequence += 1L
        val sequence = loadSequence
        pendingLoadCallback = callback
        cancelled = false
        relay.updatePlaybackState(NativeCastPlaybackState.LOADING)
        relay.prepare(request, prepareCallback@ { preparedResult ->
            if (cancelled || sequence != loadSequence) {
                preparedResult.getOrNull()?.let {
                    relay.discardPreparedSession(it.sessionId)
                }
                return@prepareCallback
            }
            val prepared = preparedResult.getOrElse {
                finishLoad(sequence, Result.failure(it))
                return@prepareCallback
            }
            preparedSessionId = prepared.sessionId
            val remoteMedia = runCatching {
                buildRemoteMedia(prepared, request.source.tracks, metadata)
            }.getOrElse {
                discardPreparedSession()
                finishLoad(sequence, Result.failure(it))
                return@prepareCallback
            }
            remote.load(
                remoteMedia,
                startTimeSec,
                remoteLoadCallback@ { accepted ->
                    if (cancelled || sequence != loadSequence) {
                        discardPreparedSession()
                        return@remoteLoadCallback
                    }
                    if (accepted.isSuccess) {
                        relay.replaceAcceptedSession(prepared.sessionId)
                        preparedSessionId = null
                        acceptedLoad = true
                        finishLoad(sequence, Result.success(Unit))
                    } else {
                        discardPreparedSession()
                        finishLoad(
                            sequence,
                            Result.failure(
                                IllegalStateException("MOVIX_CAST_LOAD_REJECTED"),
                            ),
                        )
                    }
                },
            )
        })
    }

    private fun buildRemoteMedia(
        prepared: PreparedCastMedia,
        sourceTracks: List<CastPreparedTextTrack>,
        metadata: CastRemoteMetadata,
    ): CastRemoteMedia {
        requireOpaqueLanUrl(prepared.lanContentUrl)
        val castMetadata = MediaMetadata(MediaMetadata.MEDIA_TYPE_MOVIE).apply {
            putString(MediaMetadata.KEY_TITLE, metadata.title.take(200))
            metadata.poster?.takeIf(String::isNotBlank)?.let {
                runCatching { addImage(WebImage(Uri.parse(it))) }
            }
        }
        val mediaTracks = prepared.textTracks.mapIndexed { index, track ->
            prepareTextTrack(index, sourceTracks.getOrNull(index), track)
        }
        val activeTrackIds = prepared.textTracks.mapIndexedNotNull { index, track ->
            if (track.active || sourceTracks.getOrNull(index)?.active == true) {
                (index + 1).toLong()
            } else {
                null
            }
        }.toLongArray()
        val movixTransport = "android-lan-v1"
        val protocolVersion = 1
        val customData = JSONObject()
            .put("movixTransport", movixTransport)
            .put("protocolVersion", protocolVersion)
        val mediaInfo = MediaInfo.Builder(prepared.lanContentUrl)
            .setStreamType(MediaInfo.STREAM_TYPE_BUFFERED)
            .setContentType(prepared.profile.contentType)
            .setMetadata(castMetadata)
            .setMediaTracks(mediaTracks)
            .setCustomData(customData)
            .apply {
                prepared.profile.hlsSegmentFormat?.let(::setHlsSegmentFormat)
                prepared.profile.hlsVideoSegmentFormat?.let(::setHlsVideoSegmentFormat)
            }
            .build()
        return CastRemoteMedia(
            mediaInfo = mediaInfo,
            contentUrl = prepared.lanContentUrl,
            textTracks = prepared.textTracks.map {
                CastRemoteTextTrack(it.lanUrl, it.language, it.name)
            },
            activeTrackIds = activeTrackIds,
            movixTransport = movixTransport,
            protocolVersion = protocolVersion,
        )
    }

    private fun prepareTextTrack(
        index: Int,
        sourceTrack: CastPreparedTextTrack?,
        preparedTrack: PreparedCastTextTrack,
    ): MediaTrack {
        requireOpaqueLanUrl(preparedTrack.lanUrl)
        return MediaTrack.Builder((index + 1).toLong(), MediaTrack.TYPE_TEXT)
            .setContentId(preparedTrack.lanUrl)
            .setContentType(preparedTrack.contentType)
            .setSubtype(MediaTrack.SUBTYPE_SUBTITLES)
            .apply {
                preparedTrack.language?.let(::setLanguage)
                preparedTrack.name?.let(::setName)
                sourceTrack?.language?.takeIf(String::isNotBlank)?.let(::setLanguage)
                sourceTrack?.name?.takeIf(String::isNotBlank)?.let(::setName)
            }
            .build()
    }

    fun play(callback: (Result<Unit>) -> Unit) = remote.play(callback)
    fun pause(callback: (Result<Unit>) -> Unit) = remote.pause(callback)
    fun seekTo(seconds: Double, callback: (Result<Unit>) -> Unit) =
        remote.seekTo(seconds, callback)

    fun getStatus(
        refresh: Boolean,
        callback: (Result<NativeCastStatus>) -> Unit,
    ) {
        if (refresh) remote.requestStatus(callback)
        else remote.currentStatus(callback)
    }

    fun stop(callback: (Result<Unit>) -> Unit) {
        cancelled = true
        loadSequence += 1L
        finishPendingLoad(
            Result.failure(IllegalStateException("MOVIX_CAST_STOPPED")),
        )
        remote.stop { }
        cleanup(CastRelayStopReason.EXPLICIT)
        statusListener(CastStatusMapper.disconnected())
        callback(Result.success(Unit))
    }

    fun cancel(reason: CastRelayStopReason) {
        cancelled = true
        loadSequence += 1L
        finishPendingLoad(
            Result.failure(
                IllegalStateException(reason.toErrorCode()),
            ),
        )
        cleanup(reason)
        statusListener(CastStatusMapper.disconnected())
    }

    fun retireAfterReplacement() {
        cancelled = true
        loadSequence += 1L
        finishPendingLoad(
            Result.failure(IllegalStateException("MOVIX_CAST_LOAD_REPLACED")),
        )
        removeCallbacks()
    }

    fun abandonPendingLoad(errorCode: String) {
        cancelled = true
        loadSequence += 1L
        finishPendingLoad(
            Result.failure(IllegalStateException(errorCode)),
        )
        discardPreparedSession()
        removeCallbacks()
    }

    fun statusAfterProcessReconnect(deviceName: String?): NativeCastStatus {
        return CastStatusMapper.map(
            CastStatusSnapshot(
                connected = true,
                deviceName = deviceName,
                playbackState = NativeCastPlaybackState.ERROR,
                errorCode = "MOVIX_RELAY_RELOAD_REQUIRED",
            ),
        )
    }

    private fun cleanup(reason: CastRelayStopReason) {
        removeCallbacks()
        relay.stop(reason)
    }

    private fun removeCallbacks() {
        statusListenerActive = false
        remote.listener = null
        remote.close()
    }

    private fun discardPreparedSession() {
        val sessionId = preparedSessionId ?: return
        preparedSessionId = null
        relay.discardPreparedSession(sessionId)
    }

    private fun finishLoad(sequence: Long, result: Result<Unit>) {
        if (sequence != loadSequence) return
        finishPendingLoad(result)
    }

    private fun finishPendingLoad(result: Result<Unit>) {
        val callback = pendingLoadCallback ?: return
        pendingLoadCallback = null
        callback(result)
    }

    private fun CastRelayStopReason.toErrorCode(): String = when (this) {
        CastRelayStopReason.NETWORK_LOST -> "MOVIX_RELAY_NETWORK_LOST"
        CastRelayStopReason.ADDRESS_CHANGED -> "MOVIX_RELAY_ADDRESS_CHANGED"
        CastRelayStopReason.NOTIFICATION_STOP -> "MOVIX_RELAY_STOPPED"
        CastRelayStopReason.SESSION_ENDED -> "MOVIX_CAST_SESSION_ENDED"
        CastRelayStopReason.LOAD_FAILED -> "MOVIX_CAST_LOAD_FAILED"
        CastRelayStopReason.SERVICE_DESTROYED -> "MOVIX_RELAY_SERVICE_STOPPED"
        CastRelayStopReason.EXPLICIT -> "MOVIX_CAST_STOPPED"
    }

    private fun requireOpaqueLanUrl(rawUrl: String) {
        val uri = runCatching { URI(rawUrl) }
            .getOrElse { throw IllegalArgumentException("MOVIX_RELAY_INVALID_LAN_URL") }
        require(uri.scheme == "http" && uri.rawQuery == null && uri.fragment == null) {
            "MOVIX_RELAY_INVALID_LAN_URL"
        }
        val host = uri.host ?: throw IllegalArgumentException("MOVIX_RELAY_INVALID_LAN_URL")
        require(host.contains(':') || host.matches(Regex("^\\d{1,3}(?:\\.\\d{1,3}){3}$"))) {
            "MOVIX_RELAY_INVALID_LAN_URL"
        }
        MediaProxyPolicy.requireUsableCastLanAddress(InetAddress.getByName(host))
        val parts = uri.path.split('/').filter(String::isNotEmpty)
        require(
            parts.size == 3 &&
                parts[0] == "cast" &&
                MediaProxyPolicy.isOpaqueToken(parts[1]) &&
                MediaProxyPolicy.isOpaqueToken(parts[2]),
        ) {
            "MOVIX_RELAY_INVALID_LAN_URL"
        }
    }

    private fun NativeCastStatus.toPlaybackState(): NativeCastPlaybackState {
        return when (state) {
            "loading" -> NativeCastPlaybackState.LOADING
            "buffering" -> NativeCastPlaybackState.BUFFERING
            "playing" -> NativeCastPlaybackState.PLAYING
            "paused" -> NativeCastPlaybackState.PAUSED
            "ended" -> NativeCastPlaybackState.ENDED
            "error" -> NativeCastPlaybackState.ERROR
            else -> NativeCastPlaybackState.IDLE
        }
    }
}
