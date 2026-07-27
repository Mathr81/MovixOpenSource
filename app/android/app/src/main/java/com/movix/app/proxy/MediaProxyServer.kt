package com.movix.app.proxy

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.net.URI
import java.net.UnknownHostException
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.Dns
import okhttp3.Headers
import okhttp3.OkHttpClient
import okhttp3.Request

internal interface MediaProxyUpstream {
    fun execute(
        target: MediaProxyTarget,
        localRequestHeaders: Map<String, String>,
    ): MediaProxyUpstreamResponse
}

internal class MediaProxyUpstreamResponse(
    val statusCode: Int,
    val statusMessage: String,
    val headers: Map<String, String>,
    val body: InputStream,
    val finalUrl: String,
    private val onClose: () -> Unit = {},
) : Closeable {
    override fun close() {
        try {
            body.close()
        } finally {
            onClose()
        }
    }
}

internal class OkHttpMediaProxyUpstream(
    private val validateUrl: (String) -> URI = {
        MediaProxyPolicy.validatePublicHttpsUrl(it)
    },
) : MediaProxyUpstream {
    private val safeDns = object : Dns {
        override fun lookup(hostname: String): List<InetAddress> {
            val addresses = Dns.SYSTEM.lookup(hostname)
            if (addresses.isEmpty() || addresses.any(MediaProxyPolicy::isForbiddenAddress)) {
                throw UnknownHostException("Private or unresolved media host")
            }
            return addresses
        }
    }
    private val client = OkHttpClient.Builder()
        .dns(safeDns)
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    override fun execute(
        target: MediaProxyTarget,
        localRequestHeaders: Map<String, String>,
    ): MediaProxyUpstreamResponse {
        val mergedHeaders = linkedMapOf<String, String>()
        mergedHeaders.putAll(MediaProxyPolicy.sanitizeRequestHeaders(target.headers))
        mergedHeaders.putAll(MediaProxyPolicy.sanitizeLocalRequestHeaders(localRequestHeaders))
        if (!mergedHeaders.containsKey("User-Agent")) {
            mergedHeaders["User-Agent"] = DEFAULT_USER_AGENT
        }

        var currentUrl = target.upstreamUrl
        repeat(MAX_REDIRECTS + 1) { redirectCount ->
            validateUrl(currentUrl)
            val headerBuilder = Headers.Builder()
            for ((name, value) in mergedHeaders) {
                headerBuilder.set(name, value)
            }
            val requestBuilder = Request.Builder()
                .url(currentUrl)
                .headers(headerBuilder.build())
            if (target.method == "HEAD") {
                requestBuilder.head()
            } else {
                requestBuilder.get()
            }

            val response = client.newCall(requestBuilder.build()).execute()
            val location = response.header("Location")
            if (response.code in 300..399 && location != null) {
                if (redirectCount >= MAX_REDIRECTS) {
                    response.close()
                    throw IllegalStateException("Too many media redirects")
                }
                val nextUrl = response.request.url.resolve(location)?.toString()
                response.close()
                currentUrl = nextUrl
                    ?: throw IllegalArgumentException("Invalid media redirect")
                return@repeat
            }

            val responseHeaders = linkedMapOf<String, String>()
            for (name in response.headers.names()) {
                responseHeaders[name] = response.headers.values(name).joinToString(", ")
            }
            val responseBody = response.body
            return MediaProxyUpstreamResponse(
                statusCode = response.code,
                statusMessage = response.message,
                headers = responseHeaders,
                body = responseBody?.byteStream() ?: ByteArrayInputStream(ByteArray(0)),
                finalUrl = response.request.url.toString(),
                onClose = response::close,
            )
        }
        throw IllegalStateException("Media redirect resolution failed")
    }

    companion object {
        private const val MAX_REDIRECTS = 5
        private const val DEFAULT_USER_AGENT =
            "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
    }
}

internal class MediaProxyServer(
    private val upstream: MediaProxyUpstream = OkHttpMediaProxyUpstream(),
    private val validateUrl: (String) -> URI = {
        MediaProxyPolicy.validatePublicHttpsUrl(it)
    },
    private val validateDiscoveredUrl: (String) -> URI =
        MediaProxyPolicy::validateHttpsUrlSyntax,
    private val sessionStore: MediaProxySessionStore = MediaProxySessionStore(),
) : Closeable {
    private val running = AtomicBoolean(false)
    private val closed = AtomicBoolean(false)
    private val startLock = Any()
    private val workerCounter = java.util.concurrent.atomic.AtomicInteger()
    private val workers = ThreadPoolExecutor(
        4,
        32,
        30L,
        TimeUnit.SECONDS,
        ArrayBlockingQueue(128),
        { task ->
            Thread(
                task,
                "MovixMediaProxy-${workerCounter.incrementAndGet()}",
            ).apply { isDaemon = true }
        },
        ThreadPoolExecutor.AbortPolicy(),
    )

    @Volatile
    private var serverSocket: ServerSocket? = null

    fun open(
        upstreamUrl: String,
        method: String,
        headers: Map<String, String>,
    ): String {
        check(!closed.get()) { "Media proxy is closed" }
        val normalizedMethod = method.uppercase(Locale.US)
        require(normalizedMethod == "GET" || normalizedMethod == "HEAD") {
            "Unsupported media proxy method"
        }
        val validated = validateUrl(upstreamUrl).toString()
        val sanitizedHeaders = MediaProxyPolicy.sanitizeRequestHeaders(headers)
        require(sanitizedHeaders.isNotEmpty()) { "Protected media headers required" }
        val port = ensureStarted()
        return sessionStore.create(
            upstreamUrl = validated,
            method = normalizedMethod,
            headers = sanitizedHeaders,
            port = port,
        )
    }

    private fun ensureStarted(): Int = synchronized(startLock) {
        serverSocket?.takeIf { !it.isClosed }?.localPort?.let { return it }
        check(!closed.get()) { "Media proxy is closed" }

        val socket = ServerSocket()
        socket.reuseAddress = true
        socket.bind(InetSocketAddress(InetAddress.getByName(LOOPBACK_HOST), 0), 64)
        serverSocket = socket
        running.set(true)
        Thread({ acceptLoop(socket) }, "MovixMediaProxy-Acceptor").apply {
            isDaemon = true
            start()
        }
        socket.localPort
    }

    private fun acceptLoop(socket: ServerSocket) {
        while (running.get() && !socket.isClosed) {
            val client = try {
                socket.accept()
            } catch (_: SocketException) {
                break
            } catch (_: Throwable) {
                continue
            }

            if (!client.inetAddress.isLoopbackAddress) {
                runCatching { client.close() }
                continue
            }
            try {
                workers.execute { handleClient(client) }
            } catch (_: Throwable) {
                runCatching { client.close() }
            }
        }
    }

    private fun handleClient(socket: Socket) {
        socket.use { client ->
            client.soTimeout = 30_000
            val input = BufferedInputStream(client.getInputStream())
            val output = BufferedOutputStream(client.getOutputStream())
            try {
                val requestLine = readAsciiLine(input, MAX_REQUEST_LINE)
                    ?: return
                val requestParts = requestLine.split(' ')
                if (requestParts.size != 3 || !requestParts[2].startsWith("HTTP/1.")) {
                    writeError(output, 400, "Bad Request")
                    return
                }
                val method = requestParts[0].uppercase(Locale.US)
                val path = runCatching { URI(requestParts[1]).path }
                    .getOrNull()
                    ?: run {
                        writeError(output, 400, "Bad Request")
                        return
                    }
                val requestHeaders = readHeaders(input)
                val pathParts = path.split('/').filter(String::isNotEmpty)
                if (pathParts.size != 4 || pathParts[0] != "p") {
                    writeError(output, 404, "Not Found")
                    return
                }

                val target = sessionStore.resolve(
                    suppliedSecret = pathParts[1],
                    sessionId = pathParts[2],
                    resourceId = pathParts[3],
                ) ?: run {
                    writeError(output, 404, "Not Found")
                    return
                }

                if (method == "OPTIONS") {
                    writeHeaders(output, 204, "No Content", emptyMap(), 0L)
                    return
                }
                if (method != "GET" && method != "HEAD") {
                    writeError(output, 405, "Method Not Allowed")
                    return
                }

                validateUrl(target.upstreamUrl)
                val localHeaders =
                    MediaProxyPolicy.sanitizeLocalRequestHeaders(requestHeaders)
                upstream.execute(target, localHeaders).use { response ->
                    if (isPlaylist(response)) {
                        writePlaylistResponse(
                            output = output,
                            response = response,
                            sessionId = pathParts[2],
                            port = requireNotNull(serverSocket).localPort,
                            sendBody = method != "HEAD",
                        )
                    } else {
                        writeStreamingResponse(
                            output = output,
                            response = response,
                            sendBody = method != "HEAD",
                        )
                    }
                }
            } catch (_: Throwable) {
                runCatching { writeError(output, 502, "Bad Gateway") }
            }
        }
    }

    private fun writePlaylistResponse(
        output: BufferedOutputStream,
        response: MediaProxyUpstreamResponse,
        sessionId: String,
        port: Int,
        sendBody: Boolean,
    ) {
        val original = readLimited(response.body, MAX_PLAYLIST_BYTES)
            .toString(StandardCharsets.UTF_8)
        val rewritten = MediaProxyPolicy.rewritePlaylist(
            playlist = original,
            baseUrl = response.finalUrl,
        ) { discoveredUrl ->
            val validated = validateDiscoveredUrl(discoveredUrl).toString()
            sessionStore.register(sessionId, validated, port)
        }
        val bytes = rewritten.toByteArray(StandardCharsets.UTF_8)
        val headers = filteredResponseHeaders(response.headers).toMutableMap()
        headers["Content-Type"] =
            getHeader(response.headers, "Content-Type")
                ?: "application/vnd.apple.mpegurl"
        headers["Content-Length"] = bytes.size.toString()
        writeHeaders(
            output,
            response.statusCode,
            response.statusMessage,
            headers,
            bytes.size.toLong(),
        )
        if (sendBody) output.write(bytes)
        output.flush()
    }

    private fun writeStreamingResponse(
        output: BufferedOutputStream,
        response: MediaProxyUpstreamResponse,
        sendBody: Boolean,
    ) {
        val headers = filteredResponseHeaders(response.headers)
        val contentLength = getHeader(response.headers, "Content-Length")?.toLongOrNull()
        writeHeaders(
            output,
            response.statusCode,
            response.statusMessage,
            headers,
            contentLength,
        )
        if (sendBody) {
            response.body.copyTo(output, DEFAULT_BUFFER_SIZE)
        }
        output.flush()
    }

    private fun writeHeaders(
        output: BufferedOutputStream,
        statusCode: Int,
        statusMessage: String,
        headers: Map<String, String>,
        contentLength: Long?,
    ) {
        val safeMessage = statusMessage.replace(Regex("[^\\x20-\\x7E]"), "")
            .ifBlank { defaultReason(statusCode) }
        val lines = StringBuilder()
            .append("HTTP/1.1 ")
            .append(statusCode)
            .append(' ')
            .append(safeMessage)
            .append("\r\n")
        for ((name, value) in headers) {
            if (
                name.equals("Connection", ignoreCase = true) ||
                name.equals("Transfer-Encoding", ignoreCase = true) ||
                name.equals("Access-Control-Allow-Origin", ignoreCase = true)
            ) {
                continue
            }
            if (value.contains('\r') || value.contains('\n')) continue
            lines.append(name).append(": ").append(value).append("\r\n")
        }
        if (contentLength != null && headers.keys.none {
                it.equals("Content-Length", ignoreCase = true)
            }
        ) {
            lines.append("Content-Length: ").append(contentLength).append("\r\n")
        }
        lines
            .append("Access-Control-Allow-Origin: *\r\n")
            .append("Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n")
            .append("Access-Control-Allow-Headers: Range, Accept, Content-Type\r\n")
            .append("Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\n")
            .append("Connection: close\r\n\r\n")
        output.write(lines.toString().toByteArray(StandardCharsets.ISO_8859_1))
        output.flush()
    }

    private fun writeError(
        output: BufferedOutputStream,
        statusCode: Int,
        reason: String,
    ) {
        val body = reason.toByteArray(StandardCharsets.UTF_8)
        writeHeaders(
            output,
            statusCode,
            reason,
            mapOf(
                "Content-Type" to "text/plain; charset=utf-8",
                "Content-Length" to body.size.toString(),
            ),
            body.size.toLong(),
        )
        output.write(body)
        output.flush()
    }

    private fun readHeaders(input: BufferedInputStream): Map<String, String> {
        val headers = linkedMapOf<String, String>()
        repeat(MAX_HEADER_COUNT) {
            val line = readAsciiLine(input, MAX_HEADER_LINE)
                ?: throw IllegalArgumentException("Incomplete request headers")
            if (line.isEmpty()) return headers
            val separator = line.indexOf(':')
            if (separator <= 0) throw IllegalArgumentException("Malformed request header")
            headers[line.substring(0, separator).trim()] =
                line.substring(separator + 1).trim()
        }
        throw IllegalArgumentException("Too many request headers")
    }

    private fun readAsciiLine(input: InputStream, maxLength: Int): String? {
        val bytes = ByteArrayOutputStream()
        while (bytes.size() <= maxLength) {
            val value = input.read()
            if (value == -1) {
                return if (bytes.size() == 0) null else bytes.toString("ISO-8859-1")
            }
            if (value == '\n'.code) {
                val raw = bytes.toByteArray()
                val length = if (raw.isNotEmpty() && raw.last() == '\r'.code.toByte()) {
                    raw.size - 1
                } else {
                    raw.size
                }
                return String(raw, 0, length, StandardCharsets.ISO_8859_1)
            }
            bytes.write(value)
        }
        throw IllegalArgumentException("HTTP line too long")
    }

    private fun readLimited(input: InputStream, limit: Int): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        var total = 0
        while (true) {
            val count = input.read(buffer)
            if (count == -1) break
            total += count
            require(total <= limit) { "Playlist exceeds size limit" }
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }

    private fun isPlaylist(response: MediaProxyUpstreamResponse): Boolean {
        val contentType = getHeader(response.headers, "Content-Type")
            ?.lowercase(Locale.US)
            .orEmpty()
        val path = runCatching { URI(response.finalUrl).path.lowercase(Locale.US) }
            .getOrDefault("")
        return contentType.contains("mpegurl") || path.endsWith(".m3u8")
    }

    private fun filteredResponseHeaders(input: Map<String, String>): Map<String, String> {
        val allowed = setOf(
            "accept-ranges",
            "cache-control",
            "content-length",
            "content-range",
            "content-type",
            "etag",
            "expires",
            "last-modified",
        )
        return input.filterKeys { it.lowercase(Locale.US) in allowed }
    }

    private fun getHeader(headers: Map<String, String>, name: String): String? {
        return headers.entries.firstOrNull {
            it.key.equals(name, ignoreCase = true)
        }?.value
    }

    private fun defaultReason(statusCode: Int): String = when (statusCode) {
        200 -> "OK"
        204 -> "No Content"
        206 -> "Partial Content"
        400 -> "Bad Request"
        404 -> "Not Found"
        405 -> "Method Not Allowed"
        416 -> "Range Not Satisfiable"
        502 -> "Bad Gateway"
        else -> "Response"
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        running.set(false)
        runCatching { serverSocket?.close() }
        workers.shutdownNow()
    }

    companion object {
        private const val LOOPBACK_HOST = "127.0.0.1"
        private const val MAX_REQUEST_LINE = 8_192
        private const val MAX_HEADER_LINE = 8_192
        private const val MAX_HEADER_COUNT = 64
        private const val MAX_PLAYLIST_BYTES = 5 * 1024 * 1024
    }
}
