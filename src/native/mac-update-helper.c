// Runs outside the application bundle so it survives replacement of that bundle.
// No elevation, shell evaluation, or changes to quarantine/security settings.
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <signal.h>
#include <limits.h>
#include <dirent.h>
#include <time.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <libproc.h>

static char job[PATH_MAX];
static const char *token;
static void pause_tick(void) { struct timespec ts = {0, 100000000}; nanosleep(&ts, NULL); }
static int marker(const char *name, const char *body) {
  char file[PATH_MAX], temp[PATH_MAX];
  if (snprintf(file,sizeof(file),"%s/%s",job,name)>=(int)sizeof(file) || snprintf(temp,sizeof(temp),"%s/.%s.tmp",job,name)>=(int)sizeof(temp)) return -1;
  int fd=open(temp,O_WRONLY|O_CREAT|O_TRUNC|O_NOFOLLOW,0600); if(fd<0)return -1;
  size_t length=strlen(body); ssize_t wrote=write(fd,body,length); int synced=fsync(fd); close(fd);
  if(wrote!=(ssize_t)length || synced<0)return -1;
  return rename(temp,file);
}
static void state(const char *phase, const char *reason) {
  char json[256]; snprintf(json,sizeof(json),"{\"phase\":\"%s\",\"reason\":\"%s\"}\n",phase,reason); marker("state.json",json);
}
static int token_marker(const char *name) {
  char file[PATH_MAX],value[256]; snprintf(file,sizeof(file),"%s/%s",job,name);
  int fd=open(file,O_RDONLY|O_NOFOLLOW);if(fd<0)return 0;ssize_t n=read(fd,value,sizeof(value)-1);close(fd);
  if(n<0)return 0;value[n]=0;return strcmp(value,token)==0;
}
static pid_t launched_pid(void) {
  char file[PATH_MAX],value[256];snprintf(file,sizeof(file),"%s/launched",job);
  int fd=open(file,O_RDONLY|O_NOFOLLOW);if(fd<0)return 0;ssize_t n=read(fd,value,sizeof(value)-1);close(fd);
  if(n<0)return 0;value[n]=0;size_t length=strlen(token);
  if(strncmp(value,token,length)!=0 || value[length]!='\n')return 0;
  char *end;long pid=strtol(value+length+1,&end,10);return pid>1 && (*end=='\n'||*end==0)?(pid_t)pid:0;
}
static int alive(pid_t pid) { return pid>1 && (kill(pid,0)==0 || errno==EPERM); }
static int app_process(pid_t pid, const char *target, const char *executable) {
  char process[PROC_PIDPATHINFO_MAXSIZE],expected[PATH_MAX];
  if(proc_pidpath(pid,process,sizeof(process))<=0)return 0;
  snprintf(expected,sizeof(expected),"%s/Contents/MacOS/%s",target,executable);
  return strcmp(process,expected)==0;
}
static int launch(const char *target, const char *flag) {
  pid_t child=fork();if(child<0)return -1;
  if(child==0){execl("/usr/bin/open","open","-n",target,"--args",flag,job,token,(char*)NULL);_exit(127);}
  int status;while(waitpid(child,&status,0)<0){if(errno!=EINTR)return -1;}
  return WIFEXITED(status)&&WEXITSTATUS(status)==0?0:-1;
}
static int remove_tree(const char *root) {
  struct stat info;if(lstat(root,&info)<0)return errno==ENOENT?0:-1;
  if(!S_ISDIR(info.st_mode))return unlink(root);
  DIR *dir=opendir(root);if(!dir)return -1;struct dirent *entry;int failed=0;
  while((entry=readdir(dir))){if(!strcmp(entry->d_name,".")||!strcmp(entry->d_name,".."))continue;
    char child[PATH_MAX];if(snprintf(child,sizeof(child),"%s/%s",root,entry->d_name)>=(int)sizeof(child) || remove_tree(child)<0)failed=1;}
  closedir(dir);return failed?-1:rmdir(root);
}
static int swap(const char *a,const char *b) {
  struct stat first,second;if(lstat(a,&first)||lstat(b,&second)||!S_ISDIR(first.st_mode)||!S_ISDIR(second.st_mode)||first.st_dev!=second.st_dev){errno=EINVAL;return -1;}
  return renamex_np(a,b,RENAME_SWAP);
}
static int remove_backup(const char *incoming) {
  if(remove_tree(incoming)<0)return -1;
  char parent[PATH_MAX];if(strlen(incoming)>=sizeof(parent))return -1;strcpy(parent,incoming);
  char *slash=strrchr(parent,'/');if(!slash)return -1;*slash=0;
  return rmdir(parent);
}
int main(int argc,char **argv) {
  if(getuid()!=geteuid()||getuid()==0){fprintf(stderr,"Updater must run as the application user.\n");return 1;}
  if(argc==4 && strcmp(argv[1],"--swap")==0){if(swap(argv[2],argv[3])<0){perror("atomic swap");return 1;}return 0;}
  // pid, target, incoming, job directory, nonce, startup seconds, executable, source inode
  if(argc!=9){fprintf(stderr,"Invalid update arguments.\n");return 1;}
  char *end;long old_number=strtol(argv[1],&end,10);if(*end||old_number<=1)return 1;
  pid_t old_pid=(pid_t)old_number;const char *target=argv[2],*incoming=argv[3],*executable=argv[7];
  if(strlen(argv[4])>=sizeof(job))return 1;strcpy(job,argv[4]);token=argv[5];
  long seconds=strtol(argv[6],&end,10);if(*end||seconds<1||seconds>900||strlen(token)!=36||strchr(executable,'/'))return 1;
  unsigned long long inode=strtoull(argv[8],&end,10);if(*end||!inode)return 1;
  struct stat job_info,old_info;char target_real[PATH_MAX],incoming_real[PATH_MAX],job_real[PATH_MAX];
  if(lstat(job,&job_info)||!S_ISDIR(job_info.st_mode)||job_info.st_uid!=getuid()||(job_info.st_mode&0077)||!realpath(job,job_real)||strcmp(job,job_real))return 1;
  if(!realpath(target,target_real)||strcmp(target,target_real)||!realpath(incoming,incoming_real)||strcmp(incoming,incoming_real))return 1;
  state("waiting-for-quit","");if(marker("helper-ready",token)<0)return 1;
  // A normal app quit drains the gateway and usage writes before its PID exits.
  for(int tick=0;alive(old_pid)&&tick<9000;tick++)pause_tick();
  if(alive(old_pid)||!token_marker("apply")){state("aborted","original-still-running-or-cancelled");return 1;}
  if(lstat(target,&old_info)||(unsigned long long)old_info.st_ino!=inode){state("aborted","original-app-changed");return 1;}
  state("applying","");
  if(swap(target,incoming)<0){perror("install update");state("failed","replacement-denied");launch(target,"--model-bridge-update-rollback");return 1;}
  state("awaiting-startup","");
  int started=launch(target,"--model-bridge-update");
  for(int tick=0;started==0 && tick<seconds*10;tick++){
    if(token_marker("ready")){
      // The old app is retained at incoming until the new gateway confirms readiness.
      int removed=remove_backup(incoming);state("success",removed==0?"":"backup-retained");return 0;
    }
    if(token_marker("failed"))break;
    pid_t next=launched_pid();if(next>1&&!alive(next))break;
    pause_tick();
  }
  pid_t next=launched_pid();
  if(alive(next)){
    if(!app_process(next,target,executable)){state("failed","cannot-stop-new-process");return 1;}
    kill(next,SIGTERM);for(int i=0;i<50&&alive(next);i++)pause_tick();
    if(alive(next)){kill(next,SIGKILL);for(int i=0;i<20&&alive(next);i++)pause_tick();}
    if(alive(next)){state("failed","new-process-still-running");return 1;}
  }
  if(swap(target,incoming)<0){perror("restore original app");state("failed","rollback-failed");return 1;}
  state("rolled-back","startup-failed");launch(target,"--model-bridge-update-rollback");remove_backup(incoming);return 1;
}
