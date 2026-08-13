package com.movix.app.proxy

import java.net.URI
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MediaProxySessionStoreTest {
    @Test
    fun createsOpaqueUrlsAndResolvesRegisteredResources() {
        val tokens = ArrayDeque(
            listOf(
                "session_token_0001",
                "resource_token_001",
                "resource_token_002",
            ),
        )
        val store = MediaProxySessionStore(
            processSecret = "process_secret_01",
            now = { 1_000L },
            tokenFactory = { tokens.removeFirst() },
        )

        val rootLocalUrl = store.create(
            upstreamUrl = "https://u14.vidzy.cc/movie/master.m3u8?token=secret",
            method = "GET",
            headers = mapOf("Referer" to "https://vidzy.org/"),
            port = 28_123,
        )

        assertTrue(rootLocalUrl.startsWith("http://127.0.0.1:28123/p/"))
        assertFalse(rootLocalUrl.contains("vidzy"))
        assertFalse(rootLocalUrl.contains("token=secret"))

        val rootPath = URI(rootLocalUrl).path.split('/').filter(String::isNotEmpty)
        val root = store.resolve(
            suppliedSecret = rootPath[1],
            sessionId = rootPath[2],
            resourceId = rootPath[3],
        )
        assertEquals(
            "https://u14.vidzy.cc/movie/master.m3u8?token=secret",
            root?.upstreamUrl,
        )
        assertEquals("GET", root?.method)
        assertEquals("https://vidzy.org/", root?.headers?.get("Referer"))

        val nestedLocalUrl = store.register(
            sessionId = rootPath[2],
            upstreamUrl = "https://u14.vidzy.cc/movie/segment.ts",
            port = 28_123,
        )
        val nestedPath = URI(nestedLocalUrl).path.split('/').filter(String::isNotEmpty)
        val nested = store.resolve(
            suppliedSecret = nestedPath[1],
            sessionId = nestedPath[2],
            resourceId = nestedPath[3],
        )
        assertEquals("https://u14.vidzy.cc/movie/segment.ts", nested?.upstreamUrl)
        assertEquals("GET", nested?.method)
    }

    @Test
    fun expiresIdleSessionsAndRejectsWrongSecrets() {
        var now = 5_000L
        val tokens = ArrayDeque(listOf("session_token_0002", "resource_token_003"))
        val store = MediaProxySessionStore(
            processSecret = "process_secret_02",
            now = { now },
            tokenFactory = { tokens.removeFirst() },
            idleTtlMs = 1_000L,
        )
        val localUrl = store.create(
            upstreamUrl = "https://r1.fsvid.lol/movie/master.m3u8",
            method = "GET",
            headers = emptyMap(),
            port = 28_124,
        )
        val path = URI(localUrl).path.split('/').filter(String::isNotEmpty)

        assertNull(store.resolve("wrong_secret_000", path[2], path[3]))
        now += 1_001L
        assertNull(store.resolve(path[1], path[2], path[3]))
    }

    @Test
    fun createsPublicCastSessionsWithoutLeakingHeadersIntoDiagnostics() {
        val tokens = ArrayDeque(listOf("cast_session_0001", "cast_resource_001"))
        val localAddress = java.net.InetAddress.getByName("192.168.50.2")
        val receiverAddress = java.net.InetAddress.getByName("192.168.50.9")
        val access = MediaProxySessionAccess.castLan(
            bindAddress = localAddress,
            allowedClientAddress = receiverAddress,
        )
        val store = MediaProxySessionStore(
            tokenFactory = { tokens.removeFirst() },
        )

        val registration = store.createCast(
            upstreamUrl = "https://cdn.example/master.m3u8?token=private",
            method = "GET",
            headers = emptyMap(),
            port = 28125,
            access = access,
            profile = CastMediaProfile.hlsTs(),
        )

        assertEquals(
            "http://192.168.50.2:28125/cast/cast_session_0001/cast_resource_001",
            registration.localUrl,
        )
        assertEquals(access, store.access(registration.sessionId))
        assertTrue(store.resolveCast(registration.sessionId, registration.resourceId) != null)
        assertNull(
            store.resolve(
                "process_secret_01",
                registration.sessionId,
                registration.resourceId,
            ),
        )
        assertFalse(
            store.describe(registration.sessionId).orEmpty().contains("token=private"),
        )
    }

    @Test
    fun invalidatesExpiresAndBoundsCastResources() {
        var now = 1_000L
        val tokens = ArrayDeque(
            listOf(
                "cast_session_0002",
                "cast_resource_002",
                "cast_resource_003",
            ),
        )
        val store = MediaProxySessionStore(
            now = { now },
            tokenFactory = { tokens.removeFirst() },
            idleTtlMs = 1_000L,
            maxResourcesPerSession = 2,
        )
        val access = MediaProxySessionAccess.castLan(
            java.net.InetAddress.getByName("192.168.10.4"),
            java.net.InetAddress.getByName("192.168.10.8"),
        )
        val root = store.createCast(
            "https://cdn.example/master.m3u8",
            "GET",
            emptyMap(),
            28125,
            access,
            CastMediaProfile.hlsTs(),
        )

        store.registerResource(
            root.sessionId,
            "https://cdn.example/segment.ts",
            28125,
        )
        assertThrows(IllegalArgumentException::class.java) {
            store.registerResource(
                root.sessionId,
                "https://cdn.example/other.ts",
                28125,
            )
        }
        store.invalidate(root.sessionId)
        assertNull(store.resolveCast(root.sessionId, root.resourceId))

        val expiryTokens = ArrayDeque(listOf("cast_session_0003", "cast_resource_004"))
        val expiryStore = MediaProxySessionStore(
            now = { now },
            tokenFactory = { expiryTokens.removeFirst() },
            idleTtlMs = 1_000L,
        )
        val expiring = expiryStore.createCast(
            "https://cdn.example/video.mp4",
            "GET",
            emptyMap(),
            28125,
            access,
            requireNotNull(CastMediaProfile.progressive("video/mp4")),
        )
        now += 1_001L
        expiryStore.cleanupExpired()
        assertNull(expiryStore.resolveCast(expiring.sessionId, expiring.resourceId))
    }

    @Test
    fun defaultCapacitySupportsTwoLongSeekStreamingVariants() {
        var token = 0
        val store = MediaProxySessionStore(
            processSecret = "process_secret_03",
            tokenFactory = { "opaque_resource_token_${++token}" },
        )
        val access = MediaProxySessionAccess.castLan(
            java.net.InetAddress.getByName("192.168.10.4"),
            java.net.InetAddress.getByName("192.168.10.8"),
        )
        val root = store.createCast(
            "https://cdn.example/master.m3u8",
            "GET",
            emptyMap(),
            28125,
            access,
            CastMediaProfile.hlsFmp4(),
        )

        var last = root
        repeat(2) { variant ->
            last = store.registerResource(
                root.sessionId,
                "https://cdn.example/f$variant/index.m3u8",
                28125,
            )
            repeat(2_538) { resource ->
                last = store.registerResource(
                    root.sessionId,
                    "https://cdn.example/f$variant/resource-$resource.m4s",
                    28125,
                )
            }
        }

        assertTrue(store.resolveCast(last.sessionId, last.resourceId) != null)
    }

    @Test
    fun storesDistinctPerResourceHeadersForProtectedTracks() {
        val tokens = ArrayDeque(
            listOf(
                "cast_session_0008",
                "cast_resource_020",
                "cast_resource_021",
            ),
        )
        val store = MediaProxySessionStore(tokenFactory = { tokens.removeFirst() })
        val access = MediaProxySessionAccess.castLan(
            java.net.InetAddress.getByName("192.168.10.4"),
            java.net.InetAddress.getByName("192.168.10.8"),
        )
        val root = store.createCast(
            "https://cdn.example/shared",
            "GET",
            mapOf("Referer" to "https://video.example/"),
            28125,
            access,
            CastMediaProfile.hlsTs(),
        )
        val track = store.registerResource(
            root.sessionId,
            "https://cdn.example/shared",
            28125,
            headers = mapOf("Referer" to "https://subtitles.example/"),
        )

        assertEquals(
            "https://video.example/",
            store.resolveCast(root.sessionId, root.resourceId)?.headers?.get("Referer"),
        )
        assertEquals(
            "https://subtitles.example/",
            store.resolveCast(track.sessionId, track.resourceId)?.headers?.get("Referer"),
        )
    }

    @Test
    fun consumesPreparedResponseOnceAndExpiresReplacementGrace() {
        var now = 2_000L
        val tokens = ArrayDeque(listOf("cast_session_0004", "cast_resource_005"))
        val store = MediaProxySessionStore(
            now = { now },
            tokenFactory = { tokens.removeFirst() },
        )
        val access = MediaProxySessionAccess.castLan(
            java.net.InetAddress.getByName("192.168.20.2"),
            java.net.InetAddress.getByName("192.168.20.7"),
        )
        val prepared = MediaProxyPreparedResponse(
            statusCode = 200,
            statusMessage = "OK",
            headers = mapOf("Content-Type" to "application/vnd.apple.mpegurl"),
            body = "#EXTM3U\nsegment.ts\n".toByteArray(),
            finalUrl = "https://cdn.example/master.m3u8",
        )
        val root = store.createCast(
            "https://cdn.example/master.m3u8",
            "GET",
            mapOf("Referer" to "https://player.example/"),
            28125,
            access,
            CastMediaProfile.hlsTs(),
            prepared,
        )

        assertEquals(
            prepared.body.toList(),
            store.peekPreparedResponse(root.sessionId, root.resourceId)?.body?.toList(),
        )
        assertEquals(
            prepared.body.toList(),
            store.peekPreparedResponse(root.sessionId, root.resourceId)?.body?.toList(),
        )
        assertEquals(
            prepared.body.toList(),
            store.consumePreparedResponse(root.sessionId, root.resourceId)?.body?.toList(),
        )
        assertNull(store.consumePreparedResponse(root.sessionId, root.resourceId))

        store.replaceAfterAcceptedLoad(root.sessionId, graceMs = 500L)
        now += 499L
        store.cleanupExpired()
        assertTrue(store.resolveCast(root.sessionId, root.resourceId) != null)
        now += 2L
        store.cleanupExpired()
        assertNull(store.resolveCast(root.sessionId, root.resourceId))
    }
}
