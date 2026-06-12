import Foundation

#if canImport(GoogleCast)
import GoogleCast
#endif

/// Bridge React Native → iOS Google Cast SDK.
/// Symétrique au CastModule Android (com.movix.app.cast.CastModule).
///
/// Quand le SDK GoogleCast n'est pas lié (pod absent), toutes les méthodes
/// dégradent proprement (isSupported → false) sans crasher, grâce aux gardes
/// `#if canImport(GoogleCast)`.
///
/// Évènements émis (via RCTDeviceEventEmitter, reçus par DeviceEventEmitter JS) :
///   CAST_SESSION_STARTED  { deviceName, durationSec }
///   CAST_SESSION_RESUMED  { deviceName, durationSec }
///   CAST_SESSION_ENDED    { error }
///   CAST_SESSION_FAILED   { error }
@objc(CastModule)
class CastModule: RCTEventEmitter {

  private var hasListeners = false

  // Requête de lecture mémorisée tant qu'aucune session n'est active : jouée
  // dès qu'un appareil est sélectionné (didStart). Mirroir du pendingLoad Android.
  private var pendingURL: String?
  private var pendingTitle: String = "Movix"
  private var pendingPoster: String?
  private var pendingPosition: Double = 0

  override static func requiresMainQueueSetup() -> Bool { true }

  override func supportedEvents() -> [String]! {
    return [
      "CAST_SESSION_STARTED",
      "CAST_SESSION_RESUMED",
      "CAST_SESSION_ENDED",
      "CAST_SESSION_FAILED",
    ]
  }

  override func startObserving() {
    hasListeners = true
#if canImport(GoogleCast)
    DispatchQueue.main.async {
      GCKCastContext.sharedInstance().sessionManager.add(self)
    }
#endif
  }

  override func stopObserving() {
    hasListeners = false
#if canImport(GoogleCast)
    DispatchQueue.main.async {
      GCKCastContext.sharedInstance().sessionManager.remove(self)
    }
#endif
  }

  private func emit(_ name: String, _ body: [String: Any]?) {
    if hasListeners { sendEvent(withName: name, body: body) }
  }

  // MARK: - Méthodes exposées à JS

  @objc
  func isSupported(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
#if canImport(GoogleCast)
    // Cast est disponible dès que le SDK est lié (le picker affichera
    // « aucun appareil » s'il n'y a pas de Chromecast à proximité). Identique
    // au comportement Android qui renvoie true si Play Services est présent.
    resolve(true)
#else
    resolve(false)
#endif
  }

  @objc
  func showPicker(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
#if canImport(GoogleCast)
    DispatchQueue.main.async {
      GCKCastContext.sharedInstance().presentCastDialog()
      resolve(true)
    }
#else
    resolve(false)
#endif
  }

  @objc
  func loadMedia(
    _ url: String,
    title: String,
    poster: String?,
    currentTimeSec: Double,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
#if canImport(GoogleCast)
    let scheme = url.components(separatedBy: ":").first?.lowercased() ?? ""
    if scheme != "http" && scheme != "https" {
      reject("INVALID_URL", "Only http(s) URLs are castable", nil)
      return
    }
    DispatchQueue.main.async {
      let manager = GCKCastContext.sharedInstance().sessionManager
      if let session = manager.currentCastSession, session.connectionState == .connected {
        self.playMedia(on: session, url: url, title: title, poster: poster, position: currentTimeSec)
        resolve(true)
        return
      }
      // Pas de session : mémoriser puis ouvrir le picker. didStart jouera le média.
      self.pendingURL = url
      self.pendingTitle = title
      self.pendingPoster = poster
      self.pendingPosition = currentTimeSec
      GCKCastContext.sharedInstance().presentCastDialog()
      resolve(true)
    }
#else
    resolve(false)
#endif
  }

  @objc
  func stop(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
#if canImport(GoogleCast)
    DispatchQueue.main.async {
      self.pendingURL = nil
      let manager = GCKCastContext.sharedInstance().sessionManager
      manager.currentCastSession?.remoteMediaClient?.stop()
      _ = manager.endSessionAndStopCasting(true)
      resolve(true)
    }
#else
    resolve(false)
#endif
  }

  @objc
  func getCurrentDeviceName(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
#if canImport(GoogleCast)
    let name = GCKCastContext.sharedInstance().sessionManager.currentCastSession?.device.friendlyName
    resolve(name)
#else
    resolve(nil)
#endif
  }

  @objc
  func getCurrentPositionSec(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
#if canImport(GoogleCast)
    let pos = GCKCastContext.sharedInstance().sessionManager
      .currentCastSession?.remoteMediaClient?.approximateStreamPosition() ?? 0
    resolve(pos)
#else
    resolve(0)
#endif
  }

  @objc
  func getSessionState(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
#if canImport(GoogleCast)
    switch GCKCastContext.sharedInstance().sessionManager.connectionState {
    case .connected:     resolve("connected")
    case .connecting:    resolve("starting")
    case .disconnecting: resolve("ending")
    default:             resolve("idle")
    }
#else
    resolve("idle")
#endif
  }

#if canImport(GoogleCast)
  private func playMedia(
    on session: GCKCastSession,
    url: String,
    title: String,
    poster: String?,
    position: Double
  ) {
    guard let mediaUrl = URL(string: url) else { return }
    let metadata = GCKMediaMetadata(metadataType: .movie)
    metadata.setString(title, forKey: kGCKMetadataKeyTitle)
    if let posterStr = poster, let posterUrl = URL(string: posterStr) {
      metadata.addImage(GCKImage(url: posterUrl, width: 480, height: 720))
    }
    let builder = GCKMediaInformationBuilder(contentURL: mediaUrl)
    builder.streamType = .buffered
    builder.contentType = "application/x-mpegURL"
    builder.metadata = metadata
    let mediaInfo = builder.build()

    let options = GCKMediaLoadOptions()
    options.playPosition = position
    session.remoteMediaClient?.loadMedia(mediaInfo, with: options)
  }

  private func durationSec(for session: GCKSession) -> Double {
    let ms = session.remoteMediaClient?.mediaStatus?.mediaInformation?.streamDuration ?? 0
    return ms.isFinite ? ms : 0
  }
#endif
}

#if canImport(GoogleCast)
extension CastModule: GCKSessionManagerListener {

  func sessionManager(_ sessionManager: GCKSessionManager, didStart session: GCKSession) {
    emit("CAST_SESSION_STARTED", [
      "deviceName": session.device.friendlyName ?? "",
      "durationSec": durationSec(for: session),
    ])
    if let url = pendingURL, let castSession = session as? GCKCastSession {
      pendingURL = nil
      playMedia(on: castSession, url: url, title: pendingTitle,
                poster: pendingPoster, position: pendingPosition)
    }
  }

  func sessionManager(_ sessionManager: GCKSessionManager, didResumeSession session: GCKSession) {
    emit("CAST_SESSION_RESUMED", [
      "deviceName": session.device.friendlyName ?? "",
      "durationSec": durationSec(for: session),
    ])
    if let url = pendingURL, let castSession = session as? GCKCastSession {
      pendingURL = nil
      playMedia(on: castSession, url: url, title: pendingTitle,
                poster: pendingPoster, position: pendingPosition)
    }
  }

  func sessionManager(_ sessionManager: GCKSessionManager, didEnd session: GCKSession, withError error: Error?) {
    pendingURL = nil
    emit("CAST_SESSION_ENDED", ["error": (error == nil) ? 0 : 1])
  }

  func sessionManager(_ sessionManager: GCKSessionManager, didFailToStart session: GCKSession, withError error: Error) {
    pendingURL = nil
    emit("CAST_SESSION_FAILED", ["error": 1])
  }
}
#endif
