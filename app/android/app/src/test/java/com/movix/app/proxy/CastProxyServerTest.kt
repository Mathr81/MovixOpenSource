package com.movix.app.proxy

import java.net.InetAddress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CastProxyServerTest {
    private val receiver = InetAddress.getByName("192.168.77.8")
    private val origin = "https://www.gstatic.com"
    private val config = MediaProxyServerConfig.CastLan(
        bindAddress = InetAddress.getByName("192.168.77.2"),
        allowedClientAddress = receiver,
    )
    private val gate = CastRequestGate(config)

    @Test
    fun castServerDefaultValidationNeverUsesSystemDns() {
        val validator = mediaProxyUrlValidatorFor(config)

        val validated = validator("https://selected-network-only.invalid/master.m3u8")

        assertEquals("selected-network-only.invalid", validated.host)
    }

    @Test
    fun acceptsOnlyTheExactSocketPeerBeforeRequestAuthorization() {
        assertTrue(gate.acceptsPeer(receiver))
        assertFalse(gate.acceptsPeer(InetAddress.getByName("192.168.77.9")))
        assertFalse(gate.acceptsPeer(InetAddress.getByName("192.168.78.8")))
    }

    @Test
    fun keepsLoopbackAndCastPathNamespacesDisjoint() {
        assertEquals(
            CastRequestPath("session-token", "resource-token"),
            gate.parsePath("/cast/session-token/resource-token"),
        )
        assertNull(gate.parsePath("/p/process-token/session-token/resource-token"))
        assertNull(gate.parsePath("/cast/session-token/resource-token/extra"))
        assertNull(gate.parsePath("/cast/short/resource-token"))
    }

    @Test
    fun acceptsCanonicalHttpsOriginsButRejectsUnsafeOrigins() {
        assertTrue(gate.acceptsOrigin("GET", emptyMap()))
        assertTrue(gate.acceptsOrigin("HEAD", mapOf("Origin" to origin)))
        assertTrue(gate.acceptsOrigin("GET", mapOf("Origin" to "https://cast.google.com")))
        assertFalse(gate.acceptsOrigin("GET", mapOf("Origin" to "http://www.gstatic.com")))
        assertFalse(gate.acceptsOrigin("GET", mapOf("Origin" to "https://user@www.gstatic.com")))
        assertFalse(gate.acceptsOrigin("OPTIONS", emptyMap()))
        assertFalse(
            gate.acceptsOrigin(
                "OPTIONS",
                mapOf("Origin" to "not-an-origin"),
            ),
        )
    }

    @Test
    fun emitsExactCorsAndPrivateNetworkHeadersOnlyForValidPreflight() {
        val headers = gate.corsHeaders(
            method = "OPTIONS",
            requestHeaders = mapOf(
                "Origin" to origin,
                "Access-Control-Request-Method" to "GET",
                "Access-Control-Request-Private-Network" to "true",
            ),
        )

        assertEquals(origin, headers["Access-Control-Allow-Origin"])
        assertEquals("GET, HEAD, OPTIONS", headers["Access-Control-Allow-Methods"])
        assertEquals(
            "Range, Accept-Encoding, Content-Type",
            headers["Access-Control-Allow-Headers"],
        )
        assertTrue(headers["Access-Control-Expose-Headers"].orEmpty().contains("Content-Range"))
        assertTrue(headers["Vary"].orEmpty().contains("Origin"))
        assertEquals("true", headers["Access-Control-Allow-Private-Network"])
        assertFalse(headers.values.contains("*"))

        assertNull(
            gate.corsHeaders("GET", emptyMap())["Access-Control-Allow-Private-Network"],
        )
    }

    @Test
    fun allNestedCastResourcesRemainOpaqueCastUrls() {
        val tokens = ArrayDeque(
            listOf(
                "cast_session_0010",
                "cast_resource_010",
                "cast_resource_011",
                "cast_resource_012",
                "cast_resource_013",
                "cast_resource_014",
            ),
        )
        val store = MediaProxySessionStore(
            processSecret = "process_secret_01",
            tokenFactory = { tokens.removeFirst() },
        )
        val access = MediaProxySessionAccess.castLan(
            config.bindAddress,
            config.allowedClientAddress,
        )
        val root = store.createCast(
            "https://cdn.example/master.m3u8",
            "GET",
            emptyMap(),
            28126,
            access,
            CastMediaProfile.hlsTs(),
        )

        for (url in listOf(
            "https://cdn.example/variant.m3u8",
            "https://cdn.example/segment.ts",
            "https://cdn.example/key.bin",
            "https://cdn.example/audio.m3u8",
        )) {
            val local = store.registerResource(root.sessionId, url, 28126).localUrl
            assertTrue(local.startsWith("http://192.168.77.2:28126/cast/"))
            assertFalse(local.contains(url))
            assertFalse(local.contains("/p/"))
        }
    }

    @Test
    fun castPlaylistsLocalizeDirectSubtitleUrisWithoutDataWrappers() {
        val localized = mutableListOf<String>()
        val rewritten = MediaProxyPolicy.rewritePlaylist(
            playlist =
                "#EXTM3U\n" +
                    "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\"," +
                    "URI=\"captions/fr.vtt\"\n",
            baseUrl = "https://cdn.example/master/index.m3u8",
            wrapDirectSubtitles = false,
        ) { upstream ->
            localized += upstream
            "http://192.168.77.2:28126/cast/session_token/resource_token"
        }

        assertEquals(
            listOf("https://cdn.example/master/captions/fr.vtt"),
            localized,
        )
        assertTrue(rewritten.contains("/cast/session_token/resource_token"))
        assertFalse(rewritten.contains("data:"))
        assertFalse(rewritten.contains("cdn.example"))
    }
}
