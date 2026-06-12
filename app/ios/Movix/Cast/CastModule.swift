import Foundation

#if canImport(GoogleCast)
import GoogleCast
#endif

/// Bridge React Native → iOS Google Cast SDK.
/// Symétrique au CastModule Android.
/// Quand le SDK GoogleCast n'est pas disponible (pod non installé),
/// toutes les méthodes retournent false / nil sans crasher.
@objc(CastModule)
class CastModule: RCTEventEmitter {

  private static let CAST_SESSION_STARTED  = "CAST_SESSION_STARTED"
  private static let CAST_SESSION_RESUMED  = "CAST_SESSION_RESUMED"
  private static let CAST_SESSION_ENDED    = "CAST_SESSION_ENDED"
  private static let CAST_SESSION_FAILED   = "CAST_SESSION_FAILED"

  override static func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! {
    return [
      CastModule.CAST_SESSION_STARTED,
      CastModule.CAST_SESSION_RESUMED,
      CastModule.CAST_SESSION_ENDED,
      CastModule.CAST_SESSION_FAILED,
    ]
  }

  @objc
  func isSupported(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
#if canImport(GoogleCast)
    let context = GCKCastContext.sharedInstance()
    resolve(context.castState != .noDevicesAvailable)
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
    guard let mediaUrl = URL(string: url) else {
      resolve(false)
      return
    }
    let metadata = GCKMediaMetadata(metadataType: .movie)
    metadata.setString(title, forKey: kGCKMetadataKeyTitle)
    if let posterStr = poster, let posterUrl = URL(string: posterStr) {
      metadata.addImage(GCKImage(url: posterUrl, width: 480, height: 720))
    }
    let builder = GCKMediaInformationBuilder(contentURL: mediaUrl)
    builder.contentType = "application/x-mpegURL"
    builder.metadata = metadata
    let mediaInfo = builder.build()

    let options = GCKMediaLoadOptions()
    options.playPosition = currentTimeSec

    let session = GCKCastContext.sharedInstance().sessionManager.currentCastSession
    guard let remoteClient = session?.remoteMediaClient else {
      resolve(false)
      return
    }
    remoteClient.loadMedia(mediaInfo, with: options)
    resolve(true)
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
    let session = GCKCastContext.sharedInstance().sessionManager.currentCastSession
    session?.remoteMediaClient?.stop()
    resolve(true)
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
    let pos = GCKCastContext.sharedInstance().sessionManager.currentCastSession?.remoteMediaClient?.approximateStreamPosition() ?? 0
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
    let mgr = GCKCastContext.sharedInstance().sessionManager
    switch mgr.connectionState {
    case .connected:  resolve("connected")
    case .connecting: resolve("starting")
    case .disconnecting: resolve("ending")
    default:          resolve("idle")
    }
#else
    resolve("idle")
#endif
  }
}
