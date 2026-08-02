package com.movix.app.cast

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.movix.app.proxy.PreparedCastMedia

internal enum class NativeCastPlaybackState {
    IDLE,
    LOADING,
    BUFFERING,
    PLAYING,
    PAUSED,
    ENDED,
    ERROR,
}

internal enum class CastRelayStopReason {
    EXPLICIT,
    SESSION_ENDED,
    NETWORK_LOST,
    ADDRESS_CHANGED,
    LOAD_FAILED,
    NOTIFICATION_STOP,
    SERVICE_DESTROYED,
}

internal interface CastRelayClient {
    fun prepare(
        request: CastRelayRequest,
        callback: (Result<PreparedCastMedia>) -> Unit,
    )

    fun updatePlaybackState(state: NativeCastPlaybackState)
    fun noteProxyActivity()
    fun replaceAcceptedSession(newSessionId: String)
    fun discardPreparedSession(sessionId: String) {
        stop(CastRelayStopReason.LOAD_FAILED)
    }
    fun stop(reason: CastRelayStopReason)
    fun setTerminalListener(listener: ((CastRelayStopReason) -> Unit)?) = Unit
}

internal class ForegroundCastRelayClient(
    context: Context,
    private val registry: CastRelayRequestRegistry = CastRelayRequestRegistry.shared,
    private val mainHandler: Handler = Handler(Looper.getMainLooper()),
) : CastRelayClient {
    private val appContext = context.applicationContext

    override fun prepare(
        request: CastRelayRequest,
        callback: (Result<PreparedCastMedia>) -> Unit,
    ) {
        val id = registry.put(request) { result ->
            mainHandler.post { callback(result) }
        }
        val intent = CastProxyForegroundService.startIntent(appContext, id)
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                appContext.startForegroundService(intent)
            } else {
                appContext.startService(intent)
            }
        }.onFailure {
            registry.takePending(id)?.callback?.invoke(
                Result.failure(
                    IllegalStateException("MOVIX_RELAY_FOREGROUND_UNAVAILABLE"),
                ),
            )
        }
    }

    override fun updatePlaybackState(state: NativeCastPlaybackState) {
        CastProxyForegroundService.activeInstance?.updatePlaybackState(state)
    }

    override fun noteProxyActivity() {
        CastProxyForegroundService.activeInstance?.noteProxyActivity()
    }

    override fun replaceAcceptedSession(newSessionId: String) {
        CastProxyForegroundService.activeInstance?.replaceAcceptedSession(newSessionId)
    }

    override fun discardPreparedSession(sessionId: String) {
        CastProxyForegroundService.activeInstance?.discardPreparedSession(sessionId)
    }

    override fun stop(reason: CastRelayStopReason) {
        val active = CastProxyForegroundService.activeInstance
        if (active != null) {
            runCatching { active.stopRelay(reason) }
        } else {
            registry.clear()
        }
    }

    override fun setTerminalListener(listener: ((CastRelayStopReason) -> Unit)?) {
        terminalListener = listener
    }

    companion object {
        @Volatile
        private var terminalListener: ((CastRelayStopReason) -> Unit)? = null

        internal fun notifyTerminal(reason: CastRelayStopReason) {
            terminalListener?.invoke(reason)
        }
    }
}
