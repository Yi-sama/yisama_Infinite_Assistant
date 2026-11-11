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
Source: "{#PayloadDir}\runtime\codex-bootstrap.exe"; DestName: "codex-setup-bootstrap.exe"; Flags: dontcopy
Source: "..\scripts\install-codex.ps1"; Flags: dontcopy
Source: "{tmp}\codex-location.json"; DestDir: "{app}"; Flags: external ignoreversion; Check: not IsTestInstall

[Icons]
Name: "{userdesktop}\Codex - yisama"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\scripts\launch-codex.ps1"""; \
  WorkingDir: "{app}"; IconFilename: "{app}\yisama.ico"; Comment: "Launch Codex with yisama Infinite Assistant"; \
  Flags: runminimized; Check: not IsTestInstall
Name: "{userprograms}\Codex - yisama"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\scripts\launch-codex.ps1"""; \
  WorkingDir: "{app}"; IconFilename: "{app}\yisama.ico"; Comment: "Launch Codex with yisama Infinite Assistant"; \
  Flags: runminimized; Check: not IsTestInstall

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\scripts\launch-codex.ps1"""; \
  Description: "启动 Codex - yisama"; Flags: postinstall nowait skipifsilent runhidden; Check: not IsTestInstall

[Code]
const
  RunKey = 'Software\Microsoft\Windows\CurrentVersion\Run';
  LegacyRunValue = 'YisamaInfiniteAssistant';

type
  TStartupInfo = record
    Size: LongWord;
    Reserved, Desktop, Title: String;
    X, Y, XSize, YSize, XChars, YChars, Fill, Flags: LongWord;
    ShowWindow, ReservedSize: Word;
    ReservedData, StdInput, StdOutput, StdError: LongWord;
  end;
  TProcessInfo = record
    ProcessHandle, ThreadHandle: LongWord;
    ProcessId, ThreadId: LongWord;
  end;

{ Inno Setup 6 runs a 32-bit setup process, including on x64 Windows. }
function CreateProcess(Application: String; CommandLine: String; ProcessAttributes,
  ThreadAttributes: LongWord; InheritHandles: Boolean; Flags: LongWord;
  Environment: LongWord; Directory: String; var StartupInfo: TStartupInfo;
  var ProcessInfo: TProcessInfo): Boolean;
  external 'CreateProcessW@kernel32.dll stdcall';
function WaitForSingleObject(Handle: LongWord; Milliseconds: LongWord): LongWord;
  external 'WaitForSingleObject@kernel32.dll stdcall';
function GetExitCodeProcess(Handle: LongWord; var ExitCode: LongWord): Boolean;
  external 'GetExitCodeProcess@kernel32.dll stdcall';
function CloseHandle(Handle: LongWord): Boolean;
  external 'CloseHandle@kernel32.dll stdcall';

var
  CodexPage: TWizardPage;
  CodexStatus: TNewStaticText;
  CodexVersion: TNewStaticText;
  CodexPath: TNewMemo;
  CodexHint: TNewStaticText;
  BrowseCodexButton, DetectCodexButton: TNewButton;
  DownloadPage, WorkPage: TOutputProgressWizardPage;
  SelectedCodex, SelectedExecutable, DetectionStatus: String;
  BootstrapFile, DetectionFile: String;
  DownloadCancelFile: String;
  PauseDownloadButton: TNewButton;
  SelectionRunning, SelectionTested, DownloadActive, DownloadPaused: Boolean;

{ /YISAMATEST=1 installs files only: no Codex check, shortcuts, registry or uninstaller. }
function IsTestInstall: Boolean;
begin
  Result := ExpandConstant('{param:YISAMATEST|0}') = '1';
end;

function IsPreview: Boolean;
begin
  Result := IsTestInstall and (ExpandConstant('{param:YISAMAUI|0}') = '1');
end;

function IsAssistantOnlyUpdate: Boolean;
begin
  Result := (ExpandConstant('{param:YISAMAUPDATE|0}') = '1') and
    (ExpandConstant('{param:CODEXPATH|}') = '') and
    FileExists(ExpandConstant('{app}\codex-location.json')) and
    FileExists(ExpandConstant('{app}\release-manifest.json')) and
    FileExists(ExpandConstant('{app}\scripts\launch-codex.ps1'));
end;

function Quote(Value: String): String;
begin
  Result := '"' + Value + '"';
end;

function RunBootstrap(Arguments: String): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec(BootstrapFile, Arguments, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if Result then Result := ResultCode = 0;
end;

function ReportError: String;
begin
  Result := GetIniString('codex', 'message', '无法完成 Codex 检查，请重新检测或选择已有安装。', DetectionFile);
end;

function DetectCodex(Candidate: String; IgnoreSaved: Boolean): Boolean;
var
  Arguments: String;
begin
  DeleteFile(DetectionFile);
  Arguments := 'detect --report ' + Quote(DetectionFile);
  if Candidate <> '' then
    Arguments := Arguments + ' --selected ' + Quote(Candidate)
  else if not IgnoreSaved then
    Arguments := Arguments + ' --location ' + Quote(AddBackslash(WizardDirValue) + 'codex-location.json');
  Result := RunBootstrap(Arguments);
  DetectionStatus := GetIniString('codex', 'status', 'error', DetectionFile);
  if not Result then
  begin
    DetectionStatus := 'error';
    Exit;
  end;
  SelectedCodex := GetIniString('codex', 'root', '', DetectionFile);
  SelectedExecutable := GetIniString('codex', 'executable', '', DetectionFile);
  SelectionRunning := GetIniString('codex', 'running', '0', DetectionFile) = '1';
  SelectionTested := GetIniString('codex', 'tested', '0', DetectionFile) = '1';
end;

procedure RenderCodex;
var
  Found: Boolean;
begin
  Found := DetectionStatus = 'found';
  CodexVersion.Visible := Found;
  CodexPath.Visible := Found;
  CodexPath.Text := SelectedExecutable;
  CodexVersion.Caption := '';
  CodexHint.Caption := '';
  if Found then
  begin
    CodexPage.Description := '已找到 Codex，将直接使用';
    CodexStatus.Caption := '已找到电脑上的 Codex，不需要重新下载。';
    CodexVersion.Caption := '版本 ' + GetIniString('codex', 'version', '未知', DetectionFile) + '，位置：';
    if SelectionRunning then
      CodexHint.Caption := 'Codex 正在运行。请先完成手头的任务并关闭 Codex，再点击“下一步”。'
    else if FileExists(AddBackslash(WizardDirValue) + 'scripts\codex-assistant.mjs') then
      CodexHint.Caption := '点击“下一步”更新无限助手。你的账号、会话和设置都会保留。'
    else
      CodexHint.Caption := '点击“下一步”安装无限助手。你的账号、会话和设置都会保留。';
  end
  else if DetectionStatus = 'missing' then
  begin
    CodexPage.Description := '电脑上还没有 Codex，将自动下载';
    CodexStatus.Caption := '没有找到 Codex。';
    CodexHint.Caption := '点击“下一步”会自动下载并安装 Codex（约 958 MB），然后安装无限助手。' + #13#10 +
      '下载中途可以暂停，下次打开安装程序会接着下载。' + #13#10#13#10 +
      '如果你已经装过 Codex，请点“手动选择”指定它的位置。';
  end
  else
  begin
    CodexPage.Description := '暂时无法确认 Codex';
    CodexStatus.Caption := '检查 Codex 时出了问题。';
    CodexHint.Caption := ReportError + #13#10 + '请点“重新查找”，或用“手动选择”指定 Codex 的位置。';
  end;
end;

procedure BrowseCodex(Sender: TObject);
var
  FileName: String;
begin
  FileName := SelectedExecutable;
  if GetOpenFileName('选择已有 Codex 桌面程序', FileName, '',
    'Codex 桌面程序|Codex.exe;ChatGPT.exe', '') then
  begin
    if not DetectCodex(FileName, True) then
      SuppressibleMsgBox(ReportError, mbError, MB_OK, IDOK);
    RenderCodex;
  end;
end;

procedure RefreshCodex(Sender: TObject);
begin
  SelectedCodex := '';
  SelectedExecutable := '';
  DetectCodex('', True);
  RenderCodex;
end;

procedure PauseDownload(Sender: TObject);
begin
  if not DownloadActive then Exit;
  DownloadPaused := SaveStringToFile(DownloadCancelFile, 'pause', False);
  if DownloadPaused then
  begin
    PauseDownloadButton.Enabled := False;
    DownloadPage.SetText('正在暂停下载...', '');
  end;
end;

procedure InitializeWizard;
begin
  if IsTestInstall and not IsPreview then Exit;
  SelectedCodex := ExpandConstant('{param:CODEXPATH|}');
  ExtractTemporaryFile('codex-setup-bootstrap.exe');
  ExtractTemporaryFile('install-codex.ps1');
  BootstrapFile := ExpandConstant('{tmp}\codex-setup-bootstrap.exe');
  DetectionFile := ExpandConstant('{tmp}\codex-detection.ini');
  CodexPage := CreateCustomPage(wpLicense, '准备 Codex', '正在查找 Codex...');
  CodexStatus := TNewStaticText.Create(CodexPage);
  CodexStatus.Parent := CodexPage.Surface;
  CodexStatus.SetBounds(0, 0, CodexPage.SurfaceWidth, ScaleY(24));
  CodexStatus.AutoSize := False;
  CodexStatus.WordWrap := True;
  CodexStatus.Font.Size := CodexStatus.Font.Size + 2;
  CodexStatus.Font.Style := [fsBold];
  CodexVersion := TNewStaticText.Create(CodexPage);
  CodexVersion.Parent := CodexPage.Surface;
  CodexVersion.SetBounds(0, ScaleY(36), CodexPage.SurfaceWidth, ScaleY(20));
  CodexPath := TNewMemo.Create(CodexPage);
  CodexPath.Parent := CodexPage.Surface;
  CodexPath.SetBounds(0, ScaleY(58), CodexPage.SurfaceWidth, ScaleY(38));
  CodexPath.ReadOnly := True;
  CodexPath.WordWrap := True;
  CodexPath.TabStop := False;
  CodexHint := TNewStaticText.Create(CodexPage);
  CodexHint.Parent := CodexPage.Surface;
  CodexHint.SetBounds(0, ScaleY(108), CodexPage.SurfaceWidth, ScaleY(80));
  CodexHint.AutoSize := False;
  CodexHint.WordWrap := True;
  BrowseCodexButton := TNewButton.Create(CodexPage);
  BrowseCodexButton.Parent := CodexPage.Surface;
  BrowseCodexButton.SetBounds(0, CodexPage.SurfaceHeight - ScaleY(26), ScaleX(120), ScaleY(26));
  BrowseCodexButton.Caption := '手动选择...';
  BrowseCodexButton.OnClick := @BrowseCodex;
  DetectCodexButton := TNewButton.Create(CodexPage);
  DetectCodexButton.Parent := CodexPage.Surface;
  DetectCodexButton.SetBounds(ScaleX(132), CodexPage.SurfaceHeight - ScaleY(26), ScaleX(100), ScaleY(26));
  DetectCodexButton.Caption := '重新查找';
  DetectCodexButton.OnClick := @RefreshCodex;
  DownloadPage := CreateOutputProgressPage('下载 Codex', '');
  PauseDownloadButton := TNewButton.Create(DownloadPage);
  PauseDownloadButton.Parent := DownloadPage.Surface;
  PauseDownloadButton.SetBounds(0, ScaleY(120), ScaleX(120), ScaleY(26));
  PauseDownloadButton.Caption := '暂停下载';
  PauseDownloadButton.OnClick := @PauseDownload;
  WorkPage := CreateOutputProgressPage('准备 Codex', '');
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if IsTestInstall and not IsPreview then Exit;
  if PageID = CodexPage.ID then Result := WizardSilent and not IsPreview;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if IsTestInstall and not IsPreview then Exit;
  if CurPageID = CodexPage.ID then
  begin
    if DetectionStatus = '' then
    begin
      DetectCodex(SelectedCodex, False);
      RenderCodex;
      Log('Codex preparation page initialized: status=' + DetectionStatus +
        '; assistant=' + WizardDirValue);
    end;
    if IsPreview and not WizardSilent then WizardForm.NextButton.Enabled := False;
  end;
end;

function DownloadCodex(PackageFile: String; Size: Integer): Boolean;
var
  StartupInfo: TStartupInfo;
  ProcessInfo: TProcessInfo;
  ExitCode, WaitResult: LongWord;
  Arguments, Status: String;
  Downloaded: Integer;
begin
  Result := False;
  DownloadCancelFile := ExpandConstant('{tmp}\codex-download.pause');
  DeleteFile(DownloadCancelFile);
  DeleteFile(DetectionFile);
  DeleteFile(DetectionFile + '.verifying');
  DownloadPaused := False;
  Arguments := Quote(BootstrapFile) + ' download --file ' + Quote(PackageFile) +
    ' --report ' + Quote(DetectionFile) + ' --cancel ' + Quote(DownloadCancelFile);
  StartupInfo.Size := SizeOf(StartupInfo);
  { Keep a real process handle: ewNoWait does not return a PID or exit status. }
  if not CreateProcess(BootstrapFile, Arguments, 0, 0, False, $08000000,
    0, ExpandConstant('{tmp}'), StartupInfo, ProcessInfo) then
    RaiseException('无法启动 Codex 下载，尚未安装。');
  CloseHandle(ProcessInfo.ThreadHandle);
  DownloadActive := True;
  DownloadPage.SetText('正在连接下载源...', '');
  DownloadPage.SetProgress(0, 100);
  DownloadPage.Show;
  PauseDownloadButton.Enabled := True;
  try
    repeat
      Downloaded := 0;
      FileSize(PackageFile + '.part', Downloaded);
      if FileExists(DetectionFile + '.verifying') then
      begin
        DownloadPage.SetText('正在校验 Codex 安装包...', '');
        Downloaded := Size;
        PauseDownloadButton.Enabled := False;
      end
      else if not DownloadPaused then
        DownloadPage.SetText('已下载 ' + IntToStr(Downloaded div 1048576) + ' / ' +
          IntToStr(Size div 1048576) + ' MB', '');
      DownloadPage.SetProgress(Downloaded, Size);
      WaitResult := WaitForSingleObject(ProcessInfo.ProcessHandle, 100);
    until WaitResult <> 258;
    if (WaitResult <> 0) or
      not GetExitCodeProcess(ProcessInfo.ProcessHandle, ExitCode) then
      RaiseException('无法确认下载结果，已缓存的数据将保留。');
    Status := GetIniString('codex', 'status', 'error', DetectionFile);
    if Status = 'paused' then Exit;
    if (ExitCode <> 0) or (Status <> 'ready') then
      RaiseException('Codex 下载未完成，尚未安装。已缓存的数据会在下次继续。' + #13#10 + ReportError);
    Result := True;
  finally
    DownloadActive := False;
    CloseHandle(ProcessInfo.ProcessHandle);
    DownloadPage.Hide;
  end;
end;

function DownloadAndInstallCodex: Boolean;
var
  FileName, Hash, PackageFile, Arguments: String;
  ResultCode, PackageSize: Integer;
begin
  Result := False;
  if IsTestInstall then Exit;
  WorkPage.SetText('正在确认下载来源...', '');
  WorkPage.Show;
  try
    if not RunBootstrap('source --report ' + Quote(DetectionFile)) then
      RaiseException(ReportError);
  finally
    WorkPage.Hide;
  end;
  FileName := GetIniString('codex', 'filename', '', DetectionFile);
  Hash := GetIniString('codex', 'sha256', '', DetectionFile);
  PackageSize := GetIniInt('codex', 'size', 0, 0, 2147483647, DetectionFile);
  if (FileName = '') or (Length(Hash) <> 64) or (PackageSize = 0) then
    RaiseException('下载信息不完整，尚未安装 Codex。');
  PackageFile := ExpandConstant('{localappdata}\yisama-infinite-assistant-cache\codex\') +
    Hash + '\' + FileName;
  if not DownloadCodex(PackageFile, PackageSize) then Exit;
  WorkPage.SetText('正在验证并安装 Codex...', '不更改现有账号、会话和配置');
  WorkPage.Show;
  try
    Arguments := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' +
      Quote(ExpandConstant('{tmp}\install-codex.ps1')) +
      ' -BootstrapPath ' + Quote(BootstrapFile) +
      ' -PackagePath ' + Quote(PackageFile) +
      ' -LocationFile ' + Quote(AddBackslash(WizardDirValue) + 'codex-location.json') +
      ' -ReportPath ' + Quote(DetectionFile);
    if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      Arguments, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      RaiseException('无法启动 Codex 安装程序，尚未安装无限助手。');
    if (ResultCode <> 0) or (GetIniString('codex', 'status', '', DetectionFile) <> 'found') then
      RaiseException(ReportError);
    Result := DetectCodex('', True) and (DetectionStatus = 'found');
    if not Result then RaiseException('安装后未能检测到 Codex，请重新检测。');
    RenderCodex;
  finally
    WorkPage.Hide;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if IsTestInstall or WizardSilent then Exit;
  if CurPageID <> CodexPage.ID then Exit;
  Result := False;
  try
    if not DetectCodex(SelectedCodex, False) then RaiseException(ReportError);
    if SelectionRunning then
    begin
      RenderCodex;
      RaiseException('Codex 正在运行。请先完成手头的任务并关闭 Codex，再点击“下一步”。' + #13#10 +
        '安装程序不会替你关闭或重启 Codex。');
    end;
    if DetectionStatus = 'missing' then
      if not DownloadAndInstallCodex then Exit;
    { An existing Codex is always kept as is; the assistant adapts to it or stays out of the way. }
    Result := DetectionStatus = 'found';
  except
    SuppressibleMsgBox(GetExceptionMessage, mbError, MB_OK, IDOK);
  end;
end;

function IsCodexDesktopPath(Path: String): Boolean;
var
  Name, AppDir, PackageDir: String;
begin
  Result := False;
  if Path = '' then Exit;
  Name := ExtractFileName(Path);
  if (CompareText(Name, 'ChatGPT.exe') <> 0) and (CompareText(Name, 'Codex.exe') <> 0) then Exit;
  if (SelectedExecutable <> '') and (CompareText(Path, SelectedExecutable) = 0) then
  begin
    Result := True;
    Exit;
  end;
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
  if IsTestInstall then Exit;
  if not DetectCodex(SelectedCodex, False) then
  begin
    Result := ReportError;
    Exit;
  end;
  if DetectionStatus = 'missing' then
  begin
    if not WizardSilent or (ExpandConstant('{param:INSTALLCODEX|0}') <> '1') then
    begin
      Result := '未找到 Codex。请选择已有安装，或在交互界面确认下载。';
      Exit;
    end;
    try
      if not DownloadAndInstallCodex then
      begin
        Result := 'Codex 下载或安装未完成，尚未安装无限助手。';
        Exit;
      end;
    except
      Result := GetExceptionMessage;
      Exit;
    end;
  end;
  if SelectionRunning or CodexDesktopRunning then
  begin
    Result := '请先完成任务并关闭所有 Codex 窗口，再继续安装。安装程序不会结束或重启 Codex。';
    Exit;
  end;
  { Updating an existing assistant does not replace or claim compatibility for Codex. }
  if WizardSilent and not SelectionTested and not IsAssistantOnlyUpdate then
  begin
    Result := '此 Codex 版本尚未验证，请使用交互安装程序确认保留当前版本。';
    Exit;
  end;
  if not RunBootstrap('remember --selected ' + Quote(SelectedCodex) +
    ' --location ' + Quote(ExpandConstant('{tmp}\codex-location.json')) +
    ' --report ' + Quote(DetectionFile)) then
  begin
    Result := ReportError;
    Exit;
  end;
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
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if (CurStep = ssPostInstall) and not IsTestInstall then
  begin
    if not Exec(ExpandConstant('{app}\runtime\node.exe'),
      Quote(ExpandConstant('{app}\scripts\yisama.mjs')) + ' image install',
      ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
      RaiseException('生图配置未完成，原始 imagegen 备份已保留，请联系管理员。');
    if not Exec(ExpandConstant('{app}\runtime\node.exe'),
      '--disable-warning=ExperimentalWarning ' + Quote(ExpandConstant('{app}\scripts\yisama.mjs')) + ' startup local',
      ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
      RaiseException('本地对话检查未完成，已有迁移备份已保留。请勿删除对话文件，请联系管理员检查对话索引、文件访问权限或进程占用情况。');
    RemoveOwnedLegacyRunEntry;
  end;
end;

{ Restore the user's original Codex configuration before any file is removed. }
function InitializeUninstall: Boolean;
var
  PluginData, Node, Script: String;
  ResultCode: Integer;
begin
  Result := False;
  if FileExists(ExpandConstant('{app}\runtime\codex-bootstrap.exe')) then
  begin
    BootstrapFile := ExpandConstant('{app}\runtime\codex-bootstrap.exe');
    DetectionFile := ExpandConstant('{tmp}\codex-uninstall.ini');
    if not RunBootstrap('running --location ' + Quote(ExpandConstant('{app}\codex-location.json')) +
      ' --report ' + Quote(DetectionFile)) then
    begin
      SuppressibleMsgBox('无法确认 Codex 运行状态，卸载已取消。' + #13#10 + ReportError, mbError, MB_OK, IDOK);
      Exit;
    end;
    if GetIniString('codex', 'running', '1', DetectionFile) = '1' then
    begin
      SuppressibleMsgBox('请先关闭所有 Codex 桌面窗口，再卸载。', mbError, MB_OK, IDOK);
      Exit;
    end;
  end;
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
  Node := ExpandConstant('{app}\runtime\node.exe');
  Script := ExpandConstant('{app}\scripts\yisama.mjs');
  if not Exec(Node, '--disable-warning=ExperimentalWarning ' + Quote(Script) + ' startup restore',
    ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
  begin
    SuppressibleMsgBox('恢复旧对话提供商未完成，卸载已取消，迁移备份已保留。', mbError, MB_OK, IDOK);
    Exit;
  end;
  if not Exec(Node, Quote(Script) + ' image uninstall', ExpandConstant('{app}'),
    SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
  begin
    SuppressibleMsgBox('恢复系统 imagegen 未完成，卸载已取消，生图备份已保留。', mbError, MB_OK, IDOK);
    Exit;
  end;
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    RemoveOwnedLegacyRunEntry;
end;
