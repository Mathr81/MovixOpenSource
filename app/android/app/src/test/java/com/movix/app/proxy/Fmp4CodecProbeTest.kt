package com.movix.app.proxy

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class Fmp4CodecProbeTest {
    @Test
    fun readsAvcProfileAfterConfigurationVersionAndDetectsAac() {
        val init =
            box("avc1", ByteArray(0)) +
                box(
                    "avcC",
                    byteArrayOf(1, 0x64, 0x00, 0x28),
                ) +
                box("mp4a", ByteArray(0))

        assertEquals("avc1.640028,mp4a.40.2", Fmp4CodecProbe.detect(init))
    }

    @Test
    fun ignoresTextThatIsNotAnMp4Box() {
        assertNull(Fmp4CodecProbe.detect("avcCmp4a".toByteArray()))
    }

    private fun box(type: String, payload: ByteArray): ByteArray {
        val output = ByteArrayOutputStream()
        DataOutputStream(output).use {
            it.writeInt(payload.size + 8)
            it.write(type.toByteArray(Charsets.US_ASCII))
            it.write(payload)
        }
        return output.toByteArray()
    }
}
