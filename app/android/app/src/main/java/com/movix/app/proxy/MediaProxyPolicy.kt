package com.movix.app.proxy

import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.URI
import java.util.Locale

object MediaProxyPolicy {
    private const val MAX_URL_LENGTH = 16_384
    private const val MAX_HEADER_VALUE_LENGTH = 8_192
    private val tokenPattern = Regex("^[A-Za-z0-9_-]{8,128}$")
    private val numericIpv4Pattern = Regex("^\\d{1,3}(?:\\.\\d{1,3}){3}$")
    private val uriAttributePattern = Regex("""URI=(["'])(.*?)\1""", RegexOption.IGNORE_CASE)
    private val allowedRequestHeaders = mapOf(
        "accept" to "Accept",
        "accept-language" to "Accept-Language",
        "content-type" to "Content-Type",
        "if-modified-since" to "If-Modified-Since",
        "if-none-match" to "If-None-Match",
        "origin" to "Origin",
        "range" to "Range",
        "referer" to "Referer",
        "user-agent" to "User-Agent",
    )
    private val allowedLocalOverrideHeaders = setOf(
        "accept",
        "accept-language",
        "if-modified-since",
        "if-none-match",
        "range",
    )

    fun validatePublicHttpsUrl(
        rawUrl: String,
        resolver: (String) -> List<InetAddress> = {
            InetAddress.getAllByName(it).toList()
        },
    ): URI {
        val uri = validateHttpsUrlSyntax(rawUrl)
        val host = requireNotNull(uri.host).lowercase(Locale.US)
        val addresses = runCatching { resolver(host) }
            .getOrElse { throw IllegalArgumentException("Upstream DNS failed") }
        require(addresses.isNotEmpty()) { "Upstream DNS returned no address" }
        require(addresses.none(::isForbiddenAddress)) {
            "Private upstream is forbidden"
        }
        return uri
    }

    fun validateHttpsUrlSyntax(rawUrl: String): URI {
        require(rawUrl.length in 1..MAX_URL_LENGTH) { "Invalid upstream URL" }
        val uri = runCatching { URI(rawUrl) }
            .getOrElse { throw IllegalArgumentException("Invalid upstream URL") }
        require(uri.scheme?.lowercase(Locale.US) == "https") {
            "HTTPS upstream required"
        }
        require(uri.userInfo == null) { "Upstream credentials are forbidden" }
        require(uri.port == -1 || uri.port == 443) { "Unsupported upstream port" }

        val host = uri.host?.trim()?.lowercase(Locale.US)
        require(!host.isNullOrEmpty()) { "Missing upstream host" }
        require(host != "localhost" && !host.endsWith(".localhost")) {
            "Loopback upstream is forbidden"
        }

        if (numericIpv4Pattern.matches(host) || host.contains(':')) {
            val literal = runCatching { InetAddress.getByName(host) }
                .getOrElse { throw IllegalArgumentException("Invalid upstream address") }
            require(!isForbiddenAddress(literal)) { "Private upstream is forbidden" }
        }
        return uri
    }

    fun isForbiddenAddress(address: InetAddress): Boolean {
        if (
            address.isAnyLocalAddress ||
            address.isLoopbackAddress ||
            address.isLinkLocalAddress ||
            address.isSiteLocalAddress ||
            address.isMulticastAddress
        ) {
            return true
        }

        val bytes = address.address
        if (address is Inet4Address && bytes.size == 4) {
            val first = bytes[0].toInt() and 0xff
            val second = bytes[1].toInt() and 0xff
            if (first == 0 || first >= 224) return true
            if (first == 100 && second in 64..127) return true
            if (first == 198 && second in 18..19) return true
        }
        if (address is Inet6Address && bytes.isNotEmpty()) {
            val first = bytes[0].toInt() and 0xff
            if (first and 0xfe == 0xfc) return true
        }
        return false
    }

    fun sanitizeRequestHeaders(input: Map<String, String>): Map<String, String> {
        val output = linkedMapOf<String, String>()
        for ((rawName, rawValue) in input) {
            val canonicalName = allowedRequestHeaders[rawName.trim().lowercase(Locale.US)]
                ?: continue
            val value = rawValue.trim()
            if (
                value.isEmpty() ||
                value.length > MAX_HEADER_VALUE_LENGTH ||
                value.contains('\r') ||
                value.contains('\n')
            ) {
                continue
            }
            output[canonicalName] = value
        }
        return output
    }

    fun sanitizeLocalRequestHeaders(input: Map<String, String>): Map<String, String> {
        return sanitizeRequestHeaders(
            input.filterKeys {
                it.trim().lowercase(Locale.US) in allowedLocalOverrideHeaders
            },
        )
    }

    fun rewritePlaylist(
        playlist: String,
        baseUrl: String,
        localize: (String) -> String,
    ): String {
        val baseUri = runCatching { URI(baseUrl) }
            .getOrElse { throw IllegalArgumentException("Invalid playlist base URL") }

        fun rewrite(rawValue: String): String {
            val value = rawValue.trim()
            if (
                value.isEmpty() ||
                value.startsWith("data:", ignoreCase = true) ||
                value.startsWith("blob:", ignoreCase = true)
            ) {
                return rawValue
            }
            val absolute = runCatching { baseUri.resolve(value).toString() }
                .getOrElse { return rawValue }
            return localize(absolute)
        }

        return playlist.lineSequence().joinToString("\n") { line ->
            if (line.isBlank()) {
                line
            } else if (!line.trimStart().startsWith("#")) {
                val leading = line.takeWhile(Char::isWhitespace)
                val trailing = line.takeLastWhile(Char::isWhitespace)
                leading + rewrite(line.trim()) + trailing
            } else {
                uriAttributePattern.replace(line) { match ->
                    val quote = match.groupValues[1]
                    val value = match.groupValues[2]
                    "URI=$quote${rewrite(value)}$quote"
                }
            }
        }
    }

    fun buildLoopbackUrl(
        port: Int,
        processSecret: String,
        sessionId: String,
        resourceId: String,
    ): String {
        require(port in 1..65_535) { "Invalid loopback port" }
        require(tokenPattern.matches(processSecret)) { "Invalid process secret" }
        require(tokenPattern.matches(sessionId)) { "Invalid session id" }
        require(tokenPattern.matches(resourceId)) { "Invalid resource id" }
        return "http://127.0.0.1:$port/p/$processSecret/$sessionId/$resourceId"
    }
}
