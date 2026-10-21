using System.Runtime.InteropServices;
using System.Text;

namespace DSHNotch;

/// <summary>
/// 非打包（unpackaged）桌面应用要发 WinRT toast，必须有一个带
/// System.AppUserModel.ID 属性的开始菜单快捷方式，且进程 AUMID 与它一致。
/// 首次运行时创建，之后每次启动都幂等检查。
///
/// 这里用内置 COM interop（IShellLinkW / IPropertyStore / IPersistFile），
/// 不引第三方包；只在 Windows 上调用。
/// </summary>
public static class ShortcutCreator
{
    public static string DefaultShortcutPath => AppPaths.StartMenuShortcut;

    /// <summary>幂等创建开始菜单快捷方式。成功返回 true；失败只记日志。</summary>
    public static bool EnsureShortcut(string? executablePath = null)
    {
        try
        {
            var exe = executablePath ?? AppPaths.ExecutablePath;
            if (string.IsNullOrEmpty(exe) || !File.Exists(exe))
            {
                AppLog.Write($"创建快捷方式跳过：可执行文件不存在（{exe}）");
                return false;
            }

            CreateShortcut(DefaultShortcutPath, exe, AppInfo.Aumid);
            return true;
        }
        catch (Exception ex)
        {
            AppLog.Error("创建开始菜单快捷方式失败", ex);
            return false;
        }
    }

    /// <summary>在指定位置创建 .lnk 并写入 AUMID。抽出来便于 CI 在临时目录里验证 COM interop。</summary>
    public static void CreateShortcut(string linkPath, string executablePath, string aumid)
    {
        var directory = Path.GetDirectoryName(linkPath);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

        object? shellLinkObject = null;
        try
        {
            shellLinkObject = new ShellLinkCoClass();
            var shellLink = (IShellLinkW)shellLinkObject;
            shellLink.SetPath(executablePath);
            shellLink.SetWorkingDirectory(Path.GetDirectoryName(executablePath) ?? string.Empty);
            shellLink.SetDescription("DSHNotch 余额与通知");
            shellLink.SetArguments(string.Empty);

            var propertyStore = (IPropertyStore)shellLinkObject;
            var key = PKeyAppUserModelId;
            // 不用 InitPropVariantFromString：不是所有 Windows 版本的 propsys.dll 都导出它，
            // CI 上实测 EntryPointNotFoundException。手工构造 VT_LPWSTR 即可。
            var variant = new PropVariant
            {
                Vt = VariantTypeLpwstr,
                PointerValue = Marshal.StringToCoTaskMemUni(aumid),
            };
            try
            {
                propertyStore.SetValue(ref key, ref variant);
            }
            finally
            {
                // VT_LPWSTR 的字符串由 PropVariantClear 用 CoTaskMemFree 释放。
                PropVariantClear(ref variant);
            }

            propertyStore.Commit();
            ((IPersistFile)shellLinkObject).Save(linkPath, true);
            AppLog.Write($"已写入开始菜单快捷方式：{linkPath}（AUMID={aumid}）");
        }
        finally
        {
            if (shellLinkObject is not null && Marshal.IsComObject(shellLinkObject))
            {
                Marshal.ReleaseComObject(shellLinkObject);
            }
        }
    }

    /// <summary>读回快捷方式里的 AUMID。CI 集成测试用它验证 COM interop 真的写进去了。</summary>
    public static string? ReadAumid(string linkPath)
    {
        object? shellLinkObject = null;
        try
        {
            shellLinkObject = new ShellLinkCoClass();
            var propertyStore = (IPropertyStore)shellLinkObject;
            var key = PKeyAppUserModelId;
            propertyStore.GetValue(ref key, out var variant);
            try
            {
                return variant.Vt == VariantTypeLpwstr ? Marshal.PtrToStringUni(variant.PointerValue) : null;
            }
            finally
            {
                PropVariantClear(ref variant);
            }
        }
        finally
        {
            if (shellLinkObject is not null && Marshal.IsComObject(shellLinkObject))
            {
                Marshal.ReleaseComObject(shellLinkObject);
            }
        }
    }

    /// <summary>让当前进程使用指定 AUMID（与快捷方式一致，任务栏/通知中心才会归到同一个应用）。</summary>
    public static void EnsureProcessAumid()
    {
        try
        {
            SetCurrentProcessExplicitAppUserModelID(AppInfo.Aumid);
            AppLog.Write($"进程 AUMID = {AppInfo.Aumid}");
        }
        catch (Exception ex)
        {
            AppLog.Error("设置进程 AUMID 失败（toast 可能不可用）", ex);
        }
    }

    // MARK: - COM interop

    private const ushort VariantTypeLpwstr = 31;

    private static readonly PropertyKey PKeyAppUserModelId = new()
    {
        FormatId = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
        PropertyId = 5,
    };

    [ComImport]
    [Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLinkCoClass
    {
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("000214F9-0000-0000-C000-000000000046")]
    private interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);

        void GetIDList(out IntPtr ppidl);

        void SetIDList(IntPtr pidl);

        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);

        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);

        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);

        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);

        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);

        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);

        void GetHotkey(out short pwHotkey);

        void SetHotkey(short wHotkey);

        void GetShowCmd(out int piShowCmd);

        void SetShowCmd(int iShowCmd);

        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);

        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);

        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);

        void Resolve(IntPtr hwnd, uint fFlags);

        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("0000010b-0000-0000-C000-000000000046")]
    private interface IPersistFile
    {
        void GetClassID(out Guid pClassID);

        [PreserveSig]
        int IsDirty();

        void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);

        void Save([MarshalAs(UnmanagedType.LPWStr)] string? pszFileName, [MarshalAs(UnmanagedType.Bool)] bool fRemember);

        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);

        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    private interface IPropertyStore
    {
        void GetCount(out uint cProps);

        void GetAt(uint iProp, out PropertyKey pkey);

        void GetValue(ref PropertyKey key, out PropVariant pv);

        void SetValue(ref PropertyKey key, ref PropVariant pv);

        void Commit();
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct PropertyKey
    {
        public Guid FormatId;
        public uint PropertyId;
    }

    /// <summary>
    /// PROPVARIANT 的 x64 布局：vt 在偏移 0，联合体在偏移 8。
    /// 本项目只发布 win-x64，所以这样足够；x86 需要改为 Pack=4 的 16 字节布局。
    /// </summary>
    [StructLayout(LayoutKind.Explicit)]
    private struct PropVariant
    {
        [FieldOffset(0)]
        public ushort Vt;

        [FieldOffset(8)]
        public IntPtr PointerValue;
    }

    [DllImport("ole32.dll", ExactSpelling = true)]
    private static extern int PropVariantClear(ref PropVariant pvar);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, PreserveSig = false)]
    private static extern void SetCurrentProcessExplicitAppUserModelID(string appId);
}
