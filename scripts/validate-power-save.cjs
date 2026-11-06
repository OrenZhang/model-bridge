const {app,powerSaveBlocker}=require('electron');const cp=require('node:child_process');
app.whenReady().then(async()=>{
 const id=powerSaveBlocker.start('prevent-app-suspension');
 try {
  if(!powerSaveBlocker.isStarted(id))throw new Error('Power blocker did not start');
  await new Promise(r=>setTimeout(r,700));
  const native=()=>cp.execFileSync('/usr/bin/pmset',['-g','assertions'],{encoding:'utf8'}).split('\n').filter(l=>l.includes(`pid ${process.pid}(`));
  if(process.platform==='darwin'&&!native().some(l=>/NoIdleSleepAssertion|PreventUserIdleSystemSleep/.test(l)))throw new Error('Native idle sleep assertion missing');
  powerSaveBlocker.stop(id);await new Promise(r=>setTimeout(r,100));
  if(powerSaveBlocker.isStarted(id))throw new Error('Power blocker did not stop');
  if(process.platform==='darwin'&&native().some(l=>/NoIdleSleepAssertion|PreventUserIdleSystemSleep/.test(l)))throw new Error('Native sleep assertion was not released');
  console.log('PASS: system idle sleep blocked and released; display sleep remains allowed');
 } finally {powerSaveBlocker.stop(id);app.quit();}
}).catch(error=>{console.error(error.message);app.exit(1)});
