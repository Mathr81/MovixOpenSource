package com.movix.app.cast

import java.net.InetAddress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CastNetworkSelectorTest {
    @Test
    fun selectsTheWifiRouteAndMatchingIpv4Address() {
        val result = CastNetworkSelector.select(
            receiverAddress = InetAddress.getByName("192.168.20.44"),
            candidates = listOf(
                candidate(
                    "cell",
                    false,
                    "192.168.20.0",
                    24,
                    "192.168.20.3",
                ),
                candidate(
                    "wifi",
                    true,
                    "192.168.20.0",
                    24,
                    "192.168.20.2",
                ),
            ),
        )

        assertEquals("wifi", result?.networkId)
        assertEquals("192.168.20.2", result?.localAddress?.hostAddress)
        assertEquals("192.168.20.44", result?.receiverAddress?.hostAddress)
    }

    @Test
    fun selectsSameFamilyIpv6AndFormatsItForAnAuthority() {
        val result = CastNetworkSelector.select(
            receiverAddress = InetAddress.getByName("2001:db8:4::44"),
            candidates = listOf(
                CastNetworkCandidate(
                    networkId = "wifi-v6",
                    isWifi = true,
                    routes = listOf(
                        RouteSnapshot(InetAddress.getByName("2001:db8:4::"), 64),
                    ),
                    linkAddresses = listOf(
                        InetAddress.getByName("192.168.4.2"),
                        InetAddress.getByName("2001:db8:4::2"),
                    ),
                ),
            ),
        )

        assertTrue(result?.localAddress?.hostAddress.orEmpty().contains("2001:db8:4"))
        assertEquals(
            "[2001:db8:4:0:0:0:0:2]",
            CastNetworkSelector.formatLanHost(requireNotNull(result?.localAddress)),
        )
    }

    @Test
    fun failsClosedForMissingOrMismatchedRoutesAndUnsafeLocalAddresses() {
        assertNull(CastNetworkSelector.select(null, emptyList()))
        assertNull(
            CastNetworkSelector.select(
                InetAddress.getByName("192.168.30.8"),
                listOf(candidate("cell", false, "192.168.30.0", 24, "192.168.30.2")),
            ),
        )
        assertNull(
            CastNetworkSelector.select(
                InetAddress.getByName("192.168.30.8"),
                listOf(candidate("wifi", true, "192.168.40.0", 24, "192.168.40.2")),
            ),
        )
        for (unsafe in listOf("0.0.0.0", "127.0.0.1", "169.254.4.2")) {
            assertNull(
                CastNetworkSelector.select(
                    InetAddress.getByName("192.168.30.8"),
                    listOf(candidate("wifi", true, "192.168.30.0", 24, unsafe)),
                ),
            )
        }
    }

    @Test
    fun choosesDeterministicallyAcrossMultipleWifiNetworks() {
        val receiver = InetAddress.getByName("10.0.0.8")
        val result = CastNetworkSelector.select(
            receiver,
            listOf(
                candidate("wifi-z", true, "10.0.0.0", 24, "10.0.0.3"),
                candidate("wifi-a", true, "10.0.0.0", 24, "10.0.0.2"),
            ),
        )

        assertEquals("wifi-a", result?.networkId)
    }

    @Test
    fun ignoresSameFamilyAddressesOutsideTheReceiverRoute() {
        val result = CastNetworkSelector.select(
            InetAddress.getByName("192.168.60.8"),
            listOf(
                CastNetworkCandidate(
                    networkId = "wifi",
                    isWifi = true,
                    routes = listOf(
                        RouteSnapshot(InetAddress.getByName("192.168.60.0"), 24),
                    ),
                    linkAddresses = listOf(
                        InetAddress.getByName("10.0.0.1"),
                        InetAddress.getByName("192.168.60.2"),
                    ),
                ),
            ),
        )

        assertEquals("192.168.60.2", result?.localAddress?.hostAddress)
    }

    @Test
    fun invalidatesSelectionWhenReceiverRouteOrBoundAddressDisappears() {
        val selection = CastNetworkSelection(
            "wifi",
            InetAddress.getByName("192.168.60.8"),
            InetAddress.getByName("192.168.60.2"),
        )
        assertTrue(
            CastNetworkSelector.selectionStillValid(
                selection,
                listOf(RouteSnapshot(InetAddress.getByName("192.168.60.0"), 24)),
                listOf(InetAddress.getByName("192.168.60.2")),
            ),
        )
        assertTrue(
            !CastNetworkSelector.selectionStillValid(
                selection,
                listOf(RouteSnapshot(InetAddress.getByName("10.0.0.0"), 24)),
                listOf(InetAddress.getByName("192.168.60.2")),
            ),
        )
        assertTrue(
            !CastNetworkSelector.selectionStillValid(
                selection,
                listOf(RouteSnapshot(InetAddress.getByName("192.168.60.0"), 24)),
                listOf(InetAddress.getByName("192.168.60.3")),
            ),
        )
    }

    private fun candidate(
        id: String,
        wifi: Boolean,
        routeAddress: String,
        prefixLength: Int,
        localAddress: String,
    ) = CastNetworkCandidate(
        networkId = id,
        isWifi = wifi,
        routes = listOf(
            RouteSnapshot(InetAddress.getByName(routeAddress), prefixLength),
        ),
        linkAddresses = listOf(InetAddress.getByName(localAddress)),
    )
}
