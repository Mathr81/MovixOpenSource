import React, { useState, useCallback, useEffect } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { Play, ShieldAlert, Settings, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAdFreePopup } from "../context/AdFreePopupContext";

interface AdFreePlayerAdsProps {
  onClose?: () => void;
  onAccept?: () => void;
  adType?: "ad1" | "ad2";
  onAdClick?: () => void;
  variant?: "player" | "download" | "livetv";
}

const AdFreePlayerAds: React.FC<AdFreePlayerAdsProps> = ({
  onClose,
  onAccept,
  adType: propAdType,
  onAdClick,
  variant = "player",
}) => {
  const { t } = useTranslation();
  const {
    showAdFreePopup,
    adType: contextAdType,
    isVoVostfrOnly,
    handlePopupAccept,
  } = useAdFreePopup();

  const finalAdType = propAdType || contextAdType;
  const finalOnAccept = onAccept || handlePopupAccept;
  const shouldShow = !!onClose || showAdFreePopup;

  const [hasClicked, setHasClicked] = useState(false);
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    if (!shouldShow) return;

    const lenis = (
      window as Window & { lenis?: { stop: () => void; start: () => void } }
    ).lenis;
    if (lenis) lenis.stop();

    return () => {
      if (lenis) lenis.start();
    };
  }, [shouldShow]);

  // Construire le lien à l'exécution pour éviter le filtrage réseau (Brave Shields / EasyList)
  const targetLink =
    "https://yawncollaremotion.com/av38fgu9i6?key=77d634ec911d95219d57b78717969034";

  const handleLinkClick = () => {
    const a = document.createElement("a");
    a.href = targetLink;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setHasClicked(true);
    if (onAdClick) onAdClick();
  };

  // Fermeture avec animation de sortie avant de notifier le parent
  const handleClose = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      finalOnAccept();
    }, 300);
  }, [finalOnAccept]);

  // Texte contextualisé
  const headerText = hasClicked
    ? variant === "download"
      ? t("adBlocker.thanksUnlockedDownload")
      : variant === "livetv"
        ? t("adBlocker.thanksUnlockedAccess")
        : t("adBlocker.thanksForHelp")
    : variant === "download"
      ? t("adBlocker.stepBeforeDownload")
      : variant === "livetv"
        ? t("adBlocker.accessLiveTV")
        : t("adBlocker.stepBeforeVideo");

  const descriptionText = hasClicked
    ? variant === "download"
      ? t("adBlocker.thanksDownloadDesc")
      : variant === "livetv"
        ? t("adBlocker.thanksLiveTVDesc")
        : t("adBlocker.thanksPlayerDesc")
    : variant === "download"
      ? t("adBlocker.stepDownloadDesc")
      : variant === "livetv"
        ? t("adBlocker.stepLiveTVDesc")
        : isVoVostfrOnly
          ? t("adBlocker.stepVoVostfrDesc")
          : t("adBlocker.stepPlayerDesc");

  const primaryButtonLabel = hasClicked
    ? variant === "download"
      ? t("adBlocker.decodeLink")
      : variant === "livetv"
        ? t("adBlocker.accessChannel")
        : t("adBlocker.playback")
    : variant === "download"
      ? t("adBlocker.viewAdSpace")
      : t("adBlocker.viewAd");

  if (!shouldShow) return null;

  return (
    <DialogPrimitive.Root
      open={!isClosing}
      onOpenChange={(open) => {
        if (!open && hasClicked) {
          handleClose();
        }
      }}
    >
      <DialogPrimitive.Portal>
        {/* Overlay avec fond bleu */}
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-300"
          style={{ background: "rgba(59,130,246,0.22)" }}
          onClick={(e) => {
            if (e.target === e.currentTarget && hasClicked) {
              handleClose();
            }
          }}
        />

        {/* Contenu du dialog */}
        <DialogPrimitive.Content
          onPointerDownOutside={(e) => {
            if (!hasClicked) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (!hasClicked) e.preventDefault();
          }}
          data-lenis-prevent
          className="fixed left-[50%] top-[50%] z-50 w-full max-w-[480px] translate-x-[-50%] translate-y-[-50%] rounded-2xl p-4 sm:p-6 max-h-[90vh] overflow-y-auto data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] duration-300"
          style={{
            background: "#181f2e",
            border: "1px solid rgba(255,255,255,0.08)",
            pointerEvents: "auto",
            overscrollBehavior: "contain",
            WebkitOverflowScrolling: "touch",
          }}
        >
          {/* Bouton fermer (visible uniquement après le clic) */}
          {hasClicked && (
            <DialogPrimitive.Close
              onClick={handleClose}
              className="absolute right-4 top-4 rounded-full p-1.5 text-white/50 transition-all duration-200 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            >
              <X className="h-4 w-4" />
              <span className="sr-only">{t("common.close")}</span>
            </DialogPrimitive.Close>
          )}

          {/* Header avec icône */}
          <div className="flex flex-col items-center justify-center pt-4 sm:pt-8 pb-2 px-4 sm:px-8">
            <ShieldAlert
              className="w-10 h-10 text-blue-400 mb-2"
              aria-hidden="true"
            />
            <DialogPrimitive.Title className="text-lg sm:text-xl font-bold leading-tight tracking-tight flex items-center gap-2 text-center mb-1 text-white">
              {headerText}
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="text-xs sm:text-sm text-blue-100/80 font-medium text-center leading-relaxed">
              {descriptionText}
            </DialogPrimitive.Description>
          </div>

          {/* Encadré avertissement */}
          {!hasClicked && (
            <div className="mx-4 sm:mx-6 mb-2">
              <div className="text-left bg-yellow-50 border-2 border-yellow-500 p-4 rounded-lg text-type-text font-bold flex flex-col gap-2 shadow-lg">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-2xl">⚠️</span>
                  <span className="uppercase text-yellow-700 font-extrabold tracking-wider text-sm sm:text-base">
                    {t("adBlocker.doNotDo")}
                  </span>
                </div>
                <ul className="list-disc pl-6 text-yellow-900 text-sm sm:text-base font-bold space-y-1">
                  <li>❌ {t("adBlocker.doNotClickAnywhere")}</li>
                  <li>❌ {t("adBlocker.doNotScanQr")}</li>
                  <li>❌ {t("adBlocker.doNotDownloadAnything")}</li>
                </ul>
              </div>
            </div>
          )}

          {/* Info aide lecteurs - apparaît après avoir cliqué */}
          {hasClicked && variant !== "download" && variant !== "livetv" && (
            <div className="mx-4 sm:mx-6 mb-2">
              <div className="text-left bg-blue-900/30 border border-blue-500/50 p-4 rounded-lg text-blue-100 flex flex-col gap-2">
                <div className="flex items-center gap-2 mb-1">
                  <Settings className="w-5 h-5 text-blue-400" />
                  <span className="font-bold text-blue-200">
                    {t("adBlocker.hlsTips")}
                  </span>
                </div>
                <ul className="pl-6 space-y-2 text-sm">
                  <li className="flex flex-col">
                    <span className="font-semibold text-blue-200">
                      {t("adBlocker.hlsPlayersTitle")}
                    </span>
                    <span>{t("adBlocker.hlsTip1")}</span>
                    <span>{t("adBlocker.hlsTip2")}</span>
                    <span>{t("adBlocker.hlsTip3")}</span>
                  </li>
                  <li className="flex flex-col">
                    <span className="font-semibold text-blue-200">
                      {t("adBlocker.classicPlayersTitle")}
                    </span>
                    <span>{t("adBlocker.classicTip1")}</span>
                    <span>{t("adBlocker.classicTip2")}</span>
                  </li>
                </ul>
              </div>
            </div>
          )}

          {/* Boutons */}
          <div className="flex flex-col items-center gap-2 px-4 sm:px-8 pb-4 sm:pb-8 pt-2">
            {variant === "player" && (
              <p className="text-xs text-blue-200 text-center mb-1">
                {t("adBlocker.withExtension")}
                <Link
                  to="/extension"
                  className="text-blue-400 hover:text-blue-300 underline font-semibold"
                >
                  {t("adBlocker.extensionLink")}
                </Link>
                {t("adBlocker.otherSourcesAccess")}
              </p>
            )}
            {hasClicked ? (
              <button
                onClick={handleClose}
                className="flex items-center justify-center font-bold whitespace-nowrap relative overflow-hidden transition-all duration-200 h-12 text-base px-6 rounded-lg bg-blue-600 text-white hover:bg-blue-700 hover:scale-105 active:scale-95 focus:ring-2 focus:ring-blue-400 focus:ring-offset-2 shadow-lg w-full max-w-xs cursor-pointer"
                autoFocus
              >
                <Play className="w-5 h-5 mr-2" /> {primaryButtonLabel}
              </button>
            ) : (
              <>
                <button
                  onClick={handleLinkClick}
                  className="flex items-center justify-center font-bold whitespace-nowrap relative overflow-hidden transition-all duration-200 h-12 text-base px-6 rounded-lg bg-blue-600 text-white hover:bg-blue-700 hover:scale-105 active:scale-95 focus:ring-2 focus:ring-blue-400 focus:ring-offset-2 shadow-lg w-full max-w-xs mb-1 cursor-pointer"
                  autoFocus
                >
                  {primaryButtonLabel}
                </button>
                <span className="text-xs text-blue-200 text-center mt-1">
                  {t("adBlocker.closeAdTip")}
                </span>
              </>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
};

export default AdFreePlayerAds;
