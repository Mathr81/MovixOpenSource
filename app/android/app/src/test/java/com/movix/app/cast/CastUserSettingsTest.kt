package com.movix.app.cast

import android.content.Context
import android.provider.Settings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class CastUserSettingsTest {
    @Test
    fun persistsOnlyTheDisclosureSuppressionBoolean() {
        val context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences(CastUserSettings.PREFERENCES_NAME, Context.MODE_PRIVATE)
            .edit()
            .clear()
            .commit()
        val settings = CastUserSettings(context)

        assertFalse(settings.isRelayDisclosureSuppressed())
        settings.setRelayDisclosureSuppressed(true)
        assertTrue(CastUserSettings(context).isRelayDisclosureSuppressed())
        assertEquals(
            setOf(CastUserSettings.KEY_RELAY_DISCLOSURE_SUPPRESSED),
            context.getSharedPreferences(
                CastUserSettings.PREFERENCES_NAME,
                Context.MODE_PRIVATE,
            ).all.keys,
        )
    }

    @Test
    fun batterySettingsAreOptionalAndFallBackToAppDetails() {
        val context = RuntimeEnvironment.getApplication()
        val settings = CastUserSettings(context)

        val primary = settings.batterySettingsIntent { true }
        assertEquals(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS, primary.action)

        val fallback = settings.batterySettingsIntent { false }
        assertEquals(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, fallback.action)
        assertEquals("package", fallback.data?.scheme)
        assertEquals(context.packageName, fallback.data?.schemeSpecificPart)
    }
}
