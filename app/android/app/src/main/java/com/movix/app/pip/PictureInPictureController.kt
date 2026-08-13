package com.movix.app.pip

data class PictureInPictureEvent(
    val kind: Kind,
    val active: Boolean? = null,
    val code: String? = null,
    val action: String? = null,
) {
    enum class Kind { PREPARE, STATE, ERROR, ACTION }
}

enum class PictureInPictureRequestError(val code: String) {
    UNSUPPORTED("PIP_UNSUPPORTED"),
    ENTER_REJECTED("PIP_ENTER_REJECTED"),
    RESTORE_REJECTED("PIP_RESTORE_REJECTED"),
}

interface PictureInPictureHost {
    val sdkInt: Int
    fun hasSystemFeature(): Boolean
    fun updateParams(autoEnter: Boolean, playbackPlaying: Boolean)
    fun setActionsEnabled(enabled: Boolean)
    fun enter(): Boolean
    fun restore(): Boolean
    fun emit(event: PictureInPictureEvent)
}

class PictureInPictureController(private val host: PictureInPictureHost) {
    private var playbackActive = false
    private var prepared = false
    private var inPictureInPicture = false

    val supported get() = host.sdkInt >= 26 && host.hasSystemFeature()

    fun setPlaybackActive(active: Boolean) {
        if (playbackActive == active) return
        playbackActive = active
        if (!supported) return
        host.updateParams(host.sdkInt >= 35 && active, active)
        if (!active && prepared && !inPictureInPicture) clearPresentation()
    }

    fun requestEnter(): PictureInPictureRequestError? {
        if (!supported) return PictureInPictureRequestError.UNSUPPORTED
        prepare()
        host.updateParams(host.sdkInt >= 35 && playbackActive, playbackActive)
        return if (runCatching { host.enter() }.getOrDefault(false)) null
        else fail(PictureInPictureRequestError.ENTER_REJECTED)
    }

    fun requestExit(): PictureInPictureRequestError? {
        if (!supported) return PictureInPictureRequestError.UNSUPPORTED
        return if (runCatching { host.restore() }.getOrDefault(false)) null
        else PictureInPictureRequestError.RESTORE_REJECTED
    }

    fun onUserLeaveHint() {
        if (host.sdkInt in 26..29) enterLegacyAutomaticPictureInPicture()
    }

    /**
     * API 30+ invokes this synchronously while backgrounding an activity. Returning true
     * suppresses the legacy leave-hint fallback, so the video-only PREPARE event is emitted
     * before the immediate native entry request.
     */
    fun onPictureInPictureRequested(): Boolean {
        if (host.sdkInt < 30) return false
        if (host.sdkInt >= 35) return true
        if (!supported || !playbackActive) return true
        enterLegacyAutomaticPictureInPicture()
        return true
    }

    private fun enterLegacyAutomaticPictureInPicture() {
        if (!supported || !playbackActive) return
        prepare()
        if (!runCatching { host.enter() }.getOrDefault(false)) {
            fail(PictureInPictureRequestError.ENTER_REJECTED)
        }
    }

    /** API 35 supplies the only automatic-entry transition-start signal. */
    fun onPictureInPictureUiStateChanged(isTransitioningToPip: Boolean) {
        if (supported && host.sdkInt >= 35 && playbackActive && isTransitioningToPip) prepare()
    }

    fun onPictureInPictureModeChanged(active: Boolean) {
        if (active) {
            prepare()
            if (inPictureInPicture) return
            inPictureInPicture = true
            host.setActionsEnabled(true)
            host.emit(PictureInPictureEvent(PictureInPictureEvent.Kind.STATE, true))
        } else if (prepared || inPictureInPicture) clearPresentation()
    }

    fun onResume(isInPictureInPictureMode: Boolean) {
        if (!isInPictureInPictureMode && prepared && !inPictureInPicture) clearPresentation()
    }

    fun destroy() {
        playbackActive = false
        if (supported) host.updateParams(false, false)
        if (prepared || inPictureInPicture) clearPresentation()
        else if (supported) host.setActionsEnabled(false)
    }

    private fun prepare() {
        if (prepared) return
        prepared = true
        host.emit(PictureInPictureEvent(PictureInPictureEvent.Kind.PREPARE))
    }

    private fun fail(error: PictureInPictureRequestError): PictureInPictureRequestError {
        host.emit(PictureInPictureEvent(PictureInPictureEvent.Kind.ERROR, code = error.code))
        clearPresentation()
        return error
    }

    private fun clearPresentation() {
        host.setActionsEnabled(false)
        prepared = false
        inPictureInPicture = false
        host.emit(PictureInPictureEvent(PictureInPictureEvent.Kind.STATE, false))
    }

}
