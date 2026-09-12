import Foundation
import MediaPlayer
import UIKit

/// Destination des métadonnées de lecture en cours.
///
/// `MPNowPlayingInfoCenter` est un singleton système : le prendre derrière un
/// protocole est ce qui rend ce code testable sans écran verrouillé.
protocol NowPlayingInfoSink: AnyObject {
  var nowPlayingInfo: [String: Any]? { get set }
}

extension MPNowPlayingInfoCenter: NowPlayingInfoSink {}

/// Chargement de la jaquette publiée sous l'écran verrouillé.
protocol NowPlayingArtworkLoading {
  func loadArtwork(from url: URL) async -> UIImage?
}

/// Va chercher la jaquette en HTTPS, bornée en taille comme en durée.
///
/// L'URL vient de `PreparedNativePlaybackSource`, qui n'accepte qu'une URL
/// HTTPS canonique : ce chargeur n'a donc pas à re-valider le schéma, mais il
/// borne quand même ce qu'il accepte de lire. Une jaquette est un ornement —
/// elle ne doit jamais retenir de la mémoire ni retarder la lecture.
struct URLSessionNowPlayingArtworkLoader: NowPlayingArtworkLoading {
  static let maximumArtworkBytes = 4 * 1_024 * 1_024
  static let timeout: TimeInterval = 5

  private let session: URLSession

  init(session: URLSession? = nil) {
    if let session = session {
      self.session = session
      return
    }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = Self.timeout
    configuration.timeoutIntervalForResource = Self.timeout
    configuration.requestCachePolicy = .returnCacheDataElseLoad
    self.session = URLSession(configuration: configuration)
  }

  func loadArtwork(from url: URL) async -> UIImage? {
    guard let (data, response) = try? await session.data(from: url) else { return nil }
    if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
      return nil
    }
    guard data.count <= Self.maximumArtworkBytes else { return nil }
    return UIImage(data: data)
  }
}

/// Publie le titre et la jaquette pendant que la lecture appartient au natif.
///
/// Hors relais, la lecture vit dans la WebView et c'est WebKit qui alimente le
/// centre d'informations depuis `navigator.mediaSession` (voir
/// `src/injection/media-session.ts`). Le relais vers `AVPlayer` met d'abord la
/// vidéo web en pause — WebKit retire alors ses propres informations — puis
/// c'est cet objet qui prend la main. Les deux écrivains ne se chevauchent
/// donc jamais, et `end()` rend la place en fin de relais.
///
/// Aucune commande distante n'est enregistrée ici : les transports appartiennent
/// à la fenêtre Picture-in-Picture, et les brancher demanderait de les faire
/// transiter par la machine à états de `NativePlaybackController`, ce qui est un
/// autre changement que celui-ci.
@MainActor
final class NowPlayingInfoPublisher {
  private let sink: NowPlayingInfoSink
  private let artworkLoader: NowPlayingArtworkLoading
  private var artworkTask: Task<Void, Never>?
  /// Distingue « notre session » de celle d'un autre producteur : `end()` ne
  /// doit effacer que ce que cet objet a publié.
  private var isPublishing = false

  init(
    sink: NowPlayingInfoSink? = nil,
    artworkLoader: NowPlayingArtworkLoading = URLSessionNowPlayingArtworkLoader()
  ) {
    self.sink = sink ?? MPNowPlayingInfoCenter.default()
    self.artworkLoader = artworkLoader
  }

  func begin(
    title: String?,
    posterURL: URL?,
    duration: TimeInterval?,
    position: TimeInterval,
    rate: Float
  ) {
    artworkTask?.cancel()
    artworkTask = nil
    isPublishing = true

    var info: [String: Any] = [
      MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.video.rawValue,
      MPMediaItemPropertyTitle: title ?? "Movix",
      MPMediaItemPropertyArtist: "Movix",
      MPNowPlayingInfoPropertyElapsedPlaybackTime: max(0, position),
      MPNowPlayingInfoPropertyPlaybackRate: Double(rate),
    ]
    // Une durée absente vaut mieux qu'une durée fausse : sans elle le système
    // affiche une lecture en direct, avec une valeur inventée il dessine une
    // barre de progression qui ment.
    if let duration = duration, duration.isFinite, duration > 0 {
      info[MPMediaItemPropertyPlaybackDuration] = duration
    }
    sink.nowPlayingInfo = info

    guard let posterURL = posterURL else { return }
    artworkTask = Task { [weak self, artworkLoader = self.artworkLoader] in
      let image = await artworkLoader.loadArtwork(from: posterURL)
      guard !Task.isCancelled, let self = self, let image = image else { return }
      self.attachArtwork(image)
    }
  }

  func update(position: TimeInterval, rate: Float) {
    guard isPublishing, var info = sink.nowPlayingInfo else { return }
    info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = max(0, position)
    info[MPNowPlayingInfoPropertyPlaybackRate] = Double(rate)
    sink.nowPlayingInfo = info
  }

  func end() {
    artworkTask?.cancel()
    artworkTask = nil
    guard isPublishing else { return }
    isPublishing = false
    sink.nowPlayingInfo = nil
  }

  /// La jaquette arrive après coup : elle ne rejoint la fiche que si celle-ci
  /// est toujours la nôtre, sinon elle se poserait sur la session d'un autre.
  private func attachArtwork(_ image: UIImage) {
    guard isPublishing, var info = sink.nowPlayingInfo else { return }
    info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
    sink.nowPlayingInfo = info
  }
}
