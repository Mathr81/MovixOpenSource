package com.movix.app.pip

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PictureInPictureControllerTest {
    private class FakeHost(
        override val sdkInt: Int,
        private val feature: Boolean = true,
    ) : PictureInPictureHost {
        val paramsUpdates = mutableListOf<Pair<Boolean, Boolean>>()
        val actionsEnabledUpdates = mutableListOf<Boolean>()
        val events = mutableListOf<PictureInPictureEvent>()
        val trace = mutableListOf<String>()
        var enterCalls = 0
        var restoreCalls = 0
        var enterResult = true
        var restoreResult = true

        override fun hasSystemFeature() = feature
        override fun updateParams(autoEnter: Boolean, playbackPlaying: Boolean) {
            paramsUpdates += autoEnter to playbackPlaying
        }
        override fun setActionsEnabled(enabled: Boolean) { actionsEnabledUpdates += enabled }
        override fun enter(): Boolean { enterCalls += 1; trace += "enter"; return enterResult }
        override fun restore(): Boolean { restoreCalls += 1; return restoreResult }
        override fun emit(event: PictureInPictureEvent) {
            events += event
            if (event.kind == PictureInPictureEvent.Kind.PREPARE) trace += "prepare"
        }
    }

    @Test fun `unsupported platforms never enter`() {
        val api24 = PictureInPictureController(FakeHost(24))
        val noFeature = PictureInPictureController(FakeHost(35, false))
        assertFalse(api24.supported)
        assertFalse(noFeature.supported)
        assertEquals(PictureInPictureRequestError.UNSUPPORTED, api24.requestEnter())
        assertEquals(PictureInPictureRequestError.UNSUPPORTED, noFeature.requestEnter())
    }

    @Test fun `api 26 through 29 prepare before synchronous legacy leave-hint entry`() {
        listOf(26, 29).forEach { sdkInt ->
            val host = FakeHost(sdkInt)
            val controller = PictureInPictureController(host)
            controller.setPlaybackActive(true)
            controller.onUserLeaveHint()

            assertEquals(listOf(false), host.paramsUpdates.map { it.first })
            assertEquals(1, host.enterCalls)
            assertEquals(listOf("prepare", "enter"), host.trace)
        }
    }

    @Test fun `api 31 and 34 keep auto enter disabled and synchronously enter on PiP request`() {
        listOf(31, 34).forEach { sdkInt ->
            val host = FakeHost(sdkInt)
            val controller = PictureInPictureController(host)
            controller.setPlaybackActive(true)
            assertTrue(controller.onPictureInPictureRequested())

            assertEquals(listOf(false), host.paramsUpdates.map { it.first })
            assertEquals(1, host.enterCalls)
            assertEquals(listOf("prepare", "enter"), host.trace)
        }
    }

    @Test fun `api 35 auto enters and prepares at transition start without legacy entry`() {
        val host = FakeHost(35)
        val controller = PictureInPictureController(host)
        controller.setPlaybackActive(true)
        controller.onUserLeaveHint()
        assertEquals(listOf(true), host.paramsUpdates.map { it.first })
        assertEquals(emptyList<PictureInPictureEvent>(), host.events)
        assertEquals(0, host.enterCalls)

        assertTrue(controller.onPictureInPictureRequested())
        assertEquals(0, host.enterCalls)

        controller.onPictureInPictureUiStateChanged(true)
        assertEquals(PictureInPictureEvent(PictureInPictureEvent.Kind.PREPARE), host.events.single())
        assertEquals(0, host.enterCalls)
    }

    @Test fun `inactive PiP request is handled without entry and back-equivalent leave hint stays idle`() {
        val host = FakeHost(34)
        val controller = PictureInPictureController(host)
        assertTrue(controller.onPictureInPictureRequested())
        controller.onUserLeaveHint()

        assertEquals(0, host.enterCalls)
        assertEquals(emptyList<PictureInPictureEvent>(), host.events)
    }

    @Test fun `manual entry and callbacks are idempotent`() {
        val host = FakeHost(35)
        val controller = PictureInPictureController(host)
        assertNull(controller.requestEnter())
        controller.onPictureInPictureModeChanged(true)
        controller.onPictureInPictureModeChanged(true)
        controller.onPictureInPictureModeChanged(false)
        controller.onPictureInPictureModeChanged(false)
        assertEquals(1, host.enterCalls)
        assertEquals(listOf(
            PictureInPictureEvent(PictureInPictureEvent.Kind.PREPARE),
            PictureInPictureEvent(PictureInPictureEvent.Kind.STATE, active = true),
            PictureInPictureEvent(PictureInPictureEvent.Kind.STATE, active = false),
        ), host.events)
    }

    @Test fun `rejected entry restores presentation`() {
        val host = FakeHost(30).apply { enterResult = false }
        val controller = PictureInPictureController(host)
        assertEquals(PictureInPictureRequestError.ENTER_REJECTED, controller.requestEnter())
        assertEquals("PIP_ENTER_REJECTED", host.events[1].code)
        assertEquals(false, host.events.last().active)
    }

    @Test fun `resume cancels an uncommitted transition`() {
        val host = FakeHost(35)
        val controller = PictureInPictureController(host)
        controller.setPlaybackActive(true)
        controller.onPictureInPictureUiStateChanged(true)
        controller.onResume(false)
        assertEquals(false, host.events.last().active)
    }

    @Test fun `manual exit restores the single task`() {
        val host = FakeHost(35)
        val controller = PictureInPictureController(host)
        assertNull(controller.requestExit())
        assertEquals(1, host.restoreCalls)
        assertTrue(controller.supported)
    }

    @Test
    fun `PiP enables actions only while active and refreshes play pause state`() {
        val host = FakeHost(35)
        val controller = PictureInPictureController(host)
        controller.setPlaybackActive(true)
        controller.onPictureInPictureModeChanged(true)
        controller.setPlaybackActive(false)
        controller.onPictureInPictureModeChanged(false)

        assertEquals(listOf(true, false), host.actionsEnabledUpdates)
        assertEquals(false to false, host.paramsUpdates.last())
    }
}
