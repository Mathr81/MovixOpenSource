import React, { useEffect, useRef } from 'react';
import type videojsType from 'video.js';
import 'video.js/dist/video-js.css';

let videojsLib: typeof videojsType | null = null;
const loadVideoJS = async (): Promise<typeof videojsType> =>
  videojsLib ?? (videojsLib = (await import('video.js')).default);

interface VideoJSProps {
  src: string;
  controls?: boolean;
  autoplay?: boolean;
  className?: string;
  onReady?: (player: any) => void;
}

const VideoJS: React.FC<VideoJSProps> = ({
  src,
  controls = true,
  autoplay = false,
  className = '',
  onReady
}) => {
  const videoRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const videojs = await loadVideoJS();
      if (cancelled) return;

      if (!playerRef.current && videoRef.current) {
        const videoElement = document.createElement('video-js');
        videoElement.classList.add('vjs-big-play-centered');
        videoRef.current.appendChild(videoElement);

        playerRef.current = videojs(videoElement, {
          controls,
          autoplay,
          fluid: true,
          sources: [{
            src,
            type: 'application/x-mpegURL'
          }],
          html5: {
            hls: {
              enableLowInitialPlaylist: true,
              smoothQualityChange: true,
              overrideNative: true
            }
          }
        }, () => {
          onReady && onReady(playerRef.current);
        });
      }
    })();

    return () => {
      cancelled = true;
      if (playerRef.current) {
        playerRef.current.dispose();
        playerRef.current = null;
      }
    };
  }, [src, controls, autoplay, onReady]);

  return (
    <div data-vjs-player>
      <div ref={videoRef} className={className} />
    </div>
  );
};

export default VideoJS;