package com.movix.app.proxy

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.PushbackInputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PngWrappedMpegTsTest {
    @Test
    fun detectsEnvelopeAndPositionsStreamAtFirstTsPacket() {
        val png = pngEnvelope()
        val ts = tsPayload()
        val wrapped = png + ts
        val body = PushbackInputStream(ByteArrayInputStream(wrapped), wrapped.size)

        assertEquals(png.size, PngWrappedMpegTs.payloadOffset(wrapped))
        val payload = PngWrappedMpegTs.probeAndPosition(body, wrapped.size.toLong())

        assertEquals(png.size, payload?.envelopeLength)
        assertEquals(ts.size.toLong(), payload?.payloadLength)
        assertArrayEquals(ts, body.readBytes())
    }

    @Test
    fun rejectsPlainPngTruncationAndFalseTsRhythm() {
        val png = pngEnvelope()
        val fakeTs = tsPayload().also { it[188] = 0x00 }
        val truncatedChunk = png.copyOf(png.size - 2)

        assertNull(PngWrappedMpegTs.payloadOffset(png))
        assertNull(PngWrappedMpegTs.payloadOffset(truncatedChunk + tsPayload()))
        assertNull(PngWrappedMpegTs.payloadOffset(png + fakeTs))
    }

    @Test
    fun rejectsEnvelopePastBoundAndRestoresUnrecognizedInput() {
        val oversizedData = ByteArray(PngWrappedMpegTs.MAX_ENVELOPE_BYTES)
        val oversized = pngChunk("IHDR", ByteArray(13)) +
            pngChunk("IDAT", oversizedData) + pngChunk("IEND", ByteArray(0)) + tsPayload()
        assertNull(PngWrappedMpegTs.payloadOffset(PNG_SIGNATURE + oversized))

        val original = "ordinary binary response".toByteArray()
        val body = PushbackInputStream(
            FragmentedInputStream(original, 2),
            PngWrappedMpegTs.MAX_PROBE_BYTES,
        )
        assertNull(PngWrappedMpegTs.probeAndPosition(body, original.size.toLong()))
        assertArrayEquals(original, body.readBytes())
    }

    private fun pngEnvelope(): ByteArray = PNG_SIGNATURE +
        pngChunk("IHDR", ByteArray(13)) +
        pngChunk("IDAT", byteArrayOf(1, 2, 3)) +
        pngChunk("IEND", ByteArray(0))

    private fun pngChunk(type: String, data: ByteArray): ByteArray {
        val output = ByteArrayOutputStream()
        DataOutputStream(output).use {
            it.writeInt(data.size)
            it.write(type.toByteArray(Charsets.US_ASCII))
            it.write(data)
            it.writeInt(0)
        }
        return output.toByteArray()
    }

    private fun tsPayload(): ByteArray = ByteArray(3 * 188).also { bytes ->
        repeat(3) { packet -> bytes[packet * 188] = 0x47 }
    }

    private class FragmentedInputStream(
        bytes: ByteArray,
        private val chunkSize: Int,
    ) : ByteArrayInputStream(bytes) {
        override fun read(buffer: ByteArray, offset: Int, length: Int): Int =
            super.read(buffer, offset, minOf(length, chunkSize))
    }

    companion object {
        private val PNG_SIGNATURE = byteArrayOf(
            0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        )
    }
}
