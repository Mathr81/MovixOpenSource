package com.movix.app.cast

import com.movix.app.proxy.CastPreparedSource
import java.net.InetAddress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CastRelayRequestRegistryTest {
    @Test
    fun storesSensitiveRequestsBehindOneShotOpaqueIds() {
        var now = 1_000L
        val registry = CastRelayRequestRegistry(
            now = { now },
            tokenFactory = { "opaque_request_0001" },
            ttlMs = 500L,
        )
        val request = request()
        val id = registry.put(request)

        assertEquals("opaque_request_0001", id)
        assertFalse(id.contains("cdn.example"))
        assertFalse(registry.toString().contains("secret"))
        assertFalse(request.toString().contains("secret"))
        assertEquals(request.source.url, registry.take(id)?.source?.url)
        assertNull(registry.take(id))

        val expiring = registry.put(request)
        now += 501L
        assertNull(registry.take(expiring))
    }

    @Test
    fun cleanupInvalidatesEveryPendingRequest() {
        var token = 0
        val registry = CastRelayRequestRegistry(
            tokenFactory = { "opaque_request_${++token}_token" },
        )
        val first = registry.put(request())
        val second = registry.put(request())

        registry.clear()

        assertNull(registry.take(first))
        assertNull(registry.take(second))
        assertTrue(registry.isEmpty())
    }

    private fun request() = CastRelayRequest(
        deviceName = "Salon",
        receiverAddress = InetAddress.getByName("192.168.1.8"),
        source = CastPreparedSource(
            url = "https://cdn.example/master.m3u8?token=secret",
            headers = mapOf("Referer" to "https://player.example/secret"),
        ),
    )
}
