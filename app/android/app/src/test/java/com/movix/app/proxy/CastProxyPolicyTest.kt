package com.movix.app.proxy

import java.net.InetAddress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class CastProxyPolicyTest {
    @Test
    fun formatsOpaqueIpv4AndBracketedIpv6Urls() {
        assertEquals(
            "http://192.168.1.20:28123/cast/session-token/resource-token",
            MediaProxyPolicy.buildCastUrl(
                InetAddress.getByName("192.168.1.20"),
                28123,
                "session-token",
                "resource-token",
            ),
        )
        assertEquals(
            "http://[2001:db8:0:0:0:0:0:20]:28123/cast/session-token/resource-token",
            MediaProxyPolicy.buildCastUrl(
                InetAddress.getByName("2001:db8::20"),
                28123,
                "session-token",
                "resource-token",
            ),
        )
    }

    @Test
    fun rejectsUnsafeCastBindAddresses() {
        for (address in listOf("0.0.0.0", "127.0.0.1", "169.254.1.2", "224.0.0.1", "::")) {
            assertThrows(IllegalArgumentException::class.java) {
                MediaProxyPolicy.requireUsableCastLanAddress(InetAddress.getByName(address))
            }
        }
    }

    @Test
    fun storesExactReceiverWithoutDiagnosticDisclosure() {
        val bind = InetAddress.getByName("192.168.42.2")
        val receiver = InetAddress.getByName("192.168.42.9")
        val access = MediaProxySessionAccess.castLan(
            bind,
            receiver,
        )

        assertEquals(MediaProxyMode.CAST_LAN, access.mode)
        assertEquals(bind, access.bindAddress)
        assertEquals(receiver, access.allowedClientAddress)
        assertFalse(access.toString().contains("192.168.42.9"))
    }

    @Test
    fun comparesAddressBytesAndIpv6Scope() {
        val left = InetAddress.getByName("192.168.1.8")
        val right = InetAddress.getByAddress(byteArrayOf(192.toByte(), 168.toByte(), 1, 8))
        assertTrue(MediaProxyPolicy.sameSocketPeer(left, right))
        assertFalse(
            MediaProxyPolicy.sameSocketPeer(
                left,
                InetAddress.getByName("192.168.1.9"),
            ),
        )
    }
}
