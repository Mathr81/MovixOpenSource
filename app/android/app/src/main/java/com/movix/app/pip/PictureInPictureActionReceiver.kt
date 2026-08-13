package com.movix.app.pip

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class PictureInPictureActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.action != ACTION) return
        PictureInPictureActionDispatcher.dispatch(intent.getStringExtra(EXTRA_ACTION))
    }

    companion object {
        const val ACTION = "com.movix.app.pip.ACTION_CONTROL"
        const val EXTRA_ACTION = "com.movix.app.pip.EXTRA_ACTION"
    }
}
