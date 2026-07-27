package com.movix.app.proxy

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

internal data class MediaProxyTarget(
    val upstreamUrl: String,
    val method: String,
    val headers: Map<String, String>,
)

internal class MediaProxySessionStore(
    private val processSecret: String = randomToken(),
    private val now: () -> Long = System::currentTimeMillis,
    private val tokenFactory: () -> String = ::randomToken,
    private val idleTtlMs: Long = DEFAULT_IDLE_TTL_MS,
    private val maxSessions: Int = DEFAULT_MAX_SESSIONS,
    private val maxResourcesPerSession: Int = DEFAULT_MAX_RESOURCES,
) {
    private data class Session(
        val headers: Map<String, String>,
        val resources: LinkedHashMap<String, MediaProxyTarget> = linkedMapOf(),
        val resourceIdsByUrl: MutableMap<String, String> = mutableMapOf(),
        var lastAccessAt: Long,
    )

    private val lock = Any()
    private val sessions = linkedMapOf<String, Session>()

    fun create(
        upstreamUrl: String,
        method: String,
        headers: Map<String, String>,
        port: Int,
    ): String = synchronized(lock) {
        cleanupExpiredLocked()
        while (sessions.size >= maxSessions) {
            val oldestId = sessions.minByOrNull { it.value.lastAccessAt }?.key ?: break
            sessions.remove(oldestId)
        }

        val sessionId = uniqueSessionIdLocked()
        val resourceId = tokenFactory()
        val normalizedMethod = method.uppercase()
        val copiedHeaders = headers.toMap()
        val root = MediaProxyTarget(upstreamUrl, normalizedMethod, copiedHeaders)
        val session = Session(headers = copiedHeaders, lastAccessAt = now())
        session.resources[resourceId] = root
        session.resourceIdsByUrl[upstreamUrl] = resourceId
        sessions[sessionId] = session
        MediaProxyPolicy.buildLoopbackUrl(
            port,
            processSecret,
            sessionId,
            resourceId,
        )
    }

    fun register(
        sessionId: String,
        upstreamUrl: String,
        port: Int,
    ): String = synchronized(lock) {
        cleanupExpiredLocked()
        val session = sessions[sessionId]
            ?: throw IllegalArgumentException("Unknown media proxy session")
        session.lastAccessAt = now()
        val existingId = session.resourceIdsByUrl[upstreamUrl]
        if (existingId != null) {
            return@synchronized MediaProxyPolicy.buildLoopbackUrl(
                port,
                processSecret,
                sessionId,
                existingId,
            )
        }
        require(session.resources.size < maxResourcesPerSession) {
            "Media proxy session resource limit reached"
        }

        val resourceId = uniqueResourceIdLocked(session)
        session.resources[resourceId] = MediaProxyTarget(
            upstreamUrl = upstreamUrl,
            method = "GET",
            headers = session.headers,
        )
        session.resourceIdsByUrl[upstreamUrl] = resourceId
        MediaProxyPolicy.buildLoopbackUrl(
            port,
            processSecret,
            sessionId,
            resourceId,
        )
    }

    fun resolve(
        suppliedSecret: String,
        sessionId: String,
        resourceId: String,
    ): MediaProxyTarget? = synchronized(lock) {
        if (!constantTimeEquals(processSecret, suppliedSecret)) return@synchronized null
        cleanupExpiredLocked()
        val session = sessions[sessionId] ?: return@synchronized null
        val target = session.resources[resourceId] ?: return@synchronized null
        session.lastAccessAt = now()
        target
    }

    private fun cleanupExpiredLocked() {
        val cutoff = now() - idleTtlMs
        val iterator = sessions.iterator()
        while (iterator.hasNext()) {
            if (iterator.next().value.lastAccessAt < cutoff) {
                iterator.remove()
            }
        }
    }

    private fun uniqueSessionIdLocked(): String {
        repeat(8) {
            val candidate = tokenFactory()
            if (!sessions.containsKey(candidate)) return candidate
        }
        throw IllegalStateException("Unable to allocate media proxy session")
    }

    private fun uniqueResourceIdLocked(session: Session): String {
        repeat(8) {
            val candidate = tokenFactory()
            if (!session.resources.containsKey(candidate)) return candidate
        }
        throw IllegalStateException("Unable to allocate media proxy resource")
    }

    companion object {
        private const val DEFAULT_IDLE_TTL_MS = 30L * 60L * 1_000L
        private const val DEFAULT_MAX_SESSIONS = 512
        private const val DEFAULT_MAX_RESOURCES = 4_096
        private val secureRandom = SecureRandom()

        private fun randomToken(): String {
            val bytes = ByteArray(18)
            secureRandom.nextBytes(bytes)
            return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        }

        private fun constantTimeEquals(expected: String, supplied: String): Boolean {
            return MessageDigest.isEqual(
                expected.toByteArray(Charsets.UTF_8),
                supplied.toByteArray(Charsets.UTF_8),
            )
        }
    }
}
