package com.movix.app.cast

import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import com.movix.app.proxy.MediaProxyPolicy
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress

internal data class RouteSnapshot(
    val networkAddress: InetAddress,
    val prefixLength: Int,
) {
    init {
        val bitCount = networkAddress.address.size * 8
        require(prefixLength in 0..bitCount) { "Invalid route prefix" }
    }

    fun matches(address: InetAddress): Boolean {
        val networkBytes = networkAddress.address
        val addressBytes = address.address
        if (networkBytes.size != addressBytes.size) return false
        val fullBytes = prefixLength / 8
        val remainingBits = prefixLength % 8
        for (index in 0 until fullBytes) {
            if (networkBytes[index] != addressBytes[index]) return false
        }
        if (remainingBits == 0) return true
        val mask = (0xff shl (8 - remainingBits)) and 0xff
        return (networkBytes[fullBytes].toInt() and mask) ==
            (addressBytes[fullBytes].toInt() and mask)
    }
}

internal data class CastNetworkCandidate(
    val networkId: String,
    val isWifi: Boolean,
    val routes: List<RouteSnapshot>,
    val linkAddresses: List<InetAddress>,
)

internal data class CastNetworkSelection(
    val networkId: String,
    val receiverAddress: InetAddress,
    val localAddress: InetAddress,
)

internal data class SelectedCastNetwork(
    val network: Network,
    val receiverAddress: InetAddress,
    val localAddress: InetAddress,
)

internal object CastNetworkSelector {
    fun select(
        receiverAddress: InetAddress?,
        candidates: List<CastNetworkCandidate>,
    ): CastNetworkSelection? {
        val receiver = receiverAddress
            ?.let { runCatching { MediaProxyPolicy.requireUsableCastLanAddress(it) }.getOrNull() }
            ?: return null
        val receiverFamily = receiver.address.size

        data class Match(
            val candidate: CastNetworkCandidate,
            val routePrefix: Int,
            val localAddress: InetAddress,
        )

        return candidates.asSequence()
            .filter(CastNetworkCandidate::isWifi)
            .mapNotNull candidateSearch@ { candidate ->
                val matchingRoutes = candidate.routes
                    .filter { it.matches(receiver) }
                    .sortedByDescending(RouteSnapshot::prefixLength)
                val routeAndLocal = matchingRoutes.asSequence()
                    .mapNotNull routeSearch@ { route ->
                        val local = candidate.linkAddresses.asSequence()
                            .filter { it.address.size == receiverFamily }
                            .filter(route::matches)
                            .filter {
                                runCatching {
                                    MediaProxyPolicy.requireUsableCastLanAddress(it)
                                }.isSuccess
                            }
                            .sortedWith(Comparator(::compareAddresses))
                            .firstOrNull()
                            ?: return@routeSearch null
                        route to local
                    }
                    .firstOrNull()
                    ?: return@candidateSearch null
                Match(
                    candidate,
                    routeAndLocal.first.prefixLength,
                    routeAndLocal.second,
                )
            }
            .sortedWith(Comparator { left, right ->
                val routeComparison = right.routePrefix.compareTo(left.routePrefix)
                if (routeComparison != 0) {
                    routeComparison
                } else {
                    val idComparison =
                        left.candidate.networkId.compareTo(right.candidate.networkId)
                    if (idComparison != 0) {
                        idComparison
                    } else {
                        compareAddresses(left.localAddress, right.localAddress)
                    }
                }
            })
            .map {
                CastNetworkSelection(
                    it.candidate.networkId,
                    receiver,
                    it.localAddress,
                )
            }
            .firstOrNull()
    }

    fun selectAndroid(
        connectivityManager: ConnectivityManager,
        receiverAddress: InetAddress?,
    ): SelectedCastNetwork? {
        val networksById = linkedMapOf<String, Network>()
        val candidates = connectivityManager.allNetworks.mapNotNull { network ->
            val capabilities = connectivityManager.getNetworkCapabilities(network)
                ?: return@mapNotNull null
            val properties = connectivityManager.getLinkProperties(network)
                ?: return@mapNotNull null
            val id = network.toString()
            networksById[id] = network
            CastNetworkCandidate(
                networkId = id,
                isWifi = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
                routes = properties.routes.map {
                    RouteSnapshot(
                        it.destination.address,
                        it.destination.prefixLength,
                    )
                },
                linkAddresses = properties.linkAddresses.map { it.address },
            )
        }
        val selected = select(receiverAddress, candidates) ?: return null
        return SelectedCastNetwork(
            network = networksById[selected.networkId] ?: return null,
            receiverAddress = selected.receiverAddress,
            localAddress = selected.localAddress,
        )
    }

    fun selectionStillValid(
        selection: CastNetworkSelection,
        routes: List<RouteSnapshot>,
        linkAddresses: List<InetAddress>,
    ): Boolean {
        val selectedAgain = select(
            selection.receiverAddress,
            listOf(
                CastNetworkCandidate(
                    networkId = selection.networkId,
                    isWifi = true,
                    routes = routes,
                    linkAddresses = linkAddresses,
                ),
            ),
        ) ?: return false
        return MediaProxyPolicy.sameSocketPeer(
            selectedAgain.localAddress,
            selection.localAddress,
        )
    }

    fun formatLanHost(address: InetAddress): String {
        MediaProxyPolicy.requireUsableCastLanAddress(address)
        val literal = address.hostAddress
            ?.substringBefore('%')
            ?: throw IllegalArgumentException("Invalid LAN address")
        return when (address) {
            is Inet6Address -> "[$literal]"
            is Inet4Address -> literal
            else -> throw IllegalArgumentException("Unsupported LAN address family")
        }
    }

    private fun compareAddresses(left: InetAddress, right: InetAddress): Int {
        val leftBytes = left.address
        val rightBytes = right.address
        if (leftBytes.size != rightBytes.size) {
            return leftBytes.size.compareTo(rightBytes.size)
        }
        for (index in leftBytes.indices) {
            val comparison =
                (leftBytes[index].toInt() and 0xff).compareTo(
                    rightBytes[index].toInt() and 0xff,
                )
            if (comparison != 0) return comparison
        }
        return 0
    }
}
