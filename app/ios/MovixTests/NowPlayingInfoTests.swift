import MediaPlayer
import UIKit
import XCTest
@testable import Movix

private final class RecordingNowPlayingInfoSink: NowPlayingInfoSink {
  var nowPlayingInfo: [String: Any]?
}

private final class StubArtworkLoader: NowPlayingArtworkLoading {
  let image: UIImage?
  let started = XCTestExpectation(description: "artwork requested")
  private(set) var requestedURLs = [URL]()

  init(image: UIImage?) {
    self.image = image
  }

  func loadArtwork(from url: URL) async -> UIImage? {
    requestedURLs.append(url)
    started.fulfill()
    return image
  }
}

private func solidImage() -> UIImage {
  let size = CGSize(width: 4, height: 4)
  return UIGraphicsImageRenderer(size: size).image { context in
    UIColor.purple.setFill()
    context.fill(CGRect(origin: .zero, size: size))
  }
}

@MainActor
final class NowPlayingInfoTests: XCTestCase {
  func testBeginPublishesTitleDurationAndPosition() {
    let sink = RecordingNowPlayingInfoSink()
    let publisher = NowPlayingInfoPublisher(
      sink: sink,
      artworkLoader: StubArtworkLoader(image: nil)
    )

    publisher.begin(
      title: "Dune",
      posterURL: nil,
      duration: 7200,
      position: 42,
      rate: 0
    )

    let info = sink.nowPlayingInfo
    XCTAssertNotNil(info)
    XCTAssertEqual(info?[MPMediaItemPropertyTitle] as? String, "Dune")
    XCTAssertEqual(info?[MPMediaItemPropertyArtist] as? String, "Movix")
    XCTAssertEqual(info?[MPMediaItemPropertyPlaybackDuration] as? TimeInterval, 7200)
    XCTAssertEqual(
      info?[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? TimeInterval,
      42
    )
    XCTAssertEqual(info?[MPNowPlayingInfoPropertyPlaybackRate] as? Double, 0)
    XCTAssertEqual(
      info?[MPNowPlayingInfoPropertyMediaType] as? UInt,
      MPNowPlayingInfoMediaType.video.rawValue
    )
  }

  func testMissingTitleFallsBackToTheApplicationName() {
    let sink = RecordingNowPlayingInfoSink()
    let publisher = NowPlayingInfoPublisher(
      sink: sink,
      artworkLoader: StubArtworkLoader(image: nil)
    )

    publisher.begin(title: nil, posterURL: nil, duration: 10, position: 0, rate: 0)

    XCTAssertEqual(sink.nowPlayingInfo?[MPMediaItemPropertyTitle] as? String, "Movix")
  }

  // Une durée absente ou non finie doit disparaitre de la fiche : le système
  // affiche alors une lecture en direct au lieu d'une barre de progression
  // fausse.
  func testNonFiniteDurationIsOmitted() {
    let sink = RecordingNowPlayingInfoSink()
    let publisher = NowPlayingInfoPublisher(
      sink: sink,
      artworkLoader: StubArtworkLoader(image: nil)
    )

    publisher.begin(
      title: "Live",
      posterURL: nil,
      duration: .infinity,
      position: 0,
      rate: 1
    )

    XCTAssertNil(sink.nowPlayingInfo?[MPMediaItemPropertyPlaybackDuration])
  }

  func testUpdateOnlyMovesPositionAndRate() {
    let sink = RecordingNowPlayingInfoSink()
    let publisher = NowPlayingInfoPublisher(
      sink: sink,
      artworkLoader: StubArtworkLoader(image: nil)
    )
    publisher.begin(title: "Dune", posterURL: nil, duration: 7200, position: 42, rate: 0)

    publisher.update(position: 120, rate: 1.5)

    XCTAssertEqual(sink.nowPlayingInfo?[MPMediaItemPropertyTitle] as? String, "Dune")
    XCTAssertEqual(
      sink.nowPlayingInfo?[MPMediaItemPropertyPlaybackDuration] as? TimeInterval,
      7200
    )
    XCTAssertEqual(
      sink.nowPlayingInfo?[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? TimeInterval,
      120
    )
    XCTAssertEqual(sink.nowPlayingInfo?[MPNowPlayingInfoPropertyPlaybackRate] as? Double, 1.5)
  }

  func testUpdateBeforeBeginPublishesNothing() {
    let sink = RecordingNowPlayingInfoSink()
    let publisher = NowPlayingInfoPublisher(
      sink: sink,
      artworkLoader: StubArtworkLoader(image: nil)
    )

    publisher.update(position: 10, rate: 1)

    XCTAssertNil(sink.nowPlayingInfo)
  }

  func testEndClearsTheCardExactlyOnce() {
    let sink = RecordingNowPlayingInfoSink()
    let publisher = NowPlayingInfoPublisher(
      sink: sink,
      artworkLoader: StubArtworkLoader(image: nil)
    )
    publisher.begin(title: "Dune", posterURL: nil, duration: 7200, position: 0, rate: 1)

    publisher.end()
    XCTAssertNil(sink.nowPlayingInfo)

    // Une seconde fin ne doit pas effacer la fiche d'un autre producteur : la
    // lecture est revenue à la WebView, qui republie la sienne.
    sink.nowPlayingInfo = [MPMediaItemPropertyTitle: "WebKit"]
    publisher.end()
    XCTAssertEqual(sink.nowPlayingInfo?[MPMediaItemPropertyTitle] as? String, "WebKit")
  }

  func testArtworkJoinsTheCardOnceLoaded() async {
    let sink = RecordingNowPlayingInfoSink()
    let loader = StubArtworkLoader(image: solidImage())
    let publisher = NowPlayingInfoPublisher(sink: sink, artworkLoader: loader)
    let poster = URL(string: "https://image.tmdb.org/poster.jpg")!

    publisher.begin(title: "Dune", posterURL: poster, duration: 7200, position: 0, rate: 1)
    await fulfillment(of: [loader.started], timeout: 2)
    // Laisse la continuation reprendre sur l'acteur principal avant de lire.
    await Task.yield()

    XCTAssertEqual(loader.requestedURLs, [poster])
    XCTAssertNotNil(sink.nowPlayingInfo?[MPMediaItemPropertyArtwork])
    XCTAssertEqual(sink.nowPlayingInfo?[MPMediaItemPropertyTitle] as? String, "Dune")
  }

  func testArtworkIsNotRequestedWithoutAPoster() {
    let sink = RecordingNowPlayingInfoSink()
    let loader = StubArtworkLoader(image: solidImage())
    let publisher = NowPlayingInfoPublisher(sink: sink, artworkLoader: loader)

    publisher.begin(title: "Dune", posterURL: nil, duration: 7200, position: 0, rate: 1)

    XCTAssertTrue(loader.requestedURLs.isEmpty)
    XCTAssertNil(sink.nowPlayingInfo?[MPMediaItemPropertyArtwork])
  }
}
