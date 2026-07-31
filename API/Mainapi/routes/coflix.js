/**
 * Coflix helper module.
 * Extracted from server.js -- provides Coflix search and data extraction functions.
 *
 * This is NOT a router. It exports plain functions used by tmdb.js and others.
 */

const cheerio = require("cheerio");
const { Buffer } = require("buffer");

const { CACHE_DIR, generateCacheKey } = require("../utils/cacheManager");

// ---- Lazy-bound dependencies injected via configure() ----
let deps = {
  axiosCoflixRequest: async () => {
    throw new Error("coflix not configured");
  },
  axiosLecteurVideoRequest: async () => {
    throw new Error("coflix not configured");
  },
  makeCoflixRequest: async () => {
    throw new Error("coflix not configured");
  },
  coflixHeaders: {},
  getFromCacheNoExpiration: async () => null,
  saveToCache: async () => false,
  formatCoflixError: (error) =>
    error && error.message ? error.message : String(error),
};

function configure(injected) {
  Object.assign(deps, injected);
}

// ---- Functions ----

// Fonction pour normaliser les caracteres speciaux pour les requetes Coflix
function normalizeCoflixQuery(query) {
  if (!query) return query;

  const replacements = {
    "\u00e0": "a",
    "\u00e1": "a",
    "\u00e2": "a",
    "\u00e3": "a",
    "\u00e4": "a",
    "\u00e5": "a",
    "\u00e8": "e",
    "\u00e9": "e",
    "\u00ea": "e",
    "\u00eb": "e",
    "\u00ec": "i",
    "\u00ed": "i",
    "\u00ee": "i",
    "\u00ef": "i",
    "\u00f2": "o",
    "\u00f3": "o",
    "\u00f4": "o",
    "\u00f5": "o",
    "\u00f6": "o",
    "\u00f9": "u",
    "\u00fa": "u",
    "\u00fb": "u",
    "\u00fc": "u",
    "\u00fd": "y",
    "\u00ff": "y",
    "\u00f1": "n",
    "\u00e7": "c",
    "\u0153": "oe",
    "\u00e6": "ae",
    "\u00c0": "A",
    "\u00c1": "A",
    "\u00c2": "A",
    "\u00c3": "A",
    "\u00c4": "A",
    "\u00c5": "A",
    "\u00c8": "E",
    "\u00c9": "E",
    "\u00ca": "E",
    "\u00cb": "E",
    "\u00cc": "I",
    "\u00cd": "I",
    "\u00ce": "I",
    "\u00cf": "I",
    "\u00d2": "O",
    "\u00d3": "O",
    "\u00d4": "O",
    "\u00d5": "O",
    "\u00d6": "O",
    "\u00d9": "U",
    "\u00da": "U",
    "\u00db": "U",
    "\u00dc": "U",
    "\u00dd": "Y",
    "\u0178": "Y",
    "\u00d1": "N",
    "\u00c7": "C",
    "\u0152": "OE",
    "\u00c6": "AE",
  };

  let normalized = query;
  for (const [special, normal] of Object.entries(replacements)) {
    normalized = normalized.split(special).join(normal);
  }

  return normalized;
}

// Fonction pour rechercher un contenu sur Coflix par titre
async function searchCoflixByTitle(title, mediaType, releaseYear) {
  try {
    const normalizedTitle = normalizeCoflixQuery(title);

    const response = await deps.axiosCoflixRequest({
      method: "get",
      url: `/suggest.php?query=${encodeURIComponent(normalizedTitle)}`,
    });

    if (!Array.isArray(response.data)) {
      console.error(
        `La reponse de l'API Coflix n'est pas un tableau: ${deps.formatCoflixError(response.data)}`,
      );
      return [];
    }

    const results = response.data.map((item) => {
      const similarity = calculateTitleSimilarity(title, item.title);
      const resultYear = item.year ? parseInt(item.year) : null;

      return {
        title: item.title,
        url: item.url,
        similarity: similarity,
        year: resultYear,
        id: item.ID,
        excerpt: item.excerpt,
        post_type: item.post_type,
        rating: item.rating,
      };
    });

    let coflixTypes = [];

    if (mediaType === "movie") {
      coflixTypes = ["movies"];
    } else if (mediaType === "tv") {
      coflixTypes = ["series", "animes", "doramas"];
    } else if (mediaType === "anime") {
      coflixTypes = ["animes"];
    } else {
      coflixTypes = ["movies", "series", "animes", "doramas"];
    }

    let filteredResults = mediaType
      ? results.filter((item) => coflixTypes.includes(item.post_type))
      : results;

    filteredResults.sort((a, b) => b.similarity - a.similarity);

    if (releaseYear) {
      const yearMatchedResults = filteredResults.filter(
        (r) => r.year === releaseYear,
      );

      if (mediaType === "movie") {
        if (
          yearMatchedResults.length > 0 &&
          yearMatchedResults[0].similarity >= 0.8
        ) {
          filteredResults = [yearMatchedResults[0]];
        } else {
          filteredResults = [];
        }
      } else if (mediaType === "tv") {
        if (
          yearMatchedResults.length > 0 &&
          yearMatchedResults[0].similarity >= 0.7
        ) {
          filteredResults = [yearMatchedResults[0]];
        } else {
          filteredResults = [];
        }
      } else {
        if (
          yearMatchedResults.length > 0 &&
          yearMatchedResults[0].similarity >= 0.8
        ) {
          filteredResults = [yearMatchedResults[0]];
        } else {
          filteredResults = [];
        }
      }
    } else {
      if (filteredResults.length > 0 && filteredResults[0].similarity > 0.8) {
        filteredResults = [filteredResults[0]];
      } else {
        filteredResults = [];
      }
    }

    return filteredResults;
  } catch (error) {
    // Global coflix.band 429 is announced once by makeCoflixRequest's cooldown — don't spam per title.
    if (!error?.coflixSiteRateLimited) {
      console.error(
        `Erreur lors de la recherche sur Coflix pour ${title}: ${deps.formatCoflixError(error)}`,
      );
    }
    throw error;
  }
}

// Fonction utilitaire pour calculer la similarite entre deux titres
function calculateTitleSimilarity(title1, title2) {
  if (!title1 || !title2) return 0;

  const t1 = title1.toLowerCase();
  const t2 = title2.toLowerCase();

  const normalize = (str) =>
    str
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[\u00ae\u2122\u00a9]/g, "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  const norm1 = normalize(t1);
  const norm2 = normalize(t2);

  if (norm1 === norm2) {
    return 1.0;
  }

  const extractNumbers = (str) => {
    const numbers = str.match(/\b\d+\b/g);
    return numbers ? numbers.map((n) => parseInt(n)) : [];
  };

  const numbers1 = extractNumbers(norm1);
  const numbers2 = extractNumbers(norm2);

  if (numbers1.length > 0 || numbers2.length > 0) {
    const hasCommonNumbers =
      numbers1.length > 0 &&
      numbers2.length > 0 &&
      numbers1.some((n1) => numbers2.some((n2) => n1 === n2));

    if (!hasCommonNumbers) {
      return 0.2;
    }
  }

  const extractSubtitles = (str) => {
    const parts = str.split(/[:|]/);
    return parts.length > 1 ? parts[1].trim() : "";
  };

  const subtitle1 = extractSubtitles(norm1);
  const subtitle2 = extractSubtitles(norm2);

  if (subtitle1 && subtitle2 && subtitle1 !== subtitle2) {
    const subtitleWords1 = subtitle1.split(/\s+/).filter((w) => w.length > 2);
    const subtitleWords2 = subtitle2.split(/\s+/).filter((w) => w.length > 2);
    const commonSubtitleWords = subtitleWords1.filter((w1) =>
      subtitleWords2.some((w2) => w1.includes(w2) || w2.includes(w1)),
    );

    if (commonSubtitleWords.length === 0) {
      return 0.3;
    }
  }

  const locationKeywords = [
    "londres",
    "paris",
    "new york",
    "tokyo",
    "berlin",
    "rome",
    "madrid",
    "barcelone",
  ];
  const hasLocation1 = locationKeywords.some((keyword) =>
    norm1.includes(keyword),
  );
  const hasLocation2 = locationKeywords.some((keyword) =>
    norm2.includes(keyword),
  );

  if (hasLocation1 !== hasLocation2) {
    return 0.25;
  }

  // Short titles
  if (norm1.length <= 10 || norm2.length <= 10) {
    if (norm2.includes(norm1) || norm1.includes(norm2)) {
      const shorter = norm1.length <= norm2.length ? norm1 : norm2;
      const longer = norm1.length <= norm2.length ? norm2 : norm1;
      const lengthRatio = shorter.length / longer.length;

      if (lengthRatio >= 0.8) {
        return 0.85;
      } else if (lengthRatio >= 0.6) {
        return 0.7;
      } else if (lengthRatio >= 0.4) {
        return 0.5;
      }
      return 0.2;
    }
  }

  // Boost if searched title is a head token
  if (norm2.startsWith(norm1 + " ") || norm1.startsWith(norm2 + " ")) {
    return 0.9;
  }

  if (norm2.includes(norm1) || norm1.includes(norm2)) {
    if (norm1.length < norm2.length && norm2.includes(norm1)) {
      const lengthRatio = norm1.length / norm2.length;
      if (lengthRatio >= 0.6) {
        return 0.8 * lengthRatio;
      } else if (lengthRatio >= 0.4) {
        return 0.6 * lengthRatio;
      }
      return 0.3;
    } else if (norm2.length < norm1.length && norm1.includes(norm2)) {
      const lengthRatio = norm2.length / norm1.length;
      if (lengthRatio >= 0.6) {
        return 0.75 * lengthRatio;
      } else if (lengthRatio >= 0.4) {
        return 0.55 * lengthRatio;
      }
      return 0.3;
    }
    return 0.6;
  }

  const filterShortWords = (words) => words.filter((w) => w.length > 3);
  const words1 = filterShortWords(norm1.split(/\s+/));
  const words2 = filterShortWords(norm2.split(/\s+/));

  const finalWords1 = words1.length ? words1 : norm1.split(/\s+/);
  const finalWords2 = words2.length ? words2 : norm2.split(/\s+/);

  let matches = 0;
  let orderBonus = 0;

  finalWords1.forEach((word, index) => {
    const matchIndex = finalWords2.findIndex(
      (w) => w.includes(word) || word.includes(w),
    );
    if (matchIndex !== -1) {
      matches++;
      if (Math.abs(index - matchIndex) < 2) {
        orderBonus += 0.1;
      }
    }
  });

  const baseScore =
    matches / Math.max(finalWords1.length, finalWords2.length, 1);
  return Math.min(baseScore + orderBonus, 0.95);
}

// Fonction pour filtrer les lecteurs lecteur1.xtremestream.xyz des donnees
function filterEmmmmbedReaders(data) {
  if (!data) return data;

  function filterObject(obj) {
    if (Array.isArray(obj)) {
      return obj.map((item) => filterObject(item));
    } else if (obj && typeof obj === "object") {
      const filtered = {};
      for (const [key, value] of Object.entries(obj)) {
        if (key === "_coflixRefreshedAt") continue;
        if (key === "player_links" && Array.isArray(value)) {
          filtered[key] = value.filter(
            (link) =>
              !link.decoded_url ||
              !link.decoded_url.includes("lecteur1.xtremestream.xyz"),
          );
        } else {
          filtered[key] = filterObject(value);
        }
      }
      return filtered;
    }
    return obj;
  }

  return filterObject(data);
}

// Fonction pour extraire les donnees des films depuis Coflix
async function getMovieDataFromCoflix(url) {
  let cachedData = null;
  let hadCache = false;
  try {
    const cacheKey = generateCacheKey({ url: url, type: "movie" });

    cachedData = await deps.getFromCacheNoExpiration(
      CACHE_DIR.COFLIX,
      cacheKey,
    );
    hadCache = !!cachedData;
    if (cachedData) {
      // Ne pas utiliser le cache si player_links est vide — re-fetcher
      if (!cachedData.player_links || cachedData.player_links.length === 0) {
        console.log(
          `[COFLIX MOVIE] Cache ignoré (player_links vide) pour ${url} — re-fetch en cours`,
        );
      } else {
        return cachedData;
      }
    }

    const relativePath = url.replace(
      /^https?:\/\/(?:www\.)?coflix\.[^/]+/i,
      "",
    );
    const response = await deps.axiosCoflixRequest({
      method: "get",
      url: relativePath,
    });
    const $ = cheerio.load(response.data);

    let iframe = $(
      "main div div div article div:nth-child(2) div:nth-child(1) aside div div iframe",
    );
    if (!iframe.length) {
      iframe = $("article iframe");
    }
    if (!iframe.length) {
      iframe = $("iframe");
    }

    let iframeSrc = null;
    let playerLinks = [];

    if (iframe.length > 0) {
      iframeSrc = iframe.attr("src");

      if (iframeSrc) {
        try {
          const iframePageResponse = await deps.axiosLecteurVideoRequest({
            method: "get",
            url: iframeSrc,
          });
          const iframePage$ = cheerio.load(iframePageResponse.data);

          let playerItems = iframePage$('li[onclick*="showVideo"]');
          if (!playerItems.length) {
            playerItems = iframePage$("div li[onclick]");
          }

          if (playerItems.length === 0) {
            const bodyHtml = iframePage$("body").html() || "";
            console.warn(
              `[COFLIX MOVIE] ⚠️ Aucun playerItem — iframe: ${iframeSrc}, status: ${iframePageResponse.status}, taille: ${(iframePageResponse.data || "").length} chars, aperçu HTML: ${bodyHtml.substring(0, 500)}`,
            );
          }

          playerItems.each((i, element) => {
            try {
              const $element = iframePage$(element);
              const onClickAttr = $element.attr("onclick") || "";

              const base64Match = onClickAttr.match(
                /showVideo\(['"]([^'\"]+)['"]/,
              );

              if (base64Match && base64Match[1]) {
                const base64Url = base64Match[1];

                let decodedUrl;
                try {
                  decodedUrl = Buffer.from(base64Url, "base64").toString(
                    "utf-8",
                  );
                } catch (decodeError) {
                  decodedUrl = null;
                }

                const quality = $element.find("span").text().trim();

                let language = "Unknown";
                const info = $element.find("p").text().trim();
                if (info.toLowerCase().includes("french")) {
                  language = "French";
                } else if (info.toLowerCase().includes("english")) {
                  language = "English";
                } else if (info.toLowerCase().includes("vostfr")) {
                  language = "VOSTFR";
                }

                playerLinks.push({
                  decoded_url: decodedUrl,
                  quality: quality,
                  language: language,
                });
              }
            } catch (playerError) {
              const errorCode =
                playerError.response?.status || playerError.code || "unknown";
              console.error(
                `[COFLIX MOVIE] ❌ Erreur extraction player: ${errorCode}`,
              );
            }
          });
        } catch (iframePageError) {
          const errorCode =
            iframePageError.response?.status ||
            iframePageError.code ||
            "unknown";
          console.error(
            `[COFLIX MOVIE] ❌ Erreur requête iframe ${iframeSrc} — code: ${errorCode}, message: ${iframePageError.message}`,
          );
        }
      }
    } else {
      console.log(`Aucun iframe trouve pour l'URL ${url}`);
    }

    const result = {
      iframe_src: iframeSrc && !iframeSrc.includes("coflix") ? iframeSrc : null,
      player_links: playerLinks,
    };

    if (playerLinks.length > 0) {
      await deps.saveToCache(CACHE_DIR.COFLIX, cacheKey, result);
    }

    return result;
  } catch (error) {
    if (
      error &&
      (error.isAxiosError || (error.response && error.response.status))
    ) {
      console.error(
        `Erreur lors de la recuperation des donnees du film Coflix: ${deps.formatCoflixError(error)}`,
      );
      if (hadCache) {
        console.log(`[COFLIX] Cache preserve malgre l'erreur pour ${url}`);
        return cachedData;
      }
      throw error;
    }
    console.error(
      `Erreur lors de la recuperation des donnees du film Coflix: ${deps.formatCoflixError(error)}`,
    );
    if (hadCache) {
      console.log(`[COFLIX] Cache preserve malgre l'erreur pour ${url}`);
      return cachedData;
    }
    return { iframe_src: null, player_links: [] };
  }
}

// Nouvelle fonction pour recuperer les episodes via l'API Coflix
async function fetchCoflixSeriesEpisodes(postId, seasonNumber) {
  try {
    const response = await deps.axiosCoflixRequest({
      method: "get",
      url: `/wp-json/apiflix/v1/series/${postId}/${seasonNumber}`,
    });
    if (response.data && Array.isArray(response.data.episodes)) {
      return response.data;
    }
    return null;
  } catch (error) {
    console.error(
      `Erreur lors de la recuperation des episodes Coflix: ${deps.formatCoflixError(error)}`,
    );
    return null;
  }
}

// Fonction pour extraire les donnees des series depuis Coflix
async function getTvDataFromCoflix(url, seasonNumber, episodeNumber) {
  let cachedData = null;
  let hadCache = false;
  try {
    const cacheKey = generateCacheKey({
      url: url,
      season: seasonNumber,
      episode: episodeNumber,
      type: "tv",
    });

    cachedData = await deps.getFromCacheNoExpiration(
      CACHE_DIR.COFLIX,
      cacheKey,
    );
    hadCache = !!cachedData;
    if (cachedData) {
      return cachedData;
    }

    const relativePath = url.replace(
      /^https?:\/\/(?:www\.)?coflix\.[^/]+/i,
      "",
    );
    const response = await deps.axiosCoflixRequest({
      method: "get",
      url: relativePath,
    });
    const $ = cheerio.load(response.data);

    const seasonItems = $("article section div aside div ul li");

    if (!seasonItems.length) {
      console.log(`[ERROR] Aucune saison trouvee pour ${url}`);

      const altSelectors = [
        "ul li",
        ".seasons li",
        ".season-list li",
        "[data-season]",
        "input[data-season]",
      ];

      for (const selector of altSelectors) {
        const altItems = $(selector);
        if (altItems.length > 0) {
          // found items with alternative selector
        }
      }

      return {
        seasons: [],
        current_episode: null,
      };
    }

    const seasons = [];
    let targetSeason = null;
    let postId = null;

    for (let i = 0; i < seasonItems.length; i++) {
      const $seasonElement = $(seasonItems[i]);
      const $label = $seasonElement.find("label");
      const $input = $label.find("input");

      const sNumber = $input.attr("data-season");
      const seriesId = $input.attr("data-id");
      const currentPostId = $input.attr("post-id");
      const seasonName = $label.find("span").text().trim();

      const season = {
        season_number: parseInt(sNumber),
        name: seasonName,
        data_id: seriesId,
        post_id: currentPostId,
        episodes: [],
      };

      seasons.push(season);

      if (parseInt(sNumber) === seasonNumber) {
        targetSeason = season;
        postId = currentPostId;
      }
    }

    const slugMatch = url.match(/\/serie\/([^/]+)/);
    const animeMatch = url.match(/\/animes\/([^/]+)/);
    const seriesSlug = slugMatch
      ? slugMatch[1]
      : animeMatch
        ? animeMatch[1]
        : "";

    if (targetSeason && episodeNumber) {
      let episodeApiData = null;
      let episodeUrl = null;

      if (postId) {
        const apiData = await fetchCoflixSeriesEpisodes(postId, seasonNumber);
        if (apiData && apiData.episodes) {
          const episode = apiData.episodes.find(
            (ep) => parseInt(ep.number) === parseInt(episodeNumber),
          );
          if (episode && episode.links) {
            episodeUrl = episode.links.startsWith("https://coflix.trade")
              ? `${episode.links}`
              : episode.links;
          }
        }
      }

      if (!episodeUrl) {
        episodeUrl = `https://coflix.trade/episode/${seriesSlug}-${seasonNumber}x${episodeNumber}/`;
      }

      try {
        const episodePageResponse = await deps.makeCoflixRequest(episodeUrl, {
          headers: deps.coflixHeaders,
          timeout: 15000,
        });
        const episodePage$ = cheerio.load(episodePageResponse.data);

        const episodeTitle = episodePage$("article header h1").text().trim();
        const episodePlayerLinks = [];

        let episodeIframe = episodePage$("main div div div article div iframe");
        if (!episodeIframe.length) {
          episodeIframe = episodePage$("article iframe");
        }
        if (!episodeIframe.length) {
          episodeIframe = episodePage$("iframe");
        }

        let episodeIframeSrc = null;

        if (episodeIframe.length > 0) {
          episodeIframeSrc = episodeIframe.attr("src");

          if (episodeIframeSrc) {
            try {
              const iframePageResponse = await deps.axiosLecteurVideoRequest({
                method: "get",
                url: episodeIframeSrc,
              });
              const iframePage$ = cheerio.load(iframePageResponse.data);

              let playerItems = iframePage$('li[onclick*="showVideo"]');
              if (!playerItems.length) {
                playerItems = iframePage$("div li[onclick]");
              }

              if (playerItems.length === 0) {
                const bodyHtml = iframePage$("body").html() || "";
                console.warn(
                  `[COFLIX TV] ⚠️ Aucun playerItem — iframe: ${episodeIframeSrc}, status: ${iframePageResponse.status}, taille: ${(iframePageResponse.data || "").length} chars, aperçu HTML: ${bodyHtml.substring(0, 500)}`,
                );
              }

              playerItems.each((i, element) => {
                try {
                  const $element = iframePage$(element);
                  const onClickAttr = $element.attr("onclick") || "";

                  const base64Match = onClickAttr.match(
                    /showVideo\(['"]([^'\"]+)['"]/,
                  );

                  if (base64Match && base64Match[1]) {
                    const base64Url = base64Match[1];

                    let decodedUrl;
                    try {
                      decodedUrl = Buffer.from(base64Url, "base64").toString(
                        "utf-8",
                      );
                    } catch (decodeError) {
                      decodedUrl = null;
                    }

                    const quality = $element.find("span").text().trim();

                    let language = "Unknown";
                    const info = $element.find("p").text().trim();
                    if (info.toLowerCase().includes("french")) {
                      language = "French";
                    } else if (info.toLowerCase().includes("english")) {
                      language = "English";
                    } else if (info.toLowerCase().includes("vostfr")) {
                      language = "VOSTFR";
                    }

                    episodePlayerLinks.push({
                      decoded_url: decodedUrl,
                      quality: quality,
                      language: language,
                    });
                  }
                } catch (playerError) {
                  const errorCode =
                    playerError.response?.status ||
                    playerError.code ||
                    "unknown";
                  console.error(
                    `[COFLIX TV] ❌ Erreur extraction player: ${errorCode}`,
                  );
                }
              });
            } catch (iframePageError) {
              const errorCode =
                iframePageError.response?.status ||
                iframePageError.code ||
                "unknown";
              console.error(
                `[COFLIX TV] ❌ Erreur requête iframe ${episodeIframeSrc} — code: ${errorCode}, message: ${iframePageError.message}`,
              );
            }
          }
        }

        return {
          seasons: seasons,
          current_episode: {
            season_number: seasonNumber,
            episode_number: episodeNumber,
            title: episodeTitle,
            iframe_src:
              episodeIframeSrc && !episodeIframeSrc.includes("coflix")
                ? episodeIframeSrc
                : null,
            player_links: episodePlayerLinks,
          },
        };
      } catch (episodeError) {
        console.error(
          `Erreur lors de la recuperation des donnees de l'episode: ${deps.formatCoflixError(episodeError)}`,
        );
        return {
          seasons: seasons,
          current_episode: null,
        };
      }
    }

    const result = {
      seasons: seasons,
      current_episode: null,
    };

    if (seasons.length > 0) {
      await deps.saveToCache(CACHE_DIR.COFLIX, cacheKey, result);
    }

    return result;
  } catch (error) {
    if (
      error &&
      (error.isAxiosError || (error.response && error.response.status))
    ) {
      console.error(
        `Erreur lors de la recuperation des donnees de la serie Coflix: ${deps.formatCoflixError(error)}`,
      );
      if (hadCache) {
        console.log(`[COFLIX] Cache preserve malgre l'erreur pour ${url}`);
        return cachedData;
      }
      throw error;
    }
    console.error(
      `Erreur lors de la recuperation des donnees de la serie Coflix: ${deps.formatCoflixError(error)}`,
    );
    if (hadCache) {
      console.log(`[COFLIX] Cache preserve malgre l'erreur pour ${url}`);
      return cachedData;
    }
    return { seasons: [], current_episode: null };
  }
}

module.exports = {
  configure,
  normalizeCoflixQuery,
  searchCoflixByTitle,
  calculateTitleSimilarity,
  filterEmmmmbedReaders,
  getMovieDataFromCoflix,
  fetchCoflixSeriesEpisodes,
  getTvDataFromCoflix,
};
