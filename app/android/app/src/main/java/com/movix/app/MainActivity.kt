package com.movix.app

import android.app.PictureInPictureParams
import android.os.Build
import android.util.Rational
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

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

    /** Met à jour les params PiP en temps réel (API 31+). setAutoEnterEnabled(true) permet
     *  au système de basculer automatiquement en PiP dans tous les scénarios de background
     *  (bouton Home, swipe, écran éteint, bouton Power) sans passer par onUserLeaveHint. */
    fun updatePipParams(playing: Boolean) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        try {
            val params = PictureInPictureParams.Builder()
                .setAspectRatio(Rational(16, 9))
                .setAutoEnterEnabled(playing)
                .build()
            setPictureInPictureParams(params)
        } catch (_: Throwable) {}
    }

    private fun enterPipSafely() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        try {
            val builder = PictureInPictureParams.Builder()
                .setAspectRatio(Rational(16, 9))
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                builder.setAutoEnterEnabled(isVideoPlaying)
            }
            enterPictureInPictureMode(builder.build())
        } catch (_: Throwable) {
            // PiP indisponible (désactivé par l'utilisateur, OEM, etc.) — on
            // laisse simplement l'app passer en arrière-plan normalement.
        }
    }
}
