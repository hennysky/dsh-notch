; DSHNotch Windows 安装包（Inno Setup 6）
;
; 为什么要有它：直接发 zip 是错误的产品决策——Windows 会把 zip 当「压缩文件夹」打开，
; 双击里面的 exe 会弹「是否解压缩此文件」，用户根本分不清「已解压」和「还在压缩包里」。
; 安装包把这一层彻底去掉：双击 → 下一步 → 装到 %LOCALAPPDATA%\Programs\DSHNotch →
; 开始菜单/桌面快捷方式 → 直接启动。用户不需要解压、不需要命令行。

#define MyAppName "DSHNotch"
#define MyAppVersion "1.2.4"
#define MyAppPublisher "DSHNotch"
#define MyAppExeName "DSHNotch.exe"

[Setup]
AppId={{8E6E3F4B-6B1C-4E7A-9E0F-3B7C2D4A5F61}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\DSHNotch
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\..\dist-installer
OutputBaseFilename=DSHNotch-Setup-{#MyAppVersion}
SetupIconFile=assets\DSHNotch.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
CloseApplications=no
AppMutex=Local\DSHNotch.SingleInstance

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："
Name: "startup"; Description: "开机自动启动 DSHNotch"; GroupDescription: "启动："

[Files]
; 文件夹版发布产物（exe + 依赖 DLL），由 CI 的 publish-folder 步骤生成
Source: "..\..\publish-folder\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; 注意：应用首次启动会用自己的 AUMID 重写同名开始菜单快捷方式（Windows toast 的前提），
; 路径与名字必须保持一致：%StartMenu%\Programs\DSHNotch.lnk
Name: "{autoprograms}\DSHNotch"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\DSHNotch"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; \
  ValueName: "DSHNotch"; ValueData: """{app}\{#MyAppExeName}"""; \
  Flags: uninsdeletevalue; Tasks: startup

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "启动 DSHNotch"; Flags: nowait postinstall skipifsilent
