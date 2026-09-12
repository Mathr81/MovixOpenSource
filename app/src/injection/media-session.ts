/**
 * Renseigne `navigator.mediaSession` depuis la page.
 *
 * Le lecteur web Movix ne pose jamais de métadonnées de session média. Sans
 * elles, l'écran verrouillé et le centre de contrôle n'ont que le titre du
 * document à afficher : « Movix — Regarder <film> en streaming », sans
 * jaquette, et les commandes système ne savent pas quel élément piloter. Le
 * shim comble ce trou côté page, là où vivent l'élément `<video>` et la
 * jaquette déjà chargée par le lecteur.
 *
 * Le script ne parle PAS au pont. C'est délibéré : le runtime injecté ne doit
 * émettre aucun message qui ne soit pas une requête de la page, et tout ce
 * dont il a besoin (l'élément `<video>`, le poster, le titre) est déjà dans le
 * document. Le maintien de l'écran allumé appartient à `playback-awake-shim`,
 * le Picture-in-Picture à `picture-in-picture-shim` : ce shim ne touche qu'à
 * `navigator.mediaSession` et ne peut donc pas entrer en conflit avec eux.
 *
 * L'élément actif est suivi en phase de capture sur `play` : la navigation SPA
 * (épisode suivant, autre film) remplace le `<video>` sans recharger la page,
 * et un écouteur posé sur un élément précis serait perdu au premier changement.
 */
export function buildMediaSession(): string {
  return `
(function() {
  'use strict';

  if (!navigator.mediaSession || typeof MediaMetadata !== 'function') return;
  if (window.__MOVIX_MEDIA_SESSION_INSTALLED__) return;
  window.__MOVIX_MEDIA_SESSION_INSTALLED__ = true;

  var session = navigator.mediaSession;
  var activeVideo = null;

  var MAX_TITLE_LENGTH = 256;
  var MAX_ARTWORK_URL_LENGTH = 16384;
  // Le centre de contrôle borne lui-même le saut par défaut a dix secondes
  // quand l'action n'en propose pas.
  var DEFAULT_SEEK_OFFSET_SEC = 10;

  // --- Métadonnées ---------------------------------------------------------

  // Seuls http(s) sont retenus : une source \`blob:\` ou \`data:\` n'est pas
  // lisible par le processus système qui dessine la vignette, et tout autre
  // schéma (\`javascript:\`…) n'a rien à faire dans une métadonnée.
  function httpUrl(candidate) {
    if (typeof candidate !== 'string' || candidate.length === 0) return '';
    if (candidate.length > MAX_ARTWORK_URL_LENGTH) return '';
    try {
      var resolved = new URL(candidate, location.href);
      if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') return '';
      if (resolved.href.length > MAX_ARTWORK_URL_LENGTH) return '';
      return resolved.href;
    } catch (error) {
      return '';
    }
  }

  function metaContent(selector) {
    try {
      var element = document.querySelector(selector);
      return element && typeof element.content === 'string' ? element.content : '';
    } catch (error) {
      return '';
    }
  }

  // Le poster de l'élément en cours est la jaquette du titre regardé : c'est la
  // source la plus juste. \`og:image\` prend le relais sur les lecteurs qui ne
  // posent pas de poster, et l'icône du site ferme la marche — mieux vaut le
  // logo Movix qu'une vignette vide.
  function resolveArtworkUrl(video) {
    var fromPoster = video ? httpUrl(video.poster) : '';
    if (fromPoster) return fromPoster;

    var fromOpenGraph = httpUrl(
      metaContent('meta[property="og:image"]') || metaContent('meta[name="og:image"]')
    );
    if (fromOpenGraph) return fromOpenGraph;

    try {
      var icon = document.querySelector('link[rel="apple-touch-icon"], link[rel~="icon"]');
      var fromIcon = icon ? httpUrl(icon.getAttribute('href')) : '';
      if (fromIcon) return fromIcon;
    } catch (error) {}

    return '';
  }

  function resolveTitle() {
    var fromOpenGraph = metaContent('meta[property="og:title"]');
    var candidate = typeof fromOpenGraph === 'string' ? fromOpenGraph.trim() : '';
    if (!candidate) candidate = (document.title || '').trim();
    // Le titre du document porte la marque en suffixe : la répéter sous la
    // jaquette n'apprend rien, \`artist\` la porte déjà.
    candidate = candidate.replace(/\\s*[-|\\u2013\\u2014]\\s*Movix\\s*$/i, '').trim();
    if (candidate.length > MAX_TITLE_LENGTH) {
      candidate = candidate.slice(0, MAX_TITLE_LENGTH);
    }
    return candidate || 'Movix';
  }

  function updateMetadata(video) {
    try {
      var artworkUrl = resolveArtworkUrl(video);
      session.metadata = new MediaMetadata({
        title: resolveTitle(),
        artist: 'Movix',
        // Une seule entrée, sans \`type\` : la taille annoncée n'est qu'un
        // indice de sélection, et déclarer trois fois la même URL sous des
        // tailles inventées ne ferait que mentir au sélecteur.
        artwork: artworkUrl ? [{ src: artworkUrl, sizes: '512x512' }] : [],
      });
    } catch (error) {}
  }

  // --- Position ------------------------------------------------------------

  // Pas de minuterie : la position est publiée avec le débit de lecture, et le
  // système extrapole la barre de progression entre deux publications. Un
  // rafraîchissement à la seconde ne gagnerait rien et réveillerait la page.
  function updatePositionState(video) {
    if (!video || video !== activeVideo) return;
    try {
      var duration = video.duration;
      if (typeof duration !== 'number' || !isFinite(duration) || duration <= 0) {
        session.setPositionState();
        return;
      }
      var position = video.currentTime;
      if (typeof position !== 'number' || !isFinite(position) || position < 0) position = 0;
      if (position > duration) position = duration;
      var playbackRate = video.playbackRate;
      if (typeof playbackRate !== 'number' || !isFinite(playbackRate) || playbackRate <= 0) {
        playbackRate = 1;
      }
      session.setPositionState({
        duration: duration,
        position: position,
        playbackRate: playbackRate,
      });
    } catch (error) {}
  }

  function setPlaybackState(state) {
    try { session.playbackState = state; } catch (error) {}
  }

  // --- Commandes système ---------------------------------------------------

  function setActionHandler(action, handler) {
    // Une action non supportée lève \`TypeError\` au lieu d'être ignorée : sans
    // ce filet, la première absente empêcherait d'installer les suivantes.
    try { session.setActionHandler(action, handler); } catch (error) {}
  }

  function seekBy(offsetSec) {
    if (!activeVideo) return;
    var duration = activeVideo.duration;
    var upperBound = typeof duration === 'number' && isFinite(duration) && duration > 0
      ? duration
      : Infinity;
    var target = activeVideo.currentTime + offsetSec;
    if (!isFinite(target)) return;
    try {
      activeVideo.currentTime = Math.min(upperBound, Math.max(0, target));
    } catch (error) {}
  }

  function installActionHandlers() {
    setActionHandler('play', function() {
      if (!activeVideo) return;
      try {
        var started = activeVideo.play();
        if (started && typeof started.catch === 'function') started.catch(function() {});
      } catch (error) {}
    });

    setActionHandler('pause', function() {
      if (!activeVideo) return;
      try { activeVideo.pause(); } catch (error) {}
    });

    setActionHandler('stop', function() {
      if (!activeVideo) return;
      try { activeVideo.pause(); } catch (error) {}
    });

    setActionHandler('seekbackward', function(details) {
      var offset = details && typeof details.seekOffset === 'number' && isFinite(details.seekOffset)
        ? Math.abs(details.seekOffset)
        : DEFAULT_SEEK_OFFSET_SEC;
      seekBy(-offset);
    });

    setActionHandler('seekforward', function(details) {
      var offset = details && typeof details.seekOffset === 'number' && isFinite(details.seekOffset)
        ? Math.abs(details.seekOffset)
        : DEFAULT_SEEK_OFFSET_SEC;
      seekBy(offset);
    });

    setActionHandler('seekto', function(details) {
      if (!activeVideo) return;
      if (!details || typeof details.seekTime !== 'number' || !isFinite(details.seekTime)) return;
      var duration = activeVideo.duration;
      var upperBound = typeof duration === 'number' && isFinite(duration) && duration > 0
        ? duration
        : Infinity;
      var target = Math.min(upperBound, Math.max(0, details.seekTime));
      try {
        if (details.fastSeek === true && typeof activeVideo.fastSeek === 'function') {
          activeVideo.fastSeek(target);
        } else {
          activeVideo.currentTime = target;
        }
      } catch (error) {}
    });
  }

  // --- Suivi de l'élément actif -------------------------------------------

  function adoptVideo(video) {
    activeVideo = video;
    updateMetadata(video);
    updatePositionState(video);
    setPlaybackState('playing');
  }

  function releaseVideo(video) {
    if (video !== activeVideo) return;
    activeVideo = null;
    setPlaybackState('none');
    try { session.setPositionState(); } catch (error) {}
  }

  document.addEventListener('play', function(event) {
    var target = event.target;
    if (target instanceof HTMLVideoElement) adoptVideo(target);
  }, true);

  document.addEventListener('pause', function(event) {
    var target = event.target;
    if (!(target instanceof HTMLVideoElement) || target !== activeVideo) return;
    setPlaybackState('paused');
    updatePositionState(target);
  }, true);

  document.addEventListener('ended', function(event) {
    var target = event.target;
    if (target instanceof HTMLVideoElement) releaseVideo(target);
  }, true);

  // \`loadedmetadata\` porte la durée définitive, \`durationchange\` la corrige sur
  // un flux dont le manifeste s'allonge, et le poster du lecteur n'est souvent
  // posé qu'une fois la source résolue : les métadonnées sont donc republiées.
  document.addEventListener('loadedmetadata', function(event) {
    var target = event.target;
    if (!(target instanceof HTMLVideoElement) || target !== activeVideo) return;
    updateMetadata(target);
    updatePositionState(target);
  }, true);

  // Seules les discontinuités sont republiées. \`timeupdate\` n'y figure pas :
  // il se déclenche plusieurs fois par seconde pour une information que le
  // système sait déjà extrapoler depuis la position et le débit.
  ['durationchange', 'seeked', 'ratechange'].forEach(function(type) {
    document.addEventListener(type, function(event) {
      var target = event.target;
      if (target instanceof HTMLVideoElement) updatePositionState(target);
    }, true);
  });

  installActionHandlers();
})();
true;
`;
}
