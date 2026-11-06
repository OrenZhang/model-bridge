export interface UpdateState {
  currentVersion: string; phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error' | 'development';
  installMode: 'restart'; latestVersion?: string; notes?: string; checkedAt?: string;
  percent?: number; transferred?: number; total?: number; message?: string; retry?: 'check' | 'download' | 'install';
  recovered?: boolean;
  networkLabel?: string;
}
