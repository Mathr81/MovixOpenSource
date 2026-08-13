package com.movix.app.playback

import android.app.Activity
import android.view.Window
import android.view.WindowManager
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class PlaybackAwakeModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
    private var active = false
    private var window: Window? = null

    override fun getName() = "PlaybackAwake"

    @ReactMethod
    fun setLocalPlaybackAwake(active: Boolean) {
        val activity = currentActivity
        if (activity == null) {
            this.active = active
            return
        }
        activity.runOnUiThread {
            val currentWindow = activity.window
            if (this.active == active && window === currentWindow) return@runOnUiThread
            this.active = active
            window = currentWindow
            setWindowFlag(currentWindow, active)
        }
    }

    override fun invalidate() {
        active = false
        val activity = currentActivity
        activity?.runOnUiThread { clearWindowFlag(activity.window) }
        window = null
        super.invalidate()
    }

    companion object {
        internal fun setWindowFlag(window: Window, active: Boolean) {
            if (active) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else clearWindowFlag(window)
        }

        internal fun clearWindowFlag(window: Window) {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }

        fun clearActivityFlag(activity: Activity) = clearWindowFlag(activity.window)
    }
}
