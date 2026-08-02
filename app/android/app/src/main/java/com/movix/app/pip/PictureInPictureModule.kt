package com.movix.app.pip

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.movix.app.MainActivity

class PictureInPictureModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context), LifecycleEventListener {
    private var playbackActive = false
    private var unsubscribe: (() -> Unit)? = null

    override fun getName() = "PictureInPicture"

    override fun initialize() {
        super.initialize()
        context.addLifecycleEventListener(this)
        unsubscribe = PictureInPictureEvents.subscribe(::emit)
    }

    override fun invalidate() {
        val activity = currentActivity as? MainActivity
        activity?.runOnUiThread {
            activity.pictureInPictureController.setPlaybackActive(false)
            finishInvalidation()
        } ?: finishInvalidation()
    }

    private fun finishInvalidation() {
        unsubscribe?.invoke()
        context.removeLifecycleEventListener(this)
        super.invalidate()
    }

    @ReactMethod fun isSupported(promise: Promise) = promise.resolve(controller()?.supported == true)

    @ReactMethod fun setPlaybackActive(active: Boolean) {
        playbackActive = active
        currentActivity?.runOnUiThread { controller()?.setPlaybackActive(active) }
    }

    @ReactMethod fun enter(promise: Promise) = request(promise) { it.requestEnter() }

    @ReactMethod fun exit(promise: Promise) = request(promise) { it.requestExit() }

    @ReactMethod fun addListener(eventName: String) = Unit

    @ReactMethod fun removeListeners(count: Int) = Unit

    override fun onHostResume() { controller()?.setPlaybackActive(playbackActive) }

    override fun onHostPause() = Unit

    override fun onHostDestroy() = Unit

    private fun controller() = (currentActivity as? MainActivity)?.pictureInPictureController

    private fun request(
        promise: Promise,
        operation: (PictureInPictureController) -> PictureInPictureRequestError?,
    ) {
        val activity = currentActivity
        if (activity == null) {
            promise.reject("PIP_NO_ACTIVITY", "PIP_NO_ACTIVITY")
            return
        }
        activity.runOnUiThread {
            val target = controller()
            if (target == null) promise.reject("PIP_UNSUPPORTED", "PIP_UNSUPPORTED")
            else operation(target)?.let { promise.reject(it.code, it.code) } ?: promise.resolve(null)
        }
    }

    private fun emit(event: PictureInPictureEvent) {
        val params = Arguments.createMap().apply {
            putString("kind", event.kind.name.lowercase())
            event.active?.let { putBoolean("active", it) }
            event.code?.take(64)?.let { putString("code", it) }
            event.action?.let { putString("action", it) }
        }
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(EVENT_NAME, params)
    }

    companion object {
        const val EVENT_NAME = "MOVIX_PICTURE_IN_PICTURE"
    }
}
