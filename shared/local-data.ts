export interface LocalDataSetup {
  storage: 'temporary' | 'persistent';
  installation: 'available' | 'restart_required' | 'existing_directory' | 'custom_paths';
}

export const missingLocalNames = '本機藥品資料尚未安裝，無法查詢；這不代表查無藥品。請依頁面上方「準備本機資料」完成安裝後重新啟動專案。';
