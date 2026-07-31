package com.movix.app.proxy

import java.net.URI
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

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
}
