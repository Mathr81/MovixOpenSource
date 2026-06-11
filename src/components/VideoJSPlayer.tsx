import React, { useEffect, useRef } from 'react';
import type videojsType from 'video.js';
import 'video.js/dist/video-js.css';
import type Player from 'video.js/dist/types/player';

let videojsLib: typeof videojsType | null = null;
const loadVideoJS = async (): Promise<typeof videojsType> =>
  videojsLib ?? (videojsLib = (await import('video.js')).default);

interface VideoJSPlayerProps {
  src: string;
  type?: string;
  poster?: string;
  onReady?: (player: Player) => void;
  onError?: (error: any) => void;
}

export const VideoJSPlayer: React.FC<VideoJSPlayerProps> = ({
  src,
  type = 'application/x-mpegURL',
  poster,
  onReady,
  onError
}) => {
  const videoRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<Player | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Options setup
    const options = {
      autoplay: true,
      controls: true,
      responsive: true,
      fluid: true,
      poster: poster,
      sources: [{
        src: src,
        type: type
      }],
      html5: {
        vhs: {
          overrideNative: true,
          enableLowInitialPlaylist: true,
          // Handle raw TS segments if possible
        },
        nativeAudioTracks: false,
        nativeVideoTracks: false
      }
    };

    (async () => {
      const videojs = await loadVideoJS();
      if (cancelled) return;

      // Initialize player
      if (!playerRef.current) {
        const videoElement = document.createElement("video-js");
        videoElement.classList.add('vjs-big-play-centered');

        if (videoRef.current) {
          videoRef.current.appendChild(videoElement);
        }

        const player = playerRef.current = videojs(videoElement, options, () => {
          videojs.log('player is ready');
          onReady && onReady(player);
        });

        player.on('error', () => {
          console.error('VideoJS Error:', player.error());
          onError && onError(player.error());
        });

      } else {
        // Update existing player
        const player = playerRef.current;
        player.src(options.sources);
        player.poster(options.poster || '');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [src, type, poster, onReady, onError]);

  // Dispose the player on unmount
  useEffect(() => {
    const player = playerRef.current;
    return () => {
      if (player && !player.isDisposed()) {
        player.dispose();
        playerRef.current = null;
      }
    };
  }, []);

  return (
    <div data-vjs-player style={{ width: '100%', height: '100%' }}>
      <div ref={videoRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
};

export default VideoJSPlayer;