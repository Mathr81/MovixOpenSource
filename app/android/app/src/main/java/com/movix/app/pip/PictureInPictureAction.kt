package com.movix.app.pip

enum class PictureInPictureAction(val wireValue: String) {
    SEEK_BACKWARD("seek-backward"),
    TOGGLE_PLAYBACK("toggle-playback"),
    SEEK_FORWARD("seek-forward");

    companion object {
        fun fromWireValue(value: String?) = entries.firstOrNull { it.wireValue == value }
    }
}

object PictureInPictureActionDispatcher {
    @Volatile
    private var enabled = false

    fun setEnabled(value: Boolean) {
        enabled = value
    }

    fun dispatch(value: String?) {
        if (!enabled) return
        val action = PictureInPictureAction.fromWireValue(value) ?: return
        PictureInPictureEvents.emit(
            PictureInPictureEvent(
                kind = PictureInPictureEvent.Kind.ACTION,
                action = action.wireValue,
            ),
        )
    }
}
