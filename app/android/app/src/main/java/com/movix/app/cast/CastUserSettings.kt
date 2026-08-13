package com.movix.app.cast

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings

internal class CastUserSettings(
    context: Context,
) {
    private val appContext = context.applicationContext
    private val preferences = appContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )

    fun isRelayDisclosureSuppressed(): Boolean {
        return preferences.getBoolean(KEY_RELAY_DISCLOSURE_SUPPRESSED, false)
    }

    fun setRelayDisclosureSuppressed(suppressed: Boolean) {
        preferences.edit()
            .putBoolean(KEY_RELAY_DISCLOSURE_SUPPRESSED, suppressed)
            .apply()
    }

    fun batterySettingsIntent(
        canResolve: (Intent) -> Boolean = {
            it.resolveActivity(appContext.packageManager) != null
        },
    ): Intent {
        val optionalSettings = Intent(
            Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS,
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (canResolve(optionalSettings)) return optionalSettings
        return Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", appContext.packageName, null),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    fun openBatterySettings() {
        appContext.startActivity(batterySettingsIntent())
    }

    companion object {
        const val PREFERENCES_NAME = "movix_cast_user_settings"
        const val KEY_RELAY_DISCLOSURE_SUPPRESSED =
            "relay_disclosure_suppressed"
    }
}
