package com.movix.app.pip

import android.app.Activity
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.os.Build
import android.util.Rational
import com.movix.app.MainActivity

class AndroidPictureInPictureHost(private val activity: Activity) : PictureInPictureHost {
    private var autoEnterEnabled = false
    private var playbackPlaying = false

    override val sdkInt get() = Build.VERSION.SDK_INT

    override fun hasSystemFeature() = activity.packageManager
        .hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

    private fun remoteAction(
        action: PictureInPictureAction,
        requestCode: Int,
        iconRes: Int,
        titleRes: Int,
    ): RemoteAction {
        val title = activity.getString(titleRes)
        val intent = Intent(activity, PictureInPictureActionReceiver::class.java).apply {
            this.action = PictureInPictureActionReceiver.ACTION
            putExtra(PictureInPictureActionReceiver.EXTRA_ACTION, action.wireValue)
        }
        val pendingIntent = PendingIntent.getBroadcast(
            activity,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return RemoteAction(
            Icon.createWithResource(activity, iconRes),
            title,
            title,
            pendingIntent,
        )
    }

    private fun actions(playing: Boolean) = listOf(
        remoteAction(
            PictureInPictureAction.SEEK_BACKWARD,
            1,
            android.R.drawable.ic_media_rew,
            com.movix.app.R.string.pip_rewind_10,
        ),
        remoteAction(
            PictureInPictureAction.TOGGLE_PLAYBACK,
            2,
            if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
            if (playing) com.movix.app.R.string.pip_pause else com.movix.app.R.string.pip_play,
        ),
        remoteAction(
            PictureInPictureAction.SEEK_FORWARD,
            3,
            android.R.drawable.ic_media_ff,
            com.movix.app.R.string.pip_forward_10,
        ),
    )

    private fun params() = PictureInPictureParams.Builder()
        .setAspectRatio(Rational(16, 9))
        .also { builder ->
            runCatching { actions(playbackPlaying) }
                .getOrDefault(emptyList())
                .let(builder::setActions)
            if (Build.VERSION.SDK_INT >= 35) builder.setAutoEnterEnabled(autoEnterEnabled)
        }
        .build()

    override fun updateParams(autoEnter: Boolean, playbackPlaying: Boolean) {
        if (Build.VERSION.SDK_INT < 26) return
        autoEnterEnabled = autoEnter
        this.playbackPlaying = playbackPlaying
        activity.setPictureInPictureParams(params())
    }

    override fun setActionsEnabled(enabled: Boolean) {
        PictureInPictureActionDispatcher.setEnabled(enabled)
    }

    override fun enter(): Boolean {
        if (Build.VERSION.SDK_INT < 26) return false
        return activity.enterPictureInPictureMode(params())
    }

    override fun restore() = runCatching {
        activity.startActivity(Intent(activity, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        })
        true
    }.getOrDefault(false)

    override fun emit(event: PictureInPictureEvent) = PictureInPictureEvents.emit(event)
}
