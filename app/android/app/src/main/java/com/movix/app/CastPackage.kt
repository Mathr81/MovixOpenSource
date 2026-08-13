package com.movix.app

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager
import com.movix.app.cast.CastModule
import com.movix.app.cast.ForegroundCastRelayClient

/**
 * Package React Native pour enregistrer le module Google Cast.
 */
class CastPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(
            CastModule(
                reactContext,
                ForegroundCastRelayClient(reactContext),
            ),
        )
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return emptyList()
    }
}
