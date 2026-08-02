package com.movix.app.cast

import android.app.PendingIntent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class CastProxyForegroundServiceTest {
    @Test
    fun startIntentCarriesOnlyTheOpaqueRequestId() {
        val context = RuntimeEnvironment.getApplication()
        val intent = CastProxyForegroundService.startIntent(context, "opaque_request_0001")

        assertEquals(CastProxyForegroundService.ACTION_START, intent.action)
        assertEquals(
            setOf(CastProxyForegroundService.EXTRA_REQUEST_ID),
            intent.extras?.keySet(),
        )
        assertEquals(
            CastProxyForegroundService::class.java.name,
            intent.component?.className,
        )
    }

    @Test
    fun stopPendingIntentIsExplicitAndImmutable() {
        val context = RuntimeEnvironment.getApplication()
        val pending = CastProxyForegroundService.stopPendingIntent(context)
        val flags = pendingIntentFlags(pending)

        assertTrue(flags and PendingIntent.FLAG_IMMUTABLE != 0)
        assertFalse(flags and PendingIntent.FLAG_MUTABLE != 0)
    }

    private fun pendingIntentFlags(pendingIntent: PendingIntent): Int {
        val shadow = org.robolectric.Shadows.shadowOf(pendingIntent)
        return shadow.flags
    }
}
