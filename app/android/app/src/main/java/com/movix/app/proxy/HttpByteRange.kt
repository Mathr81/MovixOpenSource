package com.movix.app.proxy

internal sealed interface HttpByteRange {
    data object None : HttpByteRange
    data object Unsatisfiable : HttpByteRange
    data class Valid(
        val start: Long,
        val endInclusive: Long,
        val total: Long,
    ) : HttpByteRange {
        val length: Long get() = endInclusive - start + 1L
    }

    companion object {
        fun parse(header: String?, total: Long): HttpByteRange {
            if (header == null) return None
            if (total <= 0L || !header.startsWith("bytes=", ignoreCase = true) || ',' in header) {
                return Unsatisfiable
            }
            val value = header.substring("bytes=".length).trim()
            val separator = value.indexOf('-')
            if (separator < 0) return Unsatisfiable
            val left = value.substring(0, separator).trim()
            val right = value.substring(separator + 1).trim()
            if (left.isEmpty()) {
                val suffix = right.toLongOrNull() ?: return Unsatisfiable
                if (suffix <= 0L) return Unsatisfiable
                val start = (total - suffix).coerceAtLeast(0L)
                return Valid(start, total - 1L, total)
            }
            val start = left.toLongOrNull() ?: return Unsatisfiable
            if (start < 0L || start >= total) return Unsatisfiable
            val requestedEnd = if (right.isEmpty()) {
                total - 1L
            } else {
                right.toLongOrNull() ?: return Unsatisfiable
            }
            if (requestedEnd < start) return Unsatisfiable
            return Valid(start, minOf(requestedEnd, total - 1L), total)
        }
    }
}
