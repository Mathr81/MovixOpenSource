package com.movix.app.cast

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CastPowerLeaseTest {
    @Test
    fun usesLegacyHighPerformanceWifiLockOnlyThroughApi33() {
        val legacyFactory = FakePowerLeaseFactory()
        val legacy = CastPowerLease(apiLevel = 33, factory = legacyFactory)
        legacy.start()
        assertTrue(legacyFactory.wifi.acquired)

        val modernFactory = FakePowerLeaseFactory()
        CastPowerLease(apiLevel = 34, factory = modernFactory).start()
        assertFalse(modernFactory.wifi.acquired)
    }

    @Test
    fun keepsBoundedCpuLeaseOnlyDuringActiveStatesAndProxyActivity() {
        val factory = FakePowerLeaseFactory()
        val lease = CastPowerLease(apiLevel = 35, factory = factory)

        lease.updatePlaybackState(NativeCastPlaybackState.BUFFERING)
        assertEquals(CastPowerLease.CPU_LEASE_TIMEOUT_MS, factory.cpu.lastTimeoutMs)
        lease.noteProxyActivity()
        assertEquals(2, factory.cpu.acquireCalls)
        lease.updatePlaybackState(NativeCastPlaybackState.PAUSED)
        assertFalse(factory.cpu.acquired)
        lease.release()
        lease.release()
        assertEquals(1, factory.cpu.releaseCalls)
    }
}

private class FakePowerLeaseFactory : PowerLeaseFactory {
    val wifi = FakeLeaseHandle()
    val cpu = FakeLeaseHandle()

    override fun createHighPerformanceWifiLock(): LeaseHandle = wifi
    override fun createPartialWakeLock(): LeaseHandle = cpu
}

private class FakeLeaseHandle : LeaseHandle {
    var acquired = false
    var acquireCalls = 0
    var releaseCalls = 0
    var lastTimeoutMs: Long? = null

    override fun acquire(timeoutMs: Long?) {
        acquired = true
        acquireCalls += 1
        lastTimeoutMs = timeoutMs
    }

    override fun release() {
        if (acquired) {
            acquired = false
            releaseCalls += 1
        }
    }
}
