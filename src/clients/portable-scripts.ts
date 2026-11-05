import { readFileSync } from 'node:fs';
import type { InstallPayload } from './portable-installer.js';

export function portableScripts(payload: InstallPayload): { macos: string; linux: string; windows: string } {
  // Built once with our TOML parser; the receiving computer needs no npm packages or download.
  const bundle = readFileSync(new URL('../../dist/clients/portable-installer.cjs', import.meta.url), 'utf8');
  const data = Buffer.from(JSON.stringify(payload)).toString('base64');
  const program = bundle + `\nmodule.exports.installPortable(JSON.parse(Buffer.from('${data}','base64').toString('utf8'))).catch(error=>{console.error('Model Bridge: '+error.message);process.exitCode=1;});\n`;
  const posix = `# Model Bridge — paste into macOS Terminal (Node.js 18+ required)\n(\nset -eu\nif ! command -v node >/dev/null 2>&1; then\n  printf '%s\\n' 'Please install Node.js 18+ from https://nodejs.org, then run again.' >&2\n  exit 1\nfi\nnode <<'MODEL_BRIDGE_INSTALL'\n${program}MODEL_BRIDGE_INSTALL\n)\n`;
  return {macos:posix,linux:posix.replace('macOS Terminal','Linux terminal'),
    windows: `# Model Bridge — paste into Windows PowerShell (Node.js 18+ required)\n& {\n  $ErrorActionPreference = 'Stop'\n  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Please install Node.js 18+ from https://nodejs.org, then run again.' }\n  $bridgeTemp = Join-Path ([IO.Path]::GetTempPath()) ('model-bridge-' + [Guid]::NewGuid().ToString('N'))\n  [IO.Directory]::CreateDirectory($bridgeTemp) | Out-Null\n  $bridgeFile = Join-Path $bridgeTemp 'install.cjs'\n  try {\n    [IO.File]::WriteAllBytes($bridgeFile, [Convert]::FromBase64String('${Buffer.from(program).toString('base64')}'))\n    & node $bridgeFile\n    if ($LASTEXITCODE -ne 0) { throw 'Model Bridge configuration failed. See the error above.' }\n  } finally {\n    Remove-Item -LiteralPath $bridgeTemp -Recurse -Force\n  }\n}\n`,
  };
}
