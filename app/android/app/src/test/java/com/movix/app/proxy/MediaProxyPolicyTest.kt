package com.movix.app.proxy

import java.net.InetAddress
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaProxyPolicyTest {
    @Test
    fun rewritesRelativeAbsoluteAndQuotedPlaylistUris() {
        val input = """
            #EXTM3U
            video/720.m3u8
            https://media.example/absolute.ts
            #EXT-X-KEY:METHOD=AES-128,URI="key.bin"
            #EXT-X-MEDIA:TYPE=SUBTITLES,URI='subs/fr.m3u8'
            #EXT-X-MAP:URI="data:application/octet-stream;base64,AA=="
        """.trimIndent()

        val output = MediaProxyPolicy.rewritePlaylist(
            input,
            "https://cdn.example/root/master.m3u8",
        ) { "LOCAL:$it" }

        assertTrue(output.contains("LOCAL:https://cdn.example/root/video/720.m3u8"))
        assertTrue(output.contains("LOCAL:https://media.example/absolute.ts"))
        assertTrue(output.contains("URI=\"LOCAL:https://cdn.example/root/key.bin\""))
        assertTrue(output.contains("URI='LOCAL:https://cdn.example/root/subs/fr.m3u8'"))
        assertTrue(output.contains("URI=\"data:application/octet-stream;base64,AA==\""))
    }

    @Test
    fun wrapsDirectSubtitleFilesInAnInlinePlaylist() {
        val input = """
            #EXTM3U
            #EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",URI="subs/fr.vtt"
            video/1080.m3u8
        """.trimIndent()

        val output = MediaProxyPolicy.rewritePlaylist(
            input,
            "https://cdn.example/root/master.m3u8",
        ) { "LOCAL:$it" }

        val dataUriMatch = Regex(
            """URI="(data:application/vnd\.apple\.mpegurl,[^"]+)"""",
        ).find(output)
        assertTrue("Le sous-titre direct doit devenir une playlist data:", dataUriMatch != null)

        val wrapper = URLDecoder.decode(
            dataUriMatch!!.groupValues[1].substringAfter(','),
            StandardCharsets.UTF_8.name(),
        )
        assertTrue(wrapper.startsWith("#EXTM3U\n"))
        assertTrue(wrapper.contains("LOCAL:https://cdn.example/root/subs/fr.vtt"))
        assertTrue(output.contains("LOCAL:https://cdn.example/root/video/1080.m3u8"))
        assertFalse(output.contains("URI=\"LOCAL:https://cdn.example/root/subs/fr.vtt\""))
    }

    @Test
    fun validatesOnlyPublicHttpsDestinations() {
        val publicResolver = { _: String ->
            listOf(InetAddress.getByAddress(byteArrayOf(93, 184.toByte(), 216.toByte(), 34)))
        }

        val accepted = MediaProxyPolicy.validatePublicHttpsUrl(
            "https://cdn.example/video/master.m3u8",
            publicResolver,
        )
        assertEquals("https", accepted.scheme)
        assertEquals("cdn.example", accepted.host)

        for (url in listOf(
            "http://cdn.example/video.ts",
            "https://127.0.0.1/video.ts",
            "https://10.0.0.8/video.ts",
            "https://user:pass@cdn.example/video.ts",
            "https://cdn.example:8443/video.ts",
        )) {
            assertThrows(IllegalArgumentException::class.java) {
                MediaProxyPolicy.validatePublicHttpsUrl(url, publicResolver)
            }
        }
    }

    @Test
    fun rejectsPrivateDnsAnswers() {
        val privateResolver = { _: String ->
            listOf(InetAddress.getByAddress(byteArrayOf(192.toByte(), 168.toByte(), 1, 25)))
        }

        assertThrows(IllegalArgumentException::class.java) {
            MediaProxyPolicy.validatePublicHttpsUrl(
                "https://cdn.example/video.ts",
                privateResolver,
            )
        }
    }

    @Test
    fun sanitizesRequestHeadersWithAnAllowlist() {
        val sanitized = MediaProxyPolicy.sanitizeRequestHeaders(
            mapOf(
                "Origin" to "https://vidzy.org",
                "referer" to "https://vidzy.org/",
                "Range" to "bytes=0-1023",
                "Accept" to "*/*",
                "User-Agent" to "Movix",
                "Host" to "attacker.invalid",
                "Connection" to "keep-alive",
                "Cookie" to "secret=value",
                "Authorization" to "Bearer secret",
                "X-Injected" to "bad\r\nHeader: value",
            ),
        )

        assertEquals("https://vidzy.org", sanitized["Origin"])
        assertEquals("https://vidzy.org/", sanitized["Referer"])
        assertEquals("bytes=0-1023", sanitized["Range"])
        assertFalse(sanitized.containsKey("Host"))
        assertFalse(sanitized.containsKey("Connection"))
        assertFalse(sanitized.containsKey("Cookie"))
        assertFalse(sanitized.containsKey("Authorization"))
        assertFalse(sanitized.containsKey("X-Injected"))
    }

    @Test
    fun buildsOpaqueLoopbackUrls() {
        val localUrl = MediaProxyPolicy.buildLoopbackUrl(
            port = 28123,
            processSecret = "process-secret",
            sessionId = "session-id",
            resourceId = "resource-id",
        )

        assertEquals(
            "http://127.0.0.1:28123/p/process-secret/session-id/resource-id",
            localUrl,
        )
        assertFalse(localUrl.contains("vidzy"))
        assertFalse(localUrl.contains("m3u8"))
    }
}
