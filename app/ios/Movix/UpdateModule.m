#import "UpdateModule.h"

@implementation UpdateModule

RCT_EXPORT_MODULE()

RCT_EXPORT_METHOD(getVersionName:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  NSString *version = [NSBundle mainBundle].infoDictionary[@"CFBundleShortVersionString"];
  resolve(version ?: @"unknown");
}

RCT_EXPORT_METHOD(getVersionCode:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  NSString *build = [NSBundle mainBundle].infoDictionary[@"CFBundleVersion"];
  resolve(@([build integerValue]));
}

@end
