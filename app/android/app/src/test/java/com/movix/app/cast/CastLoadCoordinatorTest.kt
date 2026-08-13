package com.movix.app.cast

import com.movix.app.proxy.CastMediaProfile
import com.movix.app.proxy.CastPreparedSource
import com.movix.app.proxy.CastPreparedTextTrack
import com.movix.app.proxy.PreparedCastMedia
import com.movix.app.proxy.PreparedCastTextTrack
import java.net.InetAddress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class CastLoadCoordinatorTest {
    @Test
    fun loadsOnlyPreparedLanUrlsAndWaitsForReceiverAcceptance() {
        val relay = FakeRelayClient()
        val remote = FakeCastRemoteClient()
        val coordinator = CastLoadCoordinator(relay, remote)
        var completion: Result<Unit>? = null
        val source = CastPreparedSource(
            url = "https://cdn.example/master.m3u8?token=secret",
            headers = mapOf("Referer" to "https://player.example/"),
            tracks = listOf(
                CastPreparedTextTrack(
                    "https://cdn.example/sub.vtt?token=secret",
                    language = "fr",
                    name = "Français",
                    active = true,
                ),
            ),
        )
        val request = CastRelayRequest(
            "Salon",
            InetAddress.getByName("192.168.1.8"),
            source,
        )

        coordinator.load(
            request,
            CastRemoteMetadata("Film", null),
            12.0,
        ) { completion = it }
        assertEquals(request, relay.pendingRequest)
        assertNull(remote.loadedMedia)

        relay.complete(
            PreparedCastMedia(
                "session-token",
                "http://192.168.1.2:28123/cast/session-token/resource-token",
                CastMediaProfile.hlsTs(),
                listOf(
                    PreparedCastTextTrack(
                        "http://192.168.1.2:28123/cast/session-token/subtitle-token",
                        "fr",
                        "Français",
                        "text/vtt",
                        true,
                    ),
                ),
            ),
        )
        assertTrue(remote.loadedMedia?.contentUrl.orEmpty().contains("/cast/"))
        assertFalse(remote.loadedMedia?.contentUrl.orEmpty().contains("cdn.example"))
        assertTrue(
            remote.loadedMedia?.textTracks?.single()?.contentUrl.orEmpty().contains("/cast/"),
        )
        assertEquals("android-lan-v1", remote.loadedMedia?.movixTransport)
        assertEquals(1, remote.loadedMedia?.protocolVersion)
        assertTrue(remote.loadedMedia?.activeTrackIds?.contentEquals(longArrayOf(1L)) == true)
        assertNull(completion)

        remote.acceptLoad()
        assertTrue(completion?.isSuccess == true)
        assertEquals("session-token", relay.acceptedSession)
    }

    @Test
    fun failedReceiverLoadStopsRelayAndNeverFallsBack() {
        val relay = FakeRelayClient()
        val remote = FakeCastRemoteClient()
        val coordinator = CastLoadCoordinator(relay, remote)
        var completion: Result<Unit>? = null
        coordinator.load(request(), CastRemoteMetadata("Film", null), 0.0) {
            completion = it
        }
        relay.complete(prepared())
        remote.rejectLoad()

        assertTrue(completion?.isFailure == true)
        assertEquals("session-token", relay.discardedSession)
        assertNull(relay.stopReason)
        assertEquals(1, remote.loadCalls)
    }

    @Test
    fun reconnectedProcessRequiresExplicitPreparedReload() {
        val coordinator = CastLoadCoordinator(FakeRelayClient(), FakeCastRemoteClient())

        val status = coordinator.statusAfterProcessReconnect("Salon")

        assertEquals("error", status.state)
        assertEquals("MOVIX_RELAY_RELOAD_REQUIRED", status.errorCode)
    }

    @Test
    fun abandoningPendingReplacementRejectsOnceAndDiscardsLatePreparation() {
        val relay = FakeRelayClient()
        val remote = FakeCastRemoteClient()
        val coordinator = CastLoadCoordinator(relay, remote)
        var callbacks = 0
        coordinator.load(request(), CastRemoteMetadata("Film", null), 0.0) {
            callbacks += 1
        }

        coordinator.abandonPendingLoad("MOVIX_CAST_LOAD_REPLACED")
        relay.complete(prepared())

        assertEquals(1, callbacks)
        assertEquals("session-token", relay.discardedSession)
        assertTrue(remote.closed)
    }

    private fun request() = CastRelayRequest(
        "Salon",
        InetAddress.getByName("192.168.1.8"),
        CastPreparedSource("https://cdn.example/master.m3u8", emptyMap()),
    )

    private fun prepared() = PreparedCastMedia(
        "session-token",
        "http://192.168.1.2:28123/cast/session-token/resource-token",
        CastMediaProfile.hlsTs(),
    )
}

private class FakeRelayClient : CastRelayClient {
    var pendingRequest: CastRelayRequest? = null
    private var callback: ((Result<PreparedCastMedia>) -> Unit)? = null
    var acceptedSession: String? = null
    var discardedSession: String? = null
    var stopReason: CastRelayStopReason? = null

    override fun prepare(
        request: CastRelayRequest,
        callback: (Result<PreparedCastMedia>) -> Unit,
    ) {
        pendingRequest = request
        this.callback = callback
    }

    fun complete(media: PreparedCastMedia) {
        callback?.invoke(Result.success(media))
    }

    override fun updatePlaybackState(state: NativeCastPlaybackState) = Unit
    override fun noteProxyActivity() = Unit
    override fun replaceAcceptedSession(newSessionId: String) {
        acceptedSession = newSessionId
    }

    override fun discardPreparedSession(sessionId: String) {
        discardedSession = sessionId
    }

    override fun stop(reason: CastRelayStopReason) {
        stopReason = reason
    }
}

private class FakeCastRemoteClient : CastRemoteClient {
    var loadedMedia: CastRemoteMedia? = null
    var loadCalls = 0
    private var loadCallback: ((Result<Unit>) -> Unit)? = null
    override var listener: CastRemoteClient.Listener? = null

    override fun load(
        media: CastRemoteMedia,
        startTimeSec: Double,
        callback: (Result<Unit>) -> Unit,
    ) {
        loadCalls += 1
        loadedMedia = media
        loadCallback = callback
    }

    fun acceptLoad() = loadCallback?.invoke(Result.success(Unit))
    fun rejectLoad() = loadCallback?.invoke(Result.failure(IllegalStateException("rejected")))
    override fun play(callback: (Result<Unit>) -> Unit) = callback(Result.success(Unit))
    override fun pause(callback: (Result<Unit>) -> Unit) = callback(Result.success(Unit))
    override fun seekTo(seconds: Double, callback: (Result<Unit>) -> Unit) =
        callback(Result.success(Unit))

    override fun requestStatus(callback: (Result<NativeCastStatus>) -> Unit) =
        callback(Result.success(CastStatusMapper.disconnected()))

    override fun currentStatus(callback: (Result<NativeCastStatus>) -> Unit) =
        callback(Result.success(CastStatusMapper.disconnected()))
    override fun stop(callback: (Result<Unit>) -> Unit) = callback(Result.success(Unit))
    var closed = false
    override fun close() {
        closed = true
    }
}
