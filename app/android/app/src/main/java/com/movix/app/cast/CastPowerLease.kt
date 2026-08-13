package com.movix.app.cast

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Build
import android.os.PowerManager
import java.util.concurrent.atomic.AtomicBoolean

internal interface LeaseHandle {
    fun acquire(timeoutMs: Long? = null)
    fun release()
}

internal interface PowerLeaseFactory {
    fun createHighPerformanceWifiLock(): LeaseHandle
    fun createPartialWakeLock(): LeaseHandle
}

internal class AndroidPowerLeaseFactory(
    context: Context,
) : PowerLeaseFactory {
    private val wifiManager =
        context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    private val powerManager =
        context.getSystemService(Context.POWER_SERVICE) as PowerManager

    override fun createHighPerformanceWifiLock(): LeaseHandle {
        val lock = wifiManager.createWifiLock(
            WifiManager.WIFI_MODE_FULL_HIGH_PERF,
            "Movix:CastRelayWifi",
        ).apply {
            setReferenceCounted(false)
        }
        return object : LeaseHandle {
            override fun acquire(timeoutMs: Long?) {
                if (!lock.isHeld) lock.acquire()
            }

            override fun release() {
                if (lock.isHeld) lock.release()
            }
        }
    }

    override fun createPartialWakeLock(): LeaseHandle {
        val lock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "Movix:CastRelayCpu",
        ).apply {
            setReferenceCounted(false)
        }
        return object : LeaseHandle {
            override fun acquire(timeoutMs: Long?) {
                val bounded = timeoutMs ?: CastPowerLease.CPU_LEASE_TIMEOUT_MS
                lock.acquire(bounded)
            }

            override fun release() {
                if (lock.isHeld) lock.release()
            }
        }
    }
}

internal class CastPowerLease(
    private val apiLevel: Int = Build.VERSION.SDK_INT,
    factory: PowerLeaseFactory,
) {
    private val released = AtomicBoolean(false)
    private val wifiLock = factory.createHighPerformanceWifiLock()
    private val cpuLock = factory.createPartialWakeLock()

    fun start() {
        if (released.get()) return
        if (apiLevel <= 33) wifiLock.acquire()
    }

    fun updatePlaybackState(state: NativeCastPlaybackState) {
        if (released.get()) return
        when (state) {
            NativeCastPlaybackState.LOADING,
            NativeCastPlaybackState.BUFFERING,
            NativeCastPlaybackState.PLAYING,
            -> cpuLock.acquire(CPU_LEASE_TIMEOUT_MS)

            else -> cpuLock.release()
        }
    }

    fun noteProxyActivity() {
        if (!released.get()) cpuLock.acquire(CPU_LEASE_TIMEOUT_MS)
    }

    fun release() {
        if (!released.compareAndSet(false, true)) return
        runCatching(cpuLock::release)
        runCatching(wifiLock::release)
    }

    companion object {
        const val CPU_LEASE_TIMEOUT_MS = 60_000L
    }
}
