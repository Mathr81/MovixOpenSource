package com.movix.app.playback

import android.app.Activity
import android.os.Looper
import android.view.WindowManager
import com.facebook.react.bridge.BridgeReactContext
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PlaybackAwakeModuleTest {
    @Test
    fun `module updates are idempotent and invalidate clears the flag`() {
        val activityController = Robolectric.buildActivity(Activity::class.java).setup()
        val activity = activityController.get()
        val window = activity.window
        val reactContext = BridgeReactContext(RuntimeEnvironment.getApplication())
        reactContext.onHostResume(activity)
        val module = PlaybackAwakeModule(reactContext)

        module.setLocalPlaybackAwake(true)
        module.setLocalPlaybackAwake(true)
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)

        module.setLocalPlaybackAwake(false)
        module.setLocalPlaybackAwake(false)
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse(window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)

        module.setLocalPlaybackAwake(true)
        shadowOf(Looper.getMainLooper()).idle()
        module.invalidate()
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse(window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)
    }

    @Test
    fun `activity cleanup clears the flag defensively`() {
        val activityController = Robolectric.buildActivity(Activity::class.java).setup()
        val activity = activityController.get()
        val window = activity.window
        PlaybackAwakeModule.setWindowFlag(window, true)

        PlaybackAwakeModule.clearActivityFlag(activity)
        activityController.destroy()
        shadowOf(Looper.getMainLooper()).idle()

        assertFalse(window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)
    }
}
