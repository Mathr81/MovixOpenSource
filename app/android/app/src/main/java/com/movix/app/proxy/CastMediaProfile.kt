package com.movix.app.proxy

import java.nio.charset.StandardCharsets
import java.util.Locale

internal data class CastMediaProfile(
    val contentType: String,
    val hlsSegmentFormat: String?,
    val hlsVideoSegmentFormat: String?,
    val requiresPngTsUnwrap: Boolean = false,
) {
    companion object {
        const val CANONICAL_HLS_MIME = "application/x-mpegurl"
        private const val MAX_PROFILE_SAMPLE_BYTES = 256 * 1024
        private val supportedProgressiveTypes = setOf(
            "video/mp4",
            "audio/mp4",
            "audio/mpeg",
            "video/webm",
            "audio/webm",
        )

        fun hlsTs(requiresPngTsUnwrap: Boolean = false): CastMediaProfile = CastMediaProfile(
            contentType = CANONICAL_HLS_MIME,
            hlsSegmentFormat = "ts",
            hlsVideoSegmentFormat = "mpeg2_ts",
            requiresPngTsUnwrap = requiresPngTsUnwrap,
        )

        fun hlsFmp4(): CastMediaProfile = CastMediaProfile(
            contentType = CANONICAL_HLS_MIME,
            hlsSegmentFormat = "fmp4",
            hlsVideoSegmentFormat = "fmp4",
        )

        fun progressive(rawContentType: String?): CastMediaProfile? {
            val mime = rawContentType
                ?.substringBefore(';')
                ?.trim()
                ?.lowercase(Locale.US)
                .orEmpty()
            if (mime !in supportedProgressiveTypes) return null
            return CastMediaProfile(mime, null, null)
        }

        fun detect(
            rawContentType: String?,
            playlistSample: ByteArray,
        ): CastMediaProfile? {
            if (playlistSample.size > MAX_PROFILE_SAMPLE_BYTES) return null
            val text = playlistSample.toString(StandardCharsets.UTF_8)
                .removePrefix("\uFEFF")
                .trimStart()
            val mime = rawContentType
                ?.substringBefore(';')
                ?.trim()
                ?.lowercase(Locale.US)
                .orEmpty()
            val looksLikeHls =
                text.startsWith("#EXTM3U") ||
                    mime.contains("mpegurl")
            if (!looksLikeHls) return progressive(mime)

            val normalized = text.lowercase(Locale.US)
            val hasFmp4 =
                normalized.contains("#ext-x-map:") ||
                    normalized.lineSequence().any {
                        val path = it.trim().substringBefore('?').substringBefore('#')
                        !path.startsWith("#") && path.endsWith(".m4s")
                    }
            if (hasFmp4) return hlsFmp4()

            val hasTs = normalized.lineSequence().any {
                val path = it.trim().substringBefore('?').substringBefore('#')
                !path.startsWith("#") && path.endsWith(".ts")
            }
            return if (hasTs) hlsTs() else null
        }
    }
}
