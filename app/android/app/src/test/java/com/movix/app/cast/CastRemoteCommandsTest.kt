package com.movix.app.cast

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CastRemoteCommandsTest {
    @Test
    fun delegatesPlayPauseSeekRefreshAndStop() {
        val relay = FakeRelayForCommands()
        val remote = RecordingRemoteForCommands()
        val coordinator = CastLoadCoordinator(relay, remote)
        var completions = 0

        coordinator.play { if (it.isSuccess) completions += 1 }
        coordinator.pause { if (it.isSuccess) completions += 1 }
        coordinator.seekTo(33.5) { if (it.isSuccess) completions += 1 }
        coordinator.getStatus(refresh = true) { if (it.isSuccess) completions += 1 }
        coordinator.stop { if (it.isSuccess) completions += 1 }

        assertEquals(listOf("play", "pause", "seek:33.5", "status", "stop"), remote.calls)
        assertEquals(5, completions)
        assertEquals(CastRelayStopReason.EXPLICIT, relay.stopReason)
        assertTrue(remote.closed)
    }
}

private class FakeRelayForCommands : CastRelayClient {
    var stopReason: CastRelayStopReason? = null
    override fun prepare(
        request: CastRelayRequest,
        callback: (Result<com.movix.app.proxy.PreparedCastMedia>) -> Unit,
    ) = Unit

    override fun updatePlaybackState(state: NativeCastPlaybackState) = Unit
    override fun noteProxyActivity() = Unit
    override fun replaceAcceptedSession(newSessionId: String) = Unit
    override fun stop(reason: CastRelayStopReason) {
        stopReason = reason
    }
}

private class RecordingRemoteForCommands : CastRemoteClient {
    val calls = mutableListOf<String>()
    var closed = false
    override var listener: CastRemoteClient.Listener? = null
    override fun load(
        media: CastRemoteMedia,
        startTimeSec: Double,
        callback: (Result<Unit>) -> Unit,
    ) = callback(Result.success(Unit))

    override fun play(callback: (Result<Unit>) -> Unit) {
        calls += "play"
        callback(Result.success(Unit))
    }

    override fun pause(callback: (Result<Unit>) -> Unit) {
        calls += "pause"
        callback(Result.success(Unit))
    }

    override fun seekTo(seconds: Double, callback: (Result<Unit>) -> Unit) {
        calls += "seek:$seconds"
        callback(Result.success(Unit))
    }

    override fun requestStatus(callback: (Result<NativeCastStatus>) -> Unit) {
        calls += "status"
        callback(Result.success(CastStatusMapper.disconnected()))
    }

    override fun currentStatus(callback: (Result<NativeCastStatus>) -> Unit) {
        calls += "currentStatus"
        callback(Result.success(CastStatusMapper.disconnected()))
    }
    override fun stop(callback: (Result<Unit>) -> Unit) {
        calls += "stop"
        callback(Result.success(Unit))
    }

    override fun close() {
        closed = true
    }
}
