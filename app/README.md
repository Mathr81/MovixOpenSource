# Movix — Application Mobile

Application iOS & Android pour Movix. WebView avec l'extension Movix intégrée (remplacement du userscript Tampermonkey) et changeur DNS 1.1.1.1.

> ⚠️ **Statut iOS : non testé, non compilé**
>
> Je n'ai pas de Mac à disposition, donc la partie iOS (Xcode, CocoaPods, `NEDNSSettingsManager`, entitlements, archive, signature, App Store) n'a **jamais été buildée ni testée**. Le code natif Swift/Objective-C et la config `Podfile` sont rédigés à l'aveugle à partir de la documentation Apple.
>
> Il est très probable qu'il y ait des erreurs de build, des permissions manquantes, du linking à corriger ou un bridging header à ajuster avant que l'app tourne sur un vrai device iOS.
>
> **Toute aide est la bienvenue** : si tu as un Mac et un peu de temps, n'hésite pas à tester, ouvrir une issue ou soumettre une PR. La partie **Android** est elle fonctionnelle et testée localement.

## Architecture

```
app/
├── src/
│   ├── App.tsx                    # Navigation (Browser + Settings)
│   ├── screens/
│   │   ├── BrowserScreen.tsx      # WebView principal + toolbar
│   │   └── SettingsScreen.tsx     # Toggle DNS + infos extension
│   ├── components/
│   │   ├── WebViewBrowser.tsx     # WebView avec injection userscript
│   │   └── BrowserToolbar.tsx     # Barre de navigation
│   ├── services/
│   │   ├── bridge.ts             # Bridge RN ↔ WebView (remplace GM_xmlhttpRequest)
│   │   └── dns.ts                # Wrapper module DNS natif
│   ├── injection/
│   │   ├── bridge-runtime.ts     # JS injecté dans le WebView (API GM_*)
│   │   ├── inject.ts             # Assembleur bridge + userscript
│   │   └── userscript-source.ts  # Source du userscript (auto-généré)
│   └── config/
│       └── index.ts              # Configuration de l'app
├── android/                       # Code natif Android (VPN DNS)
├── ios/                           # Code natif iOS (NEDNSSettings)
└── scripts/
    └── build-userscript.js        # Génère userscript-source.ts
```

### Comment ça marche

1. **WebView** charge `movix.tax`
2. **Bridge runtime** est injecté AVANT le chargement de la page — fournit `GM_xmlhttpRequest`, `GM_getValue`, `GM_setValue`, `GM_deleteValue`, `unsafeWindow`
3. **Userscript original** est injecté et fonctionne comme dans Tampermonkey
4. Quand le userscript fait une requête via `GM_xmlhttpRequest`, le bridge envoie un message à React Native
5. **React Native** fait la requête HTTP nativement (pas de CORS) et renvoie la réponse
6. **DNS 1.1.1.1** : sur Android via un VPN local, sur iOS via `NEDNSSettingsManager`

## Prérequis

- Node.js 18+
- React Native CLI (`npm install -g @react-native-community/cli`)
- **Android** : Android Studio, JDK 17, Android SDK 35
- **iOS** : Xcode 15+, CocoaPods (`gem install cocoapods`)

## Installation

```bash
cd app

# Installer les dépendances
npm install

# Générer le userscript source
node scripts/build-userscript.js

# iOS seulement
cd ios && pod install && cd ..
```

## Lancement

```bash
# Android
npm run android

# iOS
npm run ios

# Metro bundler seul
npm run start
```

## Build de production

### Android (APK / AAB)

```bash
cd android
./gradlew assembleRelease    # APK
./gradlew bundleRelease      # AAB (Play Store)
```

L'APK sera dans `android/app/build/outputs/apk/release/`.

### iOS

> ⚠️ Section non vérifiée — voir l'avertissement en haut du README. Les étapes ci-dessous sont les étapes Xcode standard pour un projet React Native, mais elles n'ont pas été exécutées sur ce projet.

1. Ouvrir `ios/Movix.xcworkspace` dans Xcode
2. Sélectionner le scheme "Movix" et la target device
3. Product → Archive

## DNS 1.1.1.1

### Android
- Utilise `VpnService` pour créer un VPN local
- Seules les requêtes DNS sont redirigées vers 1.1.1.1
- Aucune donnée ne transite par un serveur tiers
- L'utilisateur doit approuver la connexion VPN

### iOS
- Utilise `NEDNSSettingsManager` (iOS 14+)
- DNS-over-HTTPS vers `cloudflare-dns.com`
- Nécessite l'entitlement `com.apple.developer.networking.dns-settings`
- Requiert un profil de provisioning avec cette capability

## Mise à jour du userscript

Quand le userscript (`../userscript/movix.user.js`) est modifié :

```bash
node scripts/build-userscript.js
```

Puis rebuild l'app.

## Notes

- Le `DnsPackage.kt` doit être enregistré dans `MainApplication.kt` (ajouté au `getPackages()`)
- Pour iOS, le bridging header doit pointer vers `Movix-Bridging-Header.h`
- L'app exclut son propre trafic du VPN DNS pour éviter les boucles
- Le mode audio en arrière-plan est activé pour la lecture vidéo continue
