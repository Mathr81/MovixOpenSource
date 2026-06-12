package com.movix.app.pip

import android.os.Build
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.movix.app.MainActivity

/**
 * Pont JS -> natif pour l'état de lecture vidéo.
 *
 * Le script Media Session injecté dans le WebView publie play/pause ; le bridge
 * RN relaie cet état ici afin que [MainActivity.onUserLeaveHint] sache s'il faut
 * basculer en Picture-in-Picture quand l'utilisateur quitte l'app.
 */
class PipModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "PipModule"

    @ReactMethod
    fun setVideoPlaying(playing: Boolean) {
        MainActivity.isVideoPlaying = playing
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            currentActivity?.runOnUiThread {
                (currentActivity as? MainActivity)?.updatePipParams(playing)
            }
        }
    }

    // Requis par l'interface NativeModule côté event-emitter ; no-op ici.
    @ReactMethod
    fun addListener(eventName: String) {
    }

    @ReactMethod
    fun removeListeners(count: Int) {
    }
}
