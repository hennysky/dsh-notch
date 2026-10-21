namespace DSHNotch;

/// <summary>应用级常量。版本号同时用于 /health 的 version 字段。</summary>
public static class AppInfo
{
    public const string AppName = "DSHNotch";
    public const string Version = "1.0.0";
    /// <summary>非打包桌面应用的 Application User Model ID，必须与开始菜单快捷方式里写的一致。</summary>
    public const string Aumid = "DSHNotch.Desktop";
    public const string ProtocolScheme = "dshnotch";
    public const string ProtocolUrl = ProtocolScheme + "://open-dsh";
    public const int BridgePort = 47810;
}
