package com.movix.app.proxy

import java.io.PushbackInputStream
import java.nio.charset.StandardCharsets

internal data class PngTsPayload(
    val envelopeLength: Int,
    val payloadLength: Long?,
)

internal object PngWrappedMpegTs {
    const val MAX_ENVELOPE_BYTES = 4_096
    const val TS_PACKET_BYTES = 188
    const val REQUIRED_TS_PACKETS = 3
    const val MAX_PROBE_BYTES =
        MAX_ENVELOPE_BYTES + TS_PACKET_BYTES * REQUIRED_TS_PACKETS

    private val signature = byteArrayOf(
        0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    )

    fun payloadOffset(bytes: ByteArray, length: Int = bytes.size): Int? {
        val available = minOf(length, bytes.size)
        if (available < signature.size ||
            signature.indices.any { bytes[it] != signature[it] }
        ) return null

        var cursor = signature.size
        var sawIhdr = false
        while (cursor + 12 <= available && cursor + 12 <= MAX_ENVELOPE_BYTES) {
            val dataLength = readUInt32(bytes, cursor) ?: return null
            if (dataLength > MAX_ENVELOPE_BYTES.toLong()) return null
            val chunkEndLong = cursor.toLong() + 12L + dataLength
            if (chunkEndLong > available || chunkEndLong > MAX_ENVELOPE_BYTES) return null
            val chunkEnd = chunkEndLong.toInt()
            val type = String(bytes, cursor + 4, 4, StandardCharsets.US_ASCII)

            if (!sawIhdr) {
                if (type != "IHDR" || dataLength != 13L) return null
                sawIhdr = true
            }
            if (type == "IEND") {
                if (dataLength != 0L) return null
                if (available - chunkEnd < TS_PACKET_BYTES * REQUIRED_TS_PACKETS) return null
                repeat(REQUIRED_TS_PACKETS) { packet ->
                    if ((bytes[chunkEnd + packet * TS_PACKET_BYTES].toInt() and 0xff) != 0x47) {
                        return null
                    }
                }
                return chunkEnd
            }
            cursor = chunkEnd
        }
        return null
    }

    fun probeAndPosition(
        body: PushbackInputStream,
        declaredContentLength: Long?,
    ): PngTsPayload? {
        val prefix = ByteArray(MAX_PROBE_BYTES)
        var count = 0
        while (count < prefix.size) {
            val read = body.read(prefix, count, prefix.size - count)
            if (read == -1) break
            if (read == 0) continue
            count += read
        }
        val offset = payloadOffset(prefix, count)
        if (offset == null) {
            if (count > 0) body.unread(prefix, 0, count)
            return null
        }
        if (count > offset) body.unread(prefix, offset, count - offset)
        val payloadLength = declaredContentLength
            ?.minus(offset.toLong())
            ?.takeIf { it >= 0L }
        return PngTsPayload(offset, payloadLength)
    }

    private fun readUInt32(bytes: ByteArray, offset: Int): Long? {
        if (offset < 0 || offset + 4 > bytes.size) return null
        return (0 until 4).fold(0L) { value, index ->
            (value shl 8) or (bytes[offset + index].toLong() and 0xffL)
        }
    }
}
