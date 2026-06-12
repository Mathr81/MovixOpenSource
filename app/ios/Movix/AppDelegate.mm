#import "AppDelegate.h"
#import <React/RCTBundleURLProvider.h>
#import <AVFoundation/AVFoundation.h>
#import <WebKit/WebKit.h>

#if __has_include(<GoogleCast/GoogleCast.h>)
#import <GoogleCast/GoogleCast.h>
#define MOVIX_CAST_AVAILABLE 1
#endif

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  self.moduleName = @"Movix";
  self.initialProps = @{};

  // Session audio "playback" : indispensable pour que la lecture (son) et le
  // Picture-in-Picture continuent quand l'app passe en arrière-plan ou que
  // l'écran se verrouille. Sans ça, WKWebView coupe la vidéo dès le background.
  AVAudioSession *audioSession = [AVAudioSession sharedInstance];
  [audioSession setCategory:AVAudioSessionCategoryPlayback
                       mode:AVAudioSessionModeMoviePlayback
                    options:0
                      error:nil];
  [audioSession setActive:YES error:nil];

#ifdef MOVIX_CAST_AVAILABLE
  // Initialise le contexte Google Cast. L'App ID DEFAULT_MEDIA_RECEIVER_APP_ID
  // pointe vers le récepteur générique (pas de compte Cast Console requis).
  GCKDiscoveryCriteria *criteria = [[GCKDiscoveryCriteria alloc]
      initWithApplicationID:kGCKDefaultMediaReceiverApplicationID];
  GCKCastOptions *castOptions = [[GCKCastOptions alloc] initWithDiscoveryCriteria:criteria];
  castOptions.physicalVolumeButtonsWillControlDeviceVolume = YES;
  [GCKCastContext setSharedInstanceWithOptions:castOptions];
#endif

  return [super application:application didFinishLaunchingWithOptions:launchOptions];
}

// Traverse the view hierarchy to locate the WKWebView instance.
- (WKWebView *)findWKWebViewIn:(UIView *)view {
  if ([view isKindOfClass:[WKWebView class]]) return (WKWebView *)view;
  for (UIView *sub in view.subviews) {
    WKWebView *found = [self findWKWebViewIn:sub];
    if (found) return found;
  }
  return nil;
}

// Called BEFORE JS context is suspended — the only reliable window to call
// webkitSetPresentationMode('picture-in-picture') synchronously for MSE/HLS.js.
// This fires earlier and more reliably than AppState 'inactive' via the RN bridge.
- (void)applicationWillResignActive:(UIApplication *)application {
  [super applicationWillResignActive:application];

  // isViewLoaded avoids forcing viewDidLoad on an uninitialised VC.
  // This guards against the Cast SDK triggering a local-network permission
  // dialog at startup before React Native has finished setting up.
  if (!self.window.rootViewController.isViewLoaded) return;
  UIView *root = self.window.rootViewController.view;
  WKWebView *webView = [self findWKWebViewIn:root];
  if (!webView) return;

  // Only inject if a page is already loaded (avoids calling into an
  // uninitialised WKWebView during startup permission dialogs).
  if (webView.URL == nil) return;

  NSString *script = @"(function(){"
    "try{"
    "var v=window.__movixActiveVideo;"
    "if(!v||v.paused)return;"
    "if(document.pictureInPictureElement)return;"
    "if(typeof v.webkitSetPresentationMode==='function'){"
    "v.webkitSetPresentationMode('picture-in-picture');"
    "}else if(document.pictureInPictureEnabled&&typeof v.requestPictureInPicture==='function'){"
    "v.requestPictureInPicture().catch(function(){});"
    "}"
    "}catch(e){}"
    "})();true;";

  [webView evaluateJavaScript:script completionHandler:^(id result, NSError *error) {}];
}

// Toggling userInteractionEnabled resets WKWebView gesture recognizers that
// get stuck after notification center is dragged over the app during playback.
// Skip on initial launch — only run on true background resumes.
static BOOL _gestureResetSkipFirstActivation = YES;
- (void)applicationDidBecomeActive:(UIApplication *)application {
  [super applicationDidBecomeActive:application];

  if (_gestureResetSkipFirstActivation) {
    _gestureResetSkipFirstActivation = NO;
    return;
  }

  if (!self.window.rootViewController.isViewLoaded) return;
  UIView *root = self.window.rootViewController.view;
  if (!root) return;
  root.userInteractionEnabled = NO;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(50 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
    root.userInteractionEnabled = YES;
  });
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

@end
