package com.movix.app.proxy

import java.io.ByteArrayInputStream
import java.net.URI
import java.net.URL
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaProxyServerTest {
    @Test
    fun rewritesPlaylistsAndStreamsNestedMediaLocally() {
        val requests = mutableListOf<Pair<MediaProxyTarget, Map<String, String>>>()
        val upstream = object : MediaProxyUpstream {
            override fun execute(
                target: MediaProxyTarget,
                localRequestHeaders: Map<String, String>,
            ): MediaProxyUpstreamResponse {
                requests += target to localRequestHeaders
                return if (target.upstreamUrl.endsWith("master.m3u8")) {
                    val playlist = "#EXTM3U\nsegment-001.ts\n"
                    MediaProxyUpstreamResponse(
                        statusCode = 200,
                        statusMessage = "OK",
                        headers = mapOf(
                            "Content-Type" to "application/vnd.apple.mpegurl",
                            "Content-Length" to playlist.toByteArray().size.toString(),
                        ),
                        body = ByteArrayInputStream(playlist.toByteArray()),
                        finalUrl = target.upstreamUrl,
                    )
                } else {
                    val bytes = byteArrayOf(10, 20, 30, 40)
                    MediaProxyUpstreamResponse(
                        statusCode = 206,
                        statusMessage = "Partial Content",
                        headers = mapOf(
                            "Content-Type" to "video/mp2t",
                            "Content-Length" to bytes.size.toString(),
                            "Content-Range" to "bytes 0-3/4",
                        ),
                        body = ByteArrayInputStream(bytes),
                        finalUrl = target.upstreamUrl,
                    )
                }
            }
        }
        val server = MediaProxyServer(
            upstream = upstream,
            validateUrl = { URI(it) },
        )

        try {
            val localMaster = server.open(
                upstreamUrl = "https://media.example/root/master.m3u8",
                method = "GET",
                headers = mapOf(
                    "Origin" to "https://purstream.mx",
                    "Referer" to "https://purstream.mx/",
                ),
            )
            val playlistConnection = URL(localMaster).openConnection()
            val playlist = playlistConnection.getInputStream().bufferedReader().readText()

            assertEquals("*", playlistConnection.getHeaderField("Access-Control-Allow-Origin"))
            assertTrue(playlist.contains("http://127.0.0.1:"))
            assertFalse(playlist.contains("media.example"))

            val localSegment = playlist.lineSequence()
                .first { it.isNotBlank() && !it.startsWith("#") }
            val segmentConnection = URL(localSegment).openConnection()
            segmentConnection.setRequestProperty("Origin", "https://movix.app")
            segmentConnection.setRequestProperty("Referer", "https://movix.app/")
            segmentConnection.setRequestProperty("Range", "bytes=0-3")
            val bytes = segmentConnection.getInputStream().readBytes()

            assertArrayEquals(byteArrayOf(10, 20, 30, 40), bytes)
            assertEquals("bytes 0-3/4", segmentConnection.getHeaderField("Content-Range"))
            assertEquals(2, requests.size)
            assertEquals(
                "https://purstream.mx/",
                requests[1].first.headers["Referer"],
            )
            assertEquals(
                "https://purstream.mx",
                requests[1].first.headers["Origin"],
            )
            assertEquals("bytes=0-3", requests[1].second["Range"])
            assertFalse(requests[1].second.containsKey("Origin"))
            assertFalse(requests[1].second.containsKey("Referer"))
        } finally {
            server.close()
        }
    }
}
