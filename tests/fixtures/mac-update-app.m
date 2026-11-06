#import <Cocoa/Cocoa.h>
#include <unistd.h>
@interface FixtureDelegate : NSObject <NSApplicationDelegate>
@property(copy) NSString *job;
@property(copy) NSString *token;
@property BOOL rollback;
@end
@implementation FixtureDelegate
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  NSString *pid=[NSString stringWithFormat:@"%@\n%d\n",self.token,getpid()];
  NSString *name=self.rollback?@"old-restarted":@"launched";
  [pid writeToFile:[self.job stringByAppendingPathComponent:name] atomically:YES encoding:NSUTF8StringEncoding error:nil];
  if(self.rollback)return;
  NSString *mode=[NSString stringWithContentsOfFile:[[NSBundle mainBundle] pathForResource:@"mode" ofType:@"txt"] encoding:NSUTF8StringEncoding error:nil];
  if([mode isEqualToString:@"fail"]){[self.token writeToFile:[self.job stringByAppendingPathComponent:@"failed"] atomically:YES encoding:NSUTF8StringEncoding error:nil];exit(1);}
  if([mode isEqualToString:@"hang"])return;
  [self.token writeToFile:[self.job stringByAppendingPathComponent:@"ready"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
}
@end
int main(int argc,char **argv){@autoreleasepool{
  if(argc!=4)return 2;
  FixtureDelegate *delegate=[FixtureDelegate new];delegate.job=@(argv[2]);delegate.token=@(argv[3]);delegate.rollback=strcmp(argv[1],"--model-bridge-update-rollback")==0;
  NSApplication *app=[NSApplication sharedApplication];[app setActivationPolicy:NSApplicationActivationPolicyProhibited];app.delegate=delegate;[app run];
}return 0;}
