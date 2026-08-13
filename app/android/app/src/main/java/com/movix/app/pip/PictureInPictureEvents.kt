package com.movix.app.pip

import java.util.concurrent.CopyOnWriteArraySet

object PictureInPictureEvents {
    private val listeners = CopyOnWriteArraySet<(PictureInPictureEvent) -> Unit>()

    fun subscribe(listener: (PictureInPictureEvent) -> Unit): () -> Unit {
        listeners += listener
        return { listeners -= listener }
    }

    fun emit(event: PictureInPictureEvent) = listeners.forEach { it(event) }
}
