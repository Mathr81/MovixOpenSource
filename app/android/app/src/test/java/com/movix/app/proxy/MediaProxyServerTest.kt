package com.movix.app.proxy

import java.io.BufferedOutputStream
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.net.URI
import java.net.URL
import java.nio.charset.StandardCharsets
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MediaProxyServerTest {
    @Test
    fun resolvesOnlyAuthenticCurrentLoopbackUrlsForCastHandoff() {
        val server = MediaProxyServer(validateUrl = { URI(it) })

        try {
            val localUrl = server.open(
                "https://cdn.example/master.m3u8",
                "GET",
                mapOf("Referer" to "https://player.example/"),
            )
            val target = server.resolveLoopbackTargetForCast(localUrl)

            assertEquals("https://cdn.example/master.m3u8", target?.upstreamUrl)
            assertEquals("https://player.example/", target?.headers?.get("Referer"))
            assertEquals(
                null,
                server.resolveLoopbackTargetForCast(
                    localUrl.replace("/p/", "/p/tampered-token-"),
                ),
            )
            assertEquals(
                null,
                server.resolveLoopbackTargetForCast(
                    localUrl.replace("127.0.0.1", "localhost"),
                ),
            )
            assertEquals(
                null,
                server.resolveLoopbackTargetForCast(
                    localUrl.substringBeforeLast('/') + "/tampered_resource_001",
                ),
            )
        } finally {
            server.close()
        }
    }

    @Test
    fun loopbackDefaultsRemainBoundToPPathsAndWildcardCors() {
        val server = MediaProxyServer(
            upstream = object : MediaProxyUpstream {
                override fun execute(
                    target: MediaProxyTarget,
                    localRequestHeaders: Map<String, String>,
                ) = MediaProxyUpstreamResponse(
                    200,
                    "OK",
                    mapOf("Content-Type" to "video/mp4"),
                    ByteArrayInputStream(byteArrayOf(1)),
                    target.upstreamUrl,
                )
            },
            validateUrl = { URI(it) },
        )

        try {
            val localUrl = server.open(
                "https://cdn.example/video.mp4",
                "GET",
                mapOf("Referer" to "https://player.example/"),
            )
            val connection = URL(localUrl).openConnection()
            connection.getInputStream().close()

            assertEquals("127.0.0.1", server.boundAddress?.hostAddress)
            assertTrue(URI(localUrl).path.startsWith("/p/"))
            assertEquals("*", connection.getHeaderField("Access-Control-Allow-Origin"))
        } finally {
            server.close()
        }
    }

    @Test
    fun boundsAmbiguousPlaylistProbeReadRequests() {
        val playlist = buildString {
            append("#EXTM3U\nsegment-001.ts\n")
            repeat(2_048) { append('#') }
        }.toByteArray()
        val recordingBody = RecordingInputStream(playlist)
        val upstream = object : MediaProxyUpstream {
            override fun execute(
                target: MediaProxyTarget,
                localRequestHeaders: Map<String, String>,
            ) = MediaProxyUpstreamResponse(
                statusCode = 200,
                statusMessage = "OK",
                headers = mapOf("Content-Type" to "application/octet-stream"),
                body = recordingBody,
                finalUrl = "https://upstream.test/final/session",
            )
        }
        val server = MediaProxyServer(
            upstream = upstream,
            validateUrl = { URI(it) },
        )

        try {
            val localMaster = server.open(
                upstreamUrl = "https://media.example/opaque",
                method = "GET",
                headers = mapOf("Referer" to "https://movix1.embedseek.com/"),
            )
            val body = URL(localMaster).readText()

            assertTrue(body.contains("http://127.0.0.1:"))
            assertTrue(
                "La première demande de sonde doit rester bornée à 1024 octets",
                recordingBody.requestedLengths.first() <= 1_024,
            )
        } finally {
            server.close()
        }
    }

    @Test
    fun rejectsFragmentedLongNonPlaylistEarlyAndReplaysItByteForByte() {
        val expected = ByteArray(4_096) { (it % 251).toByte() }
        "NOT-HLS:".toByteArray().copyInto(expected)
        val recordingBody = RecordingInputStream(expected, maxChunkSize = 2)
        val upstream = object : MediaProxyUpstream {
            override fun execute(
                target: MediaProxyTarget,
                localRequestHeaders: Map<String, String>,
            ) = MediaProxyUpstreamResponse(
                statusCode = 200,
                statusMessage = "OK",
                headers = mapOf(
                    "Content-Type" to "application/octet-stream",
                    "Content-Length" to expected.size.toString(),
                ),
                body = recordingBody,
                finalUrl = "https://upstream.test/final/media",
            )
        }
        val server = MediaProxyServer(
            upstream = upstream,
            validateUrl = { URI(it) },
        )

        try {
            val localMedia = server.open(
                upstreamUrl = "https://media.example/opaque",
                method = "GET",
                headers = mapOf("Referer" to "https://movix1.embedseek.com/"),
            )
            val actual = URL(localMedia).openStream().readBytes()

            assertArrayEquals(expected, actual)
            assertTrue(
                "La sonde doit demander au plus 1024 octets",
                recordingBody.requestedLengths.first() <= 1_024,
            )
            assertTrue(
                "Le deuxième read sous-jacent doit être le streaming, pas la sonde",
                recordingBody.requestedLengths[1] > 1_024,
            )
            assertEquals(2, recordingBody.returnedLengths.first())
        } finally {
            server.close()
        }
    }

    @Test
    fun doesNotProbeKnownBinaryMedia() {
        val expected = "#EXTM3U\nraw-binary-payload\n".toByteArray()
        val upstream = object : MediaProxyUpstream {
            override fun execute(
                target: MediaProxyTarget,
                localRequestHeaders: Map<String, String>,
            ) = MediaProxyUpstreamResponse(
                statusCode = 200,
                statusMessage = "OK",
                headers = mapOf(
                    "Content-Type" to "video/mp2t",
                    "Content-Length" to expected.size.toString(),
                ),
                body = ByteArrayInputStream(expected),
                finalUrl = "https://upstream.test/final/media",
            )
        }
        val server = MediaProxyServer(
            upstream = upstream,
            validateUrl = { URI(it) },
        )

        try {
            val localMedia = server.open(
                upstreamUrl = "https://media.example/opaque",
                method = "GET",
                headers = mapOf("Referer" to "https://movix1.embedseek.com/"),
            )

            assertArrayEquals(expected, URL(localMedia).openStream().readBytes())
        } finally {
            server.close()
        }
    }

    @Test
    fun inboundHeadUsesUpstreamHeadAndNeverReadsTheMediaBody() {
        val methods = mutableListOf<String>()
        val upstream = object : MediaProxyUpstream {
            override fun execute(
                target: MediaProxyTarget,
                localRequestHeaders: Map<String, String>,
            ): MediaProxyUpstreamResponse {
                methods += target.method
                return MediaProxyUpstreamResponse(
                    statusCode = 200,
                    statusMessage = "OK",
                    headers = mapOf(
                        "Content-Type" to "video/mp4",
                        "Content-Length" to "900000000",
                        "Accept-Ranges" to "bytes",
                    ),
                    body = object : InputStream() {
                        override fun read(): Int {
                            error("HEAD response body must not be read")
                        }
                    },
                    finalUrl = target.upstreamUrl,
                )
            }
        }
        val server = MediaProxyServer(upstream, validateUrl = { URI(it) })

        try {
            val localMedia = server.open(
                "https://media.example/movie.mp4",
                "GET",
                mapOf("Referer" to "https://player.example/"),
            )
            val connection =
                URL(localMedia).openConnection() as java.net.HttpURLConnection
            connection.requestMethod = "HEAD"

            assertEquals(200, connection.responseCode)
            assertEquals("900000000", connection.getHeaderField("Content-Length"))
            assertEquals("bytes", connection.getHeaderField("Accept-Ranges"))
            assertEquals(listOf("HEAD"), methods)
        } finally {
            server.close()
        }
    }

    @Test
    fun recognizesFragmentedExtensionlessPlaylistPrefix() {
        val playlist = "\uFEFF  \n#EXTM3U\nsegment-001.ts\n"
        val upstream = object : MediaProxyUpstream {
            override fun execute(
                target: MediaProxyTarget,
                localRequestHeaders: Map<String, String>,
            ) = MediaProxyUpstreamResponse(
                statusCode = 200,
                statusMessage = "OK",
                headers = mapOf(
                    "Content-Type" to "application/octet-stream",
                    "Content-Length" to playlist.toByteArray().size.toString(),
                ),
                body = FragmentedInputStream(playlist.toByteArray(), maxChunkSize = 2),
                finalUrl = "https://upstream.test/final/session",
            )
        }
        val server = MediaProxyServer(
            upstream = upstream,
            validateUrl = { URI(it) },
        )

        try {
            val localMaster = server.open(
                upstreamUrl = "https://media.example/opaque",
                method = "GET",
                headers = mapOf("Referer" to "https://movix1.embedseek.com/"),
            )
            val body = URL(localMaster).readText()

            assertTrue(body.contains("http://127.0.0.1:"))
            assertFalse(body.contains("segment-001.ts"))
        } finally {
            server.close()
        }
    }

    @Test
    fun rewritesSeekPlaylistFromFinalUrlAndStreamsRangesLocally() {
        val requests = mutableListOf<Pair<MediaProxyTarget, Map<String, String>>>()
        val upstream = object : MediaProxyUpstream {
            override fun execute(
                target: MediaProxyTarget,
                localRequestHeaders: Map<String, String>,
            ): MediaProxyUpstreamResponse {
                requests += target to localRequestHeaders
                return if (requests.size == 1) {
                    val playlist = """
                        #EXTM3U
                        #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="fr",URI="audio/fr/index.m3u8"
                        #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="ja",URI="audio/ja/index.m3u8"
                        #EXT-X-STREAM-INF:BANDWIDTH=6500000,RESOLUTION=1920x1080,AUDIO="audio"
                        index-f2-v1.m3u8
                        #EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=1280x720,AUDIO="audio"
                        index-f1-v1.m3u8
                    """.trimIndent()
                    MediaProxyUpstreamResponse(
                        statusCode = 200,
                        statusMessage = "OK",
                        headers = mapOf(
                            "Content-Type" to "application/octet-stream",
                            "Content-Length" to playlist.toByteArray().size.toString(),
                        ),
                        body = ByteArrayInputStream(playlist.toByteArray()),
                        finalUrl = "https://upstream.test/final/session",
                    )
                } else if (target.upstreamUrl.endsWith("index-f2-v1.m3u8")) {
                    val playlist = "#EXTM3U\n#EXTINF:10,\nsegment-001.ts\n"
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
                    val bytes = ByteArray(100) { it.toByte() }
                    MediaProxyUpstreamResponse(
                        statusCode = 206,
                        statusMessage = "Partial Content",
                        headers = mapOf(
                            "Content-Type" to "video/mp2t",
                            "Content-Length" to bytes.size.toString(),
                            "Content-Range" to "bytes 0-99/1000",
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
                upstreamUrl = "https://185.237.106.181/v4/synthetic/master.m3u8?v=1",
                method = "GET",
                headers = mapOf(
                    "Origin" to "https://movix1.embedseek.com",
                    "Referer" to "https://movix1.embedseek.com/",
                ),
            )
            val playlistConnection = URL(localMaster).openConnection()
            val masterBody = playlistConnection.getInputStream().bufferedReader().readText()

            assertEquals("*", playlistConnection.getHeaderField("Access-Control-Allow-Origin"))
            assertEquals("https://movix1.embedseek.com", requests[0].first.headers["Origin"])
            assertEquals("https://movix1.embedseek.com/", requests[0].first.headers["Referer"])
            assertTrue(masterBody.contains("http://127.0.0.1:"))
            assertFalse(masterBody.contains("https://upstream.test/index-f2-v1.m3u8"))
            assertFalse(masterBody.contains("https://upstream.test/final/index-f2-v1.m3u8"))
            assertFalse(masterBody.contains("https://upstream.test/final/audio/fr/index.m3u8"))
            assertFalse(masterBody.contains("https://upstream.test/final/audio/ja/index.m3u8"))

            val local1080p = masterBody.lineSequence()
                .first { it.isNotBlank() && !it.startsWith("#") }
            val castTarget = server.resolveLoopbackTargetForCast(local1080p)

            assertEquals(
                "https://185.237.106.181/v4/synthetic/master.m3u8?v=1",
                castTarget?.upstreamUrl,
            )
            assertEquals(
                "https://movix1.embedseek.com",
                castTarget?.headers?.get("Origin"),
            )
            assertEquals(
                "https://movix1.embedseek.com/",
                castTarget?.headers?.get("Referer"),
            )
            assertFalse(
                castTarget?.upstreamUrl ==
                    "https://upstream.test/final/index-f2-v1.m3u8",
            )
            val variantBody = URL(local1080p).readText()
            val localSegment = variantBody.lineSequence()
                .first { it.isNotBlank() && !it.startsWith("#") }
            val segmentConnection = URL(localSegment).openConnection() as java.net.HttpURLConnection
            segmentConnection.setRequestProperty("Origin", "https://movix.app")
            segmentConnection.setRequestProperty("Referer", "https://movix.app/")
            segmentConnection.setRequestProperty("Range", "bytes=0-99")
            val bytes = segmentConnection.getInputStream().readBytes()

            assertArrayEquals(ByteArray(100) { it.toByte() }, bytes)
            assertEquals(206, segmentConnection.responseCode)
            assertEquals("bytes 0-99/1000", segmentConnection.getHeaderField("Content-Range"))
            assertEquals(3, requests.size)
            assertEquals(
                "https://movix1.embedseek.com/",
                requests[1].first.headers["Referer"],
            )
            assertEquals(
                "https://movix1.embedseek.com",
                requests[1].first.headers["Origin"],
            )
            assertEquals(
                "https://upstream.test/final/index-f2-v1.m3u8",
                requests[1].first.upstreamUrl,
            )
            assertEquals(
                "https://upstream.test/final/segment-001.ts",
                requests[2].first.upstreamUrl,
            )
            assertEquals("bytes=0-99", requests[2].second["Range"])
            assertFalse(requests[2].second.containsKey("Origin"))
            assertFalse(requests[2].second.containsKey("Referer"))
        } finally {
            server.close()
        }
    }

    @Test
    fun preparesWrappedCastSegmentAsMpegTsWithPayloadRelativeRange() {
        val png = syntheticPngEnvelope()
        val ts = ByteArray(3 * 188) { index -> (index % 251).toByte() }.also {
            repeat(3) { packet -> it[packet * 188] = 0x47 }
        }
        val response = MediaProxyUpstreamResponse(
            200,
            "OK",
            mapOf(
                "Content-Type" to "image/png",
                "Content-Length" to (png.size + ts.size).toString(),
                "ETag" to "png-representation-tag",
            ),
            ByteArrayInputStream(png + ts),
            "https://cdn.example/segment-0001.image?v=1",
        )

        response.use {
            val prepared = preparePngWrappedTsResponse(response, "bytes=188-375")
            assertEquals(206, prepared.statusCode)
            assertEquals("video/mp2t", prepared.headers["Content-Type"])
            assertEquals("bytes 188-375/${ts.size}", prepared.headers["Content-Range"])
            assertEquals("188", prepared.headers["Content-Length"])
            assertFalse(prepared.headers.containsKey("ETag"))
            assertArrayEquals(ts.copyOfRange(188, 376), readPreparedBody(prepared))
        }
    }

    @Test
    fun preparesWholeWrappedCastSegmentWithoutPngBytes() {
        val png = syntheticPngEnvelope()
        val ts = syntheticTsPayload()
        wrappedResponse(png, ts).use { response ->
            val prepared = preparePngWrappedTsResponse(response, null)
            val actual = readPreparedBody(prepared)

            assertEquals(200, prepared.statusCode)
            assertEquals("video/mp2t", prepared.headers["Content-Type"])
            assertEquals(ts.size.toString(), prepared.headers["Content-Length"])
            assertEquals(0x47, actual.first().toInt() and 0xff)
            assertArrayEquals(ts, actual)
        }
    }

    @Test
    fun rejectsMultipleRangeAgainstDecapsulatedLength() {
        val png = syntheticPngEnvelope()
        val ts = syntheticTsPayload()
        wrappedResponse(png, ts).use { response ->
            val prepared = preparePngWrappedTsResponse(response, "bytes=0-9,20-29")

            assertEquals(416, prepared.statusCode)
            assertEquals("bytes */${ts.size}", prepared.headers["Content-Range"])
            assertEquals("0", prepared.headers["Content-Length"])
            assertArrayEquals(ByteArray(0), readPreparedBody(prepared))
        }
    }

    @Test
    fun markedHeadWritesHeadersWithoutSeekingIntoPayloadRange() {
        val unreadableBody = object : InputStream() {
            override fun read(): Int = error("HEAD must not read the prepared payload")
        }
        val prepared = PreparedPngTsResponse(
            statusCode = 206,
            statusMessage = "Partial Content",
            headers = mapOf(
                "Content-Type" to "video/mp2t",
                "Content-Length" to "188",
                "Content-Range" to "bytes 900000000-900000187/1000000000",
            ),
            body = unreadableBody,
            skipBytes = 900_000_000L,
            bodyBytes = 188L,
        )
        val output = ByteArrayOutputStream()
        val server = MediaProxyServer(validateUrl = { URI(it) })

        try {
            server.writePreparedPngTsResponse(
                output = BufferedOutputStream(output),
                prepared = prepared,
                sendBody = false,
                corsHeaders = emptyMap(),
            )

            assertTrue(output.toString(Charsets.ISO_8859_1.name()).startsWith("HTTP/1.1 206"))
        } finally {
            server.close()
        }
    }

    @Test
    fun markedCastGetKeepsReceiverRangeLocalAndReturnsPayloadPartialContent() {
        val png = syntheticPngEnvelope()
        val ts = ByteArray(3 * 188) { index -> (index % 251).toByte() }.also {
            repeat(3) { packet -> it[packet * 188] = 0x47 }
        }
        val requests = mutableListOf<Pair<MediaProxyTarget, Map<String, String>>>()
        val upstream = recordingWrappedUpstream(png + ts, requests)
        withCastServer(upstream, CastMediaProfile.hlsTs(requiresPngTsUnwrap = true)) {
            _, localUrl ->
            val response = rawRequest(localUrl, "GET", mapOf("Range" to "BYTES=188-375"))

            assertTrue(response.headers.startsWith("HTTP/1.1 206 Partial Content"))
            assertEquals("bytes 188-375/${ts.size}", response.header("Content-Range"))
            assertEquals("video/mp2t", response.header("Content-Type"))
            assertArrayEquals(ts.copyOfRange(188, 376), response.body)
            assertEquals("GET", requests.single().first.method)
            assertFalse(requests.single().second.keys.any { it.equals("Range", ignoreCase = true) })
        }
    }

    @Test
    fun markedCastHeadUsesUpstreamGetAndRelaysNoBody() {
        val png = syntheticPngEnvelope()
        val ts = syntheticTsPayload()
        val requests = mutableListOf<Pair<MediaProxyTarget, Map<String, String>>>()
        val upstream = recordingWrappedUpstream(png + ts, requests)
        withCastServer(upstream, CastMediaProfile.hlsTs(requiresPngTsUnwrap = true)) {
            _, localUrl ->
            val response = rawRequest(localUrl, "HEAD", mapOf("Range" to "bytes=188-375"))

            assertTrue(response.headers.startsWith("HTTP/1.1 206 Partial Content"))
            assertEquals("188", response.header("Content-Length"))
            assertArrayEquals(ByteArray(0), response.body)
            assertEquals("GET", requests.single().first.method)
            assertFalse(requests.single().second.keys.any { it.equals("Range", ignoreCase = true) })
        }
    }

    @Test
    fun unmarkedCastImageKeepsReceiverRangeAndOriginalRepresentation() {
        val expected = syntheticPngEnvelope().copyOfRange(0, 10)
        val requests = mutableListOf<Pair<MediaProxyTarget, Map<String, String>>>()
        val upstream = object : MediaProxyUpstream {
            override fun execute(
                target: MediaProxyTarget,
                localRequestHeaders: Map<String, String>,
            ): MediaProxyUpstreamResponse {
                requests += target to localRequestHeaders
                return MediaProxyUpstreamResponse(
                    206,
                    "Partial Content",
                    mapOf(
                        "Content-Type" to "image/png",
                        "Content-Length" to expected.size.toString(),
                        "Content-Range" to "bytes 0-9/1000",
                    ),
                    ByteArrayInputStream(expected),
                    target.upstreamUrl,
                )
            }
        }
        withCastServer(upstream, CastMediaProfile.hlsTs()) { _, localUrl ->
            val response = rawRequest(localUrl, "GET", mapOf("Range" to "bytes=0-9"))

            assertTrue(response.headers.startsWith("HTTP/1.1 206 Partial Content"))
            assertEquals("image/png", response.header("Content-Type"))
            assertArrayEquals(expected, response.body)
            assertEquals("bytes=0-9", requests.single().second["Range"])
        }
    }

    @Test
    fun castFmp4ProfileNormalizesGenericExtensionlessIsoBmffMimeWithoutChangingBody() {
        listOf("ftyp", "styp", "moof", "sidx").forEach { boxType ->
            val expected = syntheticIsoBmffBox(boxType)
            val upstream = binaryUpstream(
                body = expected,
                contentTypeName = "cOnTeNt-TyPe",
                contentType = "application/octet-stream",
            )

            withCastServer(
                upstream = upstream,
                profile = CastMediaProfile.hlsFmp4(),
                upstreamUrl = "https://cdn.example/opaque-fragment?box=$boxType",
            ) { _, localUrl ->
                val response = rawRequest(localUrl, "GET")

                assertTrue(response.headers.startsWith("HTTP/1.1 200 OK"))
                assertEquals("video/mp4", response.header("Content-Type"))
                assertEquals(expected.size.toString(), response.header("Content-Length"))
                assertEquals("bytes", response.header("Accept-Ranges"))
                assertArrayEquals(expected, response.body)
                assertEquals(
                    1,
                    response.headers.lineSequence().count {
                        it.substringBefore(':').equals("Content-Type", ignoreCase = true)
                    },
                )
            }
        }
    }

    @Test
    fun castFmp4ProfileDoesNotNormalizeUnknownOrAesLikeBytes() {
        val payloads = listOf(
            ByteArray(64) { index -> (index * 37 + 11).toByte() },
            byteArrayOf(
                0x53, 0x8a.toByte(), 0x21, 0xfc.toByte(),
                'm'.code.toByte(), 'o'.code.toByte(), 'o'.code.toByte(), 'f'.code.toByte(),
                0x1d, 0xe0.toByte(), 0x45, 0x73,
                0xaa.toByte(), 0x16, 0x8c.toByte(), 0x3f,
            ),
        )

        payloads.forEachIndexed { index, expected ->
            withCastServer(
                upstream = binaryUpstream(expected),
                profile = CastMediaProfile.hlsFmp4(),
                upstreamUrl = "https://cdn.example/opaque-data?id=$index",
            ) { _, localUrl ->
                val response = rawRequest(localUrl, "GET")

                assertEquals("application/octet-stream", response.header("Content-Type"))
                assertArrayEquals(expected, response.body)
            }
        }
    }

    @Test
    fun castTsProfileDoesNotNormalizeExtensionlessIsoBmffMime() {
        val expected = syntheticIsoBmffBox("moof")

        withCastServer(
            upstream = binaryUpstream(expected),
            profile = CastMediaProfile.hlsTs(),
            upstreamUrl = "https://cdn.example/opaque-fragment",
        ) { _, localUrl ->
            val response = rawRequest(localUrl, "GET")

            assertEquals("application/octet-stream", response.header("Content-Type"))
            assertArrayEquals(expected, response.body)
        }
    }

    @Test
    fun castFmp4ProfilePreservesExplicitNonFmp4Mime() {
        val expected = syntheticIsoBmffBox("ftyp")

        withCastServer(
            upstream = binaryUpstream(expected, contentType = "audio/aac"),
            profile = CastMediaProfile.hlsFmp4(),
            upstreamUrl = "https://cdn.example/opaque-fragment",
        ) { _, localUrl ->
            val response = rawRequest(localUrl, "GET")

            assertEquals("audio/aac", response.header("Content-Type"))
            assertArrayEquals(expected, response.body)
        }
    }

    @Test
    fun loopbackDoesNotNormalizeGenericExtensionlessIsoBmffMime() {
        val expected = syntheticIsoBmffBox("ftyp")
        val server = MediaProxyServer(
            upstream = binaryUpstream(expected),
            validateUrl = { URI(it) },
        )

        try {
            val localUrl = server.open(
                upstreamUrl = "https://cdn.example/opaque-fragment",
                method = "GET",
                headers = mapOf("Referer" to "https://player.example/"),
            )
            val response = rawRequest(localUrl, "GET")

            assertEquals("application/octet-stream", response.header("Content-Type"))
            assertArrayEquals(expected, response.body)
        } finally {
            server.close()
        }
    }

    @Test
    fun rewrittenCastPlaylistEmitsOnlyItsRewrittenContentLength() {
        val playlist = """
            #EXTM3U
            #EXT-X-TARGETDURATION:4
            #EXT-X-VERSION:6
            #EXT-X-MAP:URI="init.mp4"
            #EXTINF:4.000,
            seg-1.m4s
            #EXT-X-ENDLIST
        """.trimIndent()
        val upstream = object : MediaProxyUpstream {
            override fun execute(
                target: MediaProxyTarget,
                localRequestHeaders: Map<String, String>,
            ) = MediaProxyUpstreamResponse(
                statusCode = 200,
                statusMessage = "OK",
                headers = linkedMapOf(
                    "content-type" to "application/vnd.apple.mpegurl",
                    "content-length" to playlist.toByteArray().size.toString(),
                ),
                body = ByteArrayInputStream(playlist.toByteArray()),
                finalUrl = target.upstreamUrl,
            )
        }
        val address = castTestAddress()
        assumeNotNull(address)
        val castAddress = requireNotNull(address)
        var token = 0
        val store = MediaProxySessionStore(
            processSecret = "process_token_001",
            tokenFactory = { "cast_opaque_token_${++token}" },
        )
        val server = MediaProxyServer(
            upstream = upstream,
            config = MediaProxyServerConfig.CastLan(castAddress, castAddress),
            validateUrl = { URI(it) },
            sessionStore = store,
        )

        try {
            val port = server.start()
            val localUrl = store.createCast(
                upstreamUrl = "https://cdn.example/index-f1-v1-a1.m3u8",
                method = "GET",
                headers = emptyMap(),
                port = port,
                access = MediaProxySessionAccess.castLan(castAddress, castAddress),
                profile = CastMediaProfile.hlsFmp4(),
            ).localUrl

            val response = rawRequest(localUrl, "GET")
            val contentLengths = response.headers.lineSequence()
                .drop(1)
                .filter {
                    it.substringBefore(':').equals("Content-Length", ignoreCase = true)
                }
                .map { it.substringAfter(':').trim() }
                .toList()

            assertEquals(listOf(response.body.size.toString()), contentLengths)
            assertTrue(response.body.size > playlist.toByteArray().size)
        } finally {
            server.close()
        }
    }

    @Test
    fun failedCastFmp4StreamDoesNotAppendSecondHttpStatus() {
        val prefix = syntheticIsoBmffBox("moof") + ByteArray(5_000)
        val upstream = object : MediaProxyUpstream {
            override fun execute(
                target: MediaProxyTarget,
                localRequestHeaders: Map<String, String>,
            ) = MediaProxyUpstreamResponse(
                statusCode = 200,
                statusMessage = "OK",
                headers = mapOf(
                    "Content-Type" to "application/octet-stream",
                    "Content-Length" to (prefix.size + 1).toString(),
                ),
                body = object : InputStream() {
                    private val delegate = ByteArrayInputStream(prefix)

                    override fun read(): Int {
                        val value = delegate.read()
                        if (value == -1) throw IOException("synthetic downstream read failure")
                        return value
                    }

                    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                        val count = delegate.read(buffer, offset, length)
                        if (count == -1) throw IOException("synthetic downstream read failure")
                        return count
                    }
                },
                finalUrl = target.upstreamUrl,
            )
        }

        withCastServer(
            upstream = upstream,
            profile = CastMediaProfile.hlsFmp4(),
            upstreamUrl = "https://cdn.example/opaque-fragment",
        ) { _, localUrl ->
            val response = rawRequest(localUrl, "GET")
            val wireText = response.raw.toString(StandardCharsets.ISO_8859_1)

            assertTrue(response.headers.startsWith("HTTP/1.1 200 OK"))
            assertEquals(1, Regex("HTTP/1\\.1 ").findAll(wireText).count())
            assertFalse(wireText.contains("HTTP/1.1 502 Bad Gateway"))
        }
    }

    @Test
    fun truncatedMarkedCastBodyDoesNotAppendSecondHttpStatus() {
        val png = syntheticPngEnvelope()
        val ts = syntheticTsPayload()
        val requests = mutableListOf<Pair<MediaProxyTarget, Map<String, String>>>()
        val upstream = recordingWrappedUpstream(
            body = png + ts,
            requests = requests,
            declaredLength = (png.size + ts.size + 188).toLong(),
        )
        withCastServer(upstream, CastMediaProfile.hlsTs(requiresPngTsUnwrap = true)) {
            _, localUrl ->
            val response = rawRequest(localUrl, "GET")
            val wireText = response.raw.toString(StandardCharsets.ISO_8859_1)

            assertTrue(response.headers.startsWith("HTTP/1.1 200 OK"))
            assertEquals(1, Regex("HTTP/1\\.1 ").findAll(wireText).count())
            assertFalse(wireText.contains("HTTP/1.1 502 Bad Gateway"))
        }
    }

    private fun recordingWrappedUpstream(
        body: ByteArray,
        requests: MutableList<Pair<MediaProxyTarget, Map<String, String>>>,
        declaredLength: Long = body.size.toLong(),
    ): MediaProxyUpstream = object : MediaProxyUpstream {
        override fun execute(
            target: MediaProxyTarget,
            localRequestHeaders: Map<String, String>,
        ): MediaProxyUpstreamResponse {
            requests += target to localRequestHeaders
            return MediaProxyUpstreamResponse(
                200,
                "OK",
                mapOf(
                    "Content-Type" to "image/png",
                    "Content-Length" to declaredLength.toString(),
                    "ETag" to "png-representation-tag",
                ),
                ByteArrayInputStream(body),
                target.upstreamUrl,
            )
        }
    }

    private fun withCastServer(
        upstream: MediaProxyUpstream,
        profile: CastMediaProfile,
        upstreamUrl: String = "https://cdn.example/segment-0001.image?v=1",
        block: (MediaProxyServer, String) -> Unit,
    ) {
        val discoveredAddress = castTestAddress()
        assumeNotNull(discoveredAddress)
        val address = requireNotNull(discoveredAddress)
        val tokens = ArrayDeque(listOf("cast_session_0010", "cast_resource_010"))
        val store = MediaProxySessionStore(
            processSecret = "process_token_001",
            tokenFactory = { tokens.removeFirst() },
        )
        val config = MediaProxyServerConfig.CastLan(address, address)
        val server = MediaProxyServer(
            upstream = upstream,
            config = config,
            validateUrl = { URI(it) },
            sessionStore = store,
        )
        val port = server.start()
        val registration = store.createCast(
            upstreamUrl = upstreamUrl,
            method = "GET",
            headers = emptyMap(),
            port = port,
            access = MediaProxySessionAccess.castLan(address, address),
            profile = profile,
        )
        try {
            block(server, registration.localUrl)
        } finally {
            server.close()
        }
    }

    private fun binaryUpstream(
        body: ByteArray,
        contentTypeName: String = "Content-Type",
        contentType: String = "application/octet-stream",
    ): MediaProxyUpstream = object : MediaProxyUpstream {
        override fun execute(
            target: MediaProxyTarget,
            localRequestHeaders: Map<String, String>,
        ) = MediaProxyUpstreamResponse(
            statusCode = 200,
            statusMessage = "OK",
            headers = linkedMapOf(
                contentTypeName to contentType,
                "Content-Length" to body.size.toString(),
                "Accept-Ranges" to "bytes",
            ),
            body = ByteArrayInputStream(body),
            finalUrl = target.upstreamUrl,
        )
    }

    private fun syntheticIsoBmffBox(type: String): ByteArray {
        require(type.length == 4)
        return ByteArrayOutputStream().also { output ->
            DataOutputStream(output).use {
                it.writeInt(24)
                it.write(type.toByteArray(StandardCharsets.US_ASCII))
                it.write(ByteArray(16) { index -> (index * 13 + 5).toByte() })
            }
        }.toByteArray()
    }

    private fun castTestAddress(): InetAddress? {
        val interfaces = runCatching { NetworkInterface.getNetworkInterfaces() }
            .getOrNull()
            ?: return null
        while (interfaces.hasMoreElements()) {
            val network = interfaces.nextElement()
            val usableInterface = runCatching { network.isUp && !network.isLoopback }
                .getOrDefault(false)
            if (!usableInterface) continue
            val addresses = network.inetAddresses
            while (addresses.hasMoreElements()) {
                val address = addresses.nextElement()
                if (
                    address is Inet4Address &&
                    runCatching { MediaProxyPolicy.requireUsableCastLanAddress(address) }.isSuccess
                ) {
                    return address
                }
            }
        }
        return null
    }

    private data class RawHttpResponse(
        val raw: ByteArray,
        val headers: String,
        val body: ByteArray,
    ) {
        fun header(name: String): String? = headers.lineSequence()
            .drop(1)
            .firstOrNull { it.substringBefore(':').equals(name, ignoreCase = true) }
            ?.substringAfter(':')
            ?.trim()
    }

    private fun rawRequest(
        url: String,
        method: String,
        headers: Map<String, String> = emptyMap(),
    ): RawHttpResponse {
        val uri = URI(url)
        val socket = Socket()
        socket.soTimeout = 30_000
        socket.connect(InetSocketAddress(InetAddress.getByName(uri.host), uri.port))
        socket.use {
            val request = buildString {
                append(method).append(' ').append(uri.rawPath).append(" HTTP/1.1\r\n")
                append("Host: ").append(uri.rawAuthority).append("\r\n")
                headers.forEach { (name, value) ->
                    append(name).append(": ").append(value).append("\r\n")
                }
                append("Connection: close\r\n\r\n")
            }
            it.getOutputStream().write(request.toByteArray(StandardCharsets.ISO_8859_1))
            it.getOutputStream().flush()
            val raw = it.getInputStream().readBytes()
            val separator = raw.indexOfHeaderEnd()
            assertTrue("HTTP response must contain a header terminator", separator >= 0)
            return RawHttpResponse(
                raw = raw,
                headers = String(raw, 0, separator, StandardCharsets.ISO_8859_1),
                body = raw.copyOfRange(separator + 4, raw.size),
            )
        }
    }

    private fun ByteArray.indexOfHeaderEnd(): Int {
        for (index in 0..size - 4) {
            if (
                this[index] == '\r'.code.toByte() &&
                this[index + 1] == '\n'.code.toByte() &&
                this[index + 2] == '\r'.code.toByte() &&
                this[index + 3] == '\n'.code.toByte()
            ) {
                return index
            }
        }
        return -1
    }

    private fun wrappedResponse(
        png: ByteArray,
        ts: ByteArray,
    ): MediaProxyUpstreamResponse = MediaProxyUpstreamResponse(
        200,
        "OK",
        mapOf(
            "Content-Type" to "image/png",
            "Content-Length" to (png.size + ts.size).toString(),
            "ETag" to "png-representation-tag",
        ),
        ByteArrayInputStream(png + ts),
        "https://cdn.example/segment-0001.image?v=1",
    )

    private fun readPreparedBody(prepared: PreparedPngTsResponse): ByteArray {
        var remainingSkip = prepared.skipBytes
        while (remainingSkip > 0L) {
            val skipped = prepared.body.skip(remainingSkip)
            if (skipped <= 0L) {
                assertTrue(prepared.body.read() != -1)
                remainingSkip -= 1L
            } else {
                remainingSkip -= skipped
            }
        }
        val expected = prepared.bodyBytes ?: return prepared.body.readBytes()
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        var remaining = expected
        while (remaining > 0L) {
            val count = prepared.body.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
            assertTrue(count > 0)
            output.write(buffer, 0, count)
            remaining -= count
        }
        return output.toByteArray()
    }

    private fun syntheticPngEnvelope(): ByteArray {
        val signature = byteArrayOf(
            0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        )
        return signature +
            syntheticPngChunk("IHDR", ByteArray(13)) +
            syntheticPngChunk("IDAT", byteArrayOf(1, 2, 3)) +
            syntheticPngChunk("IEND", ByteArray(0))
    }

    private fun syntheticPngChunk(type: String, data: ByteArray): ByteArray {
        val output = ByteArrayOutputStream()
        DataOutputStream(output).use {
            it.writeInt(data.size)
            it.write(type.toByteArray(Charsets.US_ASCII))
            it.write(data)
            it.writeInt(0)
        }
        return output.toByteArray()
    }

    private fun syntheticTsPayload(): ByteArray = ByteArray(3 * 188).also { bytes ->
        repeat(3) { packet -> bytes[packet * 188] = 0x47 }
    }
}

private class FragmentedInputStream(
    bytes: ByteArray,
    maxChunkSize: Int,
) : RecordingInputStream(bytes, maxChunkSize)

private open class RecordingInputStream(
    bytes: ByteArray,
    private val maxChunkSize: Int = Int.MAX_VALUE,
) : InputStream() {
    private val delegate = ByteArrayInputStream(bytes)
    val requestedLengths = mutableListOf<Int>()
    val returnedLengths = mutableListOf<Int>()

    override fun read(): Int {
        requestedLengths += 1
        val value = delegate.read()
        returnedLengths += if (value == -1) -1 else 1
        return value
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        requestedLengths += length
        val count = delegate.read(buffer, offset, minOf(length, maxChunkSize))
        returnedLengths += count
        return count
    }

    override fun close() {
        delegate.close()
    }
}
