package com.movix.app.proxy

import java.util.Locale

internal object Fmp4CodecProbe {
    private const val MAX_SAMPLE_BYTES = 256 * 1024

    fun detect(initSample: ByteArray): String? {
        if (initSample.isEmpty() || initSample.size > MAX_SAMPLE_BYTES) return null
        val codecs = linkedSetOf<String>()

        findBoxType(initSample, "avcC")?.let { typeIndex ->
            val payloadIndex = typeIndex + 4
            if (payloadIndex + 4 <= initSample.size) {
                val sampleEntry = findNearestBoxType(
                    initSample,
                    typeIndex,
                    listOf("avc1", "avc3"),
                ) ?: "avc1"
                codecs += String.format(
                    Locale.US,
                    "%s.%02x%02x%02x",
                    sampleEntry,
                    initSample[payloadIndex + 1].toInt() and 0xff,
                    initSample[payloadIndex + 2].toInt() and 0xff,
                    initSample[payloadIndex + 3].toInt() and 0xff,
                )
            }
        }

        if (findBoxType(initSample, "mp4a") != null) {
            codecs += "mp4a.40.2"
        }
        return codecs.takeIf { it.isNotEmpty() }?.joinToString(",")
    }

    private fun findNearestBoxType(
        bytes: ByteArray,
        before: Int,
        candidates: List<String>,
    ): String? {
        val lowerBound = maxOf(4, before - 1_024)
        for (index in before - 1 downTo lowerBound) {
            val candidate = candidates.firstOrNull {
                matchesAscii(bytes, index, it) && isPlausibleBox(bytes, index)
            }
            if (candidate != null) return candidate
        }
        return null
    }

    private fun findBoxType(bytes: ByteArray, type: String): Int? {
        for (index in 4..bytes.size - type.length) {
            if (matchesAscii(bytes, index, type) && isPlausibleBox(bytes, index)) {
                return index
            }
        }
        return null
    }

    private fun matchesAscii(bytes: ByteArray, index: Int, value: String): Boolean {
        if (index < 0 || index + value.length > bytes.size) return false
        return value.indices.all { offset ->
            bytes[index + offset] == value[offset].code.toByte()
        }
    }

    private fun isPlausibleBox(bytes: ByteArray, typeIndex: Int): Boolean {
        if (typeIndex < 4) return false
        val start = typeIndex - 4
        val declaredSize = (0 until 4).fold(0L) { size, offset ->
            (size shl 8) or (bytes[start + offset].toLong() and 0xffL)
        }
        return declaredSize >= 8L && declaredSize <= bytes.size - start
    }
}
