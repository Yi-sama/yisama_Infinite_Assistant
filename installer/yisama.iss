; yisama 无限助手 installer. Built by scripts/build-windows.ps1, which stages the
; release payload and passes PayloadDir, AppVersion, OutputDir and OutputName.

#ifndef PayloadDir
  #error PayloadDir is required. Run npm run build:windows.
#endif
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef OutputDir
  #define OutputDir "..\dist"
#endif
#ifndef OutputName
  #define OutputName "Yisama-Setup"
#endif

[Setup]
AppId={{2FEC2B14-5ABC-420F-A522-A943ACC9B195}
AppName=yisama 无限助手
AppVersion={#AppVersion}
AppVerName=yisama 无限助手 {#AppVersion}
AppPublisher=Yi-sama
AppPublisherURL=https://github.com/Yi-sama/yisama_Infinite_Assistant
VersionInfoVersion={#AppVersion}
VersionInfoProductName=yisama 无限助手
; Same location as the earlier self-written installer, so existing users upgrade in place.
DefaultDirName={localappdata}\yisama-infinite-assistant
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
LicenseFile=..\LICENSE.txt
SetupIconFile=..\windows\assets\yisama.ico
UninstallDisplayIcon={app}\yisama.ico
UninstallDisplayName=yisama 无限助手
OutputDir={#OutputDir}
OutputBaseFilename={#OutputName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
Uninstallable=not IsTestInstall
CreateUninstallRegKey=not IsTestInstall

[Languages]
Name: "chs"; MessagesFile: "ChineseSimplified.isl"

[Messages]
chs.FinishedLabelNoIcons=安装完成。请使用桌面或开始菜单中的“Codex - yisama”启动 Codex。
chs.FinishedLabel=安装完成。请使用桌面或开始菜单中的“Codex - yisama”启动 Codex。

[InstallDelete]
; Replace program files from earlier versions; logs and endpoint data in {app} are kept.
Type: filesandordirs; Name: "{app}\scripts"
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\runtime"

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "..\windows\assets\yisama.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userdesktop}\Codex - yisama"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\scripts\launch-codex.ps1"""; \
  WorkingDir: "{app}"; IconFilename: "{app}\yisama.ico"; Comment: "Launch Codex with yisama Infinite Assistant"; \
  Flags: runminimized; Check: not IsTestInstall
Name: "{userprograms}\Codex - yisama"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\scripts\launch-codex.ps1"""; \
  WorkingDir: "{app}"; IconFilename: "{app}\yisama.ico"; Comment: "Launch Codex with yisama Infinite Assistant"; \
  Flags: runminimized; Check: not IsTestInstall

[Code]
const
  RunKey = 'Software\Microsoft\Windows\CurrentVersion\Run';
  LegacyRunValue = 'YisamaInfiniteAssistant';

{ /YISAMATEST=1 installs files only: no Codex check, shortcuts, registry or uninstaller. }
function IsTestInstall: Boolean;
begin
  Result := ExpandConstant('{param:YISAMATEST|0}') = '1';
end;

function IsCodexDesktopPath(Path: String): Boolean;
var
  Name, AppDir, PackageDir: String;
begin
  Result := False;
  if Path = '' then Exit;
  Name := ExtractFileName(Path);
  if (CompareText(Name, 'ChatGPT.exe') <> 0) and (CompareText(Name, 'Codex.exe') <> 0) then Exit;
  AppDir := ExtractFileDir(Path);
  if CompareText(AppDir, ExpandConstant('{localappdata}\Programs\Codex')) = 0 then
  begin
    Result := True;
    Exit;
  end;
  PackageDir := ExtractFileDir(AppDir);
  Result := (CompareText(ExtractFileName(AppDir), 'app') = 0) and
    (CompareText(Copy(ExtractFileName(PackageDir), 1, 13), 'OpenAI.Codex_') = 0) and
    (CompareText(ExtractFileName(ExtractFileDir(PackageDir)), 'WindowsApps') = 0);
end;

function CodexDesktopRunning: Boolean;
var
  Locator, Service, Items, Item: Variant;
  Index: Integer;
begin
  Result := False;
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Service := Locator.ConnectServer('.', 'root\CIMV2');
    Items := Service.ExecQuery('SELECT ExecutablePath FROM Win32_Process WHERE Name = ''Codex.exe'' OR Name = ''ChatGPT.exe''');
    for Index := 0 to Items.Count - 1 do
    begin
      Item := Items.ItemIndex(Index);
      if not VarIsNull(Item.ExecutablePath) then
        if IsCodexDesktopPath(Item.ExecutablePath) then
        begin
          Result := True;
          Exit;
        end;
    end;
  except
    Log('Codex process check failed: ' + GetExceptionMessage);
  end;
end;

{ The assistant's bundled node.exe can outlive Codex and would lock runtime\node.exe.
  Only processes running that exact bundled executable are stopped. }
procedure StopBundledAssistant;
var
  Locator, Service, Items, Item: Variant;
  Index, Waited: Integer;
  Node: String;
  Found: Boolean;
begin
  Node := ExpandConstant('{app}\runtime\node.exe');
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Service := Locator.ConnectServer('.', 'root\CIMV2');
    for Waited := 0 to 20 do
    begin
      Found := False;
      Items := Service.ExecQuery('SELECT ExecutablePath FROM Win32_Process WHERE Name = ''node.exe''');
      for Index := 0 to Items.Count - 1 do
      begin
        Item := Items.ItemIndex(Index);
        if not VarIsNull(Item.ExecutablePath) then
          if CompareText(Item.ExecutablePath, Node) = 0 then
          begin
            Found := True;
            Item.Terminate;
          end;
      end;
      if not Found then Exit;
      Sleep(250);
    end;
  except
    Log('Assistant process stop failed: ' + GetExceptionMessage);
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  StopBundledAssistant;
end;

procedure RemoveOwnedLegacyRunEntry;
var
  Existing: String;
begin
  if RegQueryStringValue(HKCU, RunKey, LegacyRunValue, Existing) then
    if CompareText(Existing, '"' + ExpandConstant('{app}\Host.exe') + '" --watch') = 0 then
      RegDeleteValue(HKCU, RunKey, LegacyRunValue);
end;

function InitializeSetup: Boolean;
begin
  Result := True;
  if IsTestInstall then Exit;
  if CodexDesktopRunning then
  begin
    SuppressibleMsgBox('请先关闭所有 Codex 桌面窗口，再运行安装程序。安装程序不会停止或重启 Codex。',
      mbError, MB_OK, IDOK);
    Result := False;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and not IsTestInstall then
    RemoveOwnedLegacyRunEntry;
end;

{ Restore the user's original Codex configuration before any file is removed. }
function InitializeUninstall: Boolean;
var
  PluginData, Node, Script: String;
  ResultCode: Integer;
begin
  Result := False;
  if CodexDesktopRunning then
  begin
    SuppressibleMsgBox('请先关闭所有 Codex 桌面窗口，再卸载。', mbError, MB_OK, IDOK);
    Exit;
  end;
  StopBundledAssistant;
  PluginData := GetEnv('PLUGIN_DATA');
  if PluginData = '' then
    PluginData := ExpandConstant('{%USERPROFILE}\.yisama-infinite-assistant');
  if FileExists(PluginData + '\state.json') then
  begin
    Node := ExpandConstant('{app}\runtime\node.exe');
    Script := ExpandConstant('{app}\scripts\yisama.mjs');
    if not FileExists(Node) or not FileExists(Script) or
       not Exec(Node, '"' + Script + '" restore', ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) or
       (ResultCode <> 0) or FileExists(PluginData + '\state.json') then
    begin
      SuppressibleMsgBox('恢复原 Codex 配置未完成，卸载已取消，助手文件和备份均已保留。', mbError, MB_OK, IDOK);
      Exit;
    end;
  end;
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    RemoveOwnedLegacyRunEntry;
end;
