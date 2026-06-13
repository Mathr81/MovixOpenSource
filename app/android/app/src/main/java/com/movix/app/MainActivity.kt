package com.movix.app

import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.util.Rational
import androidx.annotation.RequiresApi
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.bridge.Arguments
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.facebook.react.modules.core.DeviceEventManagerModule

class MainActivity : ReactActivity() {
    override fun getMainComponentName(): String = "Movix"

    override fun createReactActivityDelegate(): ReactActivityDelegate =
        DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

    companion object {
        /**
         * État de lecture du lecteur web, mis à jour depuis le JS via
         * [com.movix.app.pip.PipModule] à chaque play/pause. Sert à décider si
         * l'on bascule en Picture-in-Picture quand l'utilisateur quitte l'app.
         */
        @Volatile
        var isVideoPlaying: Boolean = false

        // Broadcast déclenché par les boutons de contrôle de la fenêtre PiP.
        private const val ACTION_PIP_CONTROL = "com.movix.app.PIP_CONTROL"
        private const val EXTRA_CONTROL = "control"
        private const val CONTROL_PLAY = 1
        private const val CONTROL_PAUSE = 2
        private const val CONTROL_FULLSCREEN = 3
    }

    /**
     * Reçoit les appuis sur les boutons de la fenêtre PiP (play/pause/plein écran).
     * play/pause sont relayés au JS (qui pilote l'élément <video>) ; plein écran
     * ramène l'app au premier plan (sort du PiP).
     */
    private val pipReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != ACTION_PIP_CONTROL) return
            when (intent.getIntExtra(EXTRA_CONTROL, 0)) {
                CONTROL_PLAY -> emitPipEvent("PIP_CONTROL", control = "play")
                CONTROL_PAUSE -> emitPipEvent("PIP_CONTROL", control = "pause")
                CONTROL_FULLSCREEN -> {
                    // Ramène l'Activity au premier plan : Android replie alors la
                    // fenêtre PiP et restaure l'app en plein écran.
                    val launch = Intent(applicationContext, MainActivity::class.java)
                        .addFlags(
                            Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                                Intent.FLAG_ACTIVITY_SINGLE_TOP,
                        )
                    startActivity(launch)
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val filter = IntentFilter(ACTION_PIP_CONTROL)
        // Broadcast strictement interne (nos propres PendingIntent) → non exporté.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(pipReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(pipReceiver, filter)
        }
    }

    override fun onDestroy() {
        try {
            unregisterReceiver(pipReceiver)
        } catch (_: Throwable) {
        }
        super.onDestroy()
    }

    /**
     * Appelé quand l'utilisateur quitte l'app (bouton home / aperçu des apps).
     * Si une vidéo est en cours de lecture, on bascule en Picture-in-Picture
     * pour continuer la lecture dans une fenêtre flottante.
     */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (isVideoPlaying && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            enterPipSafely()
        }
    }

    /**
     * Notifie le JS de l'entrée/sortie du mode PiP afin que [BrowserScreen] masque
     * la barre de paramètres (MiniPill) pendant que la fenêtre flottante est active.
     */
    override fun onPictureInPictureModeChanged(
        isInPictureInPictureMode: Boolean,
        newConfig: Configuration,
    ) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        emitPipEvent("PIP_MODE_CHANGED", inPip = isInPictureInPictureMode)
        // À l'entrée, (re)pose les actions avec la bonne icône play/pause.
        if (isInPictureInPictureMode && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            updatePipParams(isVideoPlaying)
        }
    }

    /** Met à jour les params PiP en temps réel (aspect ratio, auto-enter, boutons
     *  de contrôle). setAutoEnterEnabled(true) (API 31+) permet au système de
     *  basculer automatiquement en PiP dans tous les scénarios de background. */
    fun updatePipParams(playing: Boolean) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        try {
            val builder = PictureInPictureParams.Builder()
                .setAspectRatio(Rational(16, 9))
                .setActions(buildPipActions(playing))
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                builder.setAutoEnterEnabled(playing)
            }
            setPictureInPictureParams(builder.build())
        } catch (_: Throwable) {
        }
    }

    /** Entrée PiP déclenchée explicitement par le bouton PiP du lecteur web. */
    fun enterPipNow() {
        enterPipSafely()
    }

    private fun enterPipSafely() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        try {
            val builder = PictureInPictureParams.Builder()
                .setAspectRatio(Rational(16, 9))
                .setActions(buildPipActions(isVideoPlaying))
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                builder.setAutoEnterEnabled(isVideoPlaying)
            }
            enterPictureInPictureMode(builder.build())
        } catch (_: Throwable) {
            // PiP indisponible (désactivé par l'utilisateur, OEM, etc.) — on
            // laisse simplement l'app passer en arrière-plan normalement.
        }
    }

    /** Construit les boutons de contrôle affichés dans la fenêtre PiP :
     *  lecture/pause (icône selon l'état) + plein écran. */
    @RequiresApi(Build.VERSION_CODES.O)
    private fun buildPipActions(playing: Boolean): ArrayList<RemoteAction> {
        val actions = ArrayList<RemoteAction>()
        if (playing) {
            actions.add(makeRemoteAction(R.drawable.ic_pip_pause, "Pause", CONTROL_PAUSE))
        } else {
            actions.add(makeRemoteAction(R.drawable.ic_pip_play, "Lecture", CONTROL_PLAY))
        }
        actions.add(makeRemoteAction(R.drawable.ic_pip_fullscreen, "Plein écran", CONTROL_FULLSCREEN))
        return actions
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private fun makeRemoteAction(iconRes: Int, title: String, control: Int): RemoteAction {
        val intent = Intent(ACTION_PIP_CONTROL)
            .setPackage(packageName)
            .putExtra(EXTRA_CONTROL, control)
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags = flags or PendingIntent.FLAG_IMMUTABLE
        }
        // request code = control : chaque bouton garde son propre PendingIntent
        // (les extras sont bien rafraîchis lors des mises à jour des actions).
        val pending = PendingIntent.getBroadcast(this, control, intent, flags)
        val icon = Icon.createWithResource(this, iconRes)
        return RemoteAction(icon, title, title, pending)
    }

    /** Émet un évènement vers le JS via RCTDeviceEventEmitter. */
    private fun emitPipEvent(eventName: String, inPip: Boolean? = null, control: String? = null) {
        try {
            val reactContext = (application as MainApplication)
                .reactNativeHost.reactInstanceManager.currentReactContext ?: return
            val params = Arguments.createMap()
            inPip?.let { params.putBoolean("inPip", it) }
            control?.let { params.putString("control", it) }
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(eventName, params)
        } catch (_: Throwable) {
        }
    }
}
