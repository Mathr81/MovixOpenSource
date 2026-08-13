package com.movix.app.cast

import android.util.Base64
import com.movix.app.proxy.CastPreparedSource
import com.movix.app.proxy.PreparedCastMedia
import java.net.InetAddress
import java.security.SecureRandom

internal class CastRelayRequest(
    val deviceName: String,
    val receiverAddress: InetAddress,
    val source: CastPreparedSource,
) {
    override fun toString(): String = "CastRelayRequest(redacted=true)"
}

internal class CastRelayPendingRequest(
    val request: CastRelayRequest,
    val callback: (Result<PreparedCastMedia>) -> Unit,
) {
    override fun toString(): String = "CastRelayPendingRequest(redacted=true)"
}

internal class CastRelayRequestRegistry(
    private val now: () -> Long = System::currentTimeMillis,
    private val tokenFactory: () -> String = ::randomToken,
    private val ttlMs: Long = DEFAULT_TTL_MS,
) {
    private data class Entry(
        val pending: CastRelayPendingRequest,
        val expiresAt: Long,
    )

    private val lock = Any()
    private val entries = linkedMapOf<String, Entry>()

    fun put(
        request: CastRelayRequest,
        callback: (Result<PreparedCastMedia>) -> Unit = {},
    ): String = synchronized(lock) {
        cleanupLocked()
        val id = uniqueIdLocked()
        entries[id] = Entry(
            CastRelayPendingRequest(request, callback),
            now() + ttlMs,
        )
        id
    }

    fun take(id: String): CastRelayRequest? = takePending(id)?.request

    fun takePending(id: String): CastRelayPendingRequest? = synchronized(lock) {
        cleanupLocked()
        entries.remove(id)?.pending
    }

    fun clear() = synchronized(lock) {
        entries.clear()
    }

    fun isEmpty(): Boolean = synchronized(lock) {
        cleanupLocked()
        entries.isEmpty()
    }

    override fun toString(): String = synchronized(lock) {
        "CastRelayRequestRegistry(size=${entries.size}, redacted=true)"
    }

    private fun cleanupLocked() {
        val current = now()
        entries.entries.removeAll { current > it.value.expiresAt }
    }

    private fun uniqueIdLocked(): String {
        repeat(8) {
            val candidate = tokenFactory()
            if (!entries.containsKey(candidate)) return candidate
        }
        throw IllegalStateException("Unable to allocate relay request")
    }

    companion object {
        private const val DEFAULT_TTL_MS = 30_000L
        private val secureRandom = SecureRandom()
        val shared = CastRelayRequestRegistry()

        private fun randomToken(): String {
            val bytes = ByteArray(18)
            secureRandom.nextBytes(bytes)
            return Base64.encodeToString(
                bytes,
                Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
            )
        }
    }
}
