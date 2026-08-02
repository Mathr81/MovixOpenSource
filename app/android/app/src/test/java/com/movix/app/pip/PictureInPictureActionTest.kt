package com.movix.app.pip

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test

class PictureInPictureActionTest {
    @After
    fun reset() = PictureInPictureActionDispatcher.setEnabled(false)

    @Test
    fun `known actions dispatch only while PiP actions are enabled`() {
        val events = mutableListOf<PictureInPictureEvent>()
        val unsubscribe = PictureInPictureEvents.subscribe(events::add)
        PictureInPictureActionDispatcher.dispatch("seek-forward")
        PictureInPictureActionDispatcher.setEnabled(true)
        PictureInPictureActionDispatcher.dispatch("unknown")
        PictureInPictureActionDispatcher.dispatch("seek-forward")
        unsubscribe()

        assertEquals(
            listOf(
                PictureInPictureEvent(
                    kind = PictureInPictureEvent.Kind.ACTION,
                    action = "seek-forward",
                ),
            ),
            events,
        )
    }
}
