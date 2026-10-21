using DSHNotch;

namespace DSHNotch.Tests;

/// <summary>
/// Windows 集成测试：AUMID 快捷方式（COM interop）、协议注册、开机自启注册表。
/// 这些在 CI 的 windows-latest 上真实执行；其它平台直接返回（不失败）。
/// </summary>
public sealed class WindowsIntegrationTests
{
    [Fact]
    public void ShortcutCreator_WritesAumidProperty()
    {
        if (!OperatingSystem.IsWindows()) return;

        var directory = Path.Combine(Path.GetTempPath(), "dshnotch-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var link = Path.Combine(directory, "DSHNotch.lnk");
        try
        {
            var exe = Environment.ProcessPath ?? @"C:\Windows\notepad.exe";

            ShortcutCreator.CreateShortcut(link, exe, AppInfo.Aumid);

            Assert.True(File.Exists(link), "快捷方式文件没有生成");
            Assert.Equal(AppInfo.Aumid, ShortcutCreator.ReadAumid(link));
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch
            {
                // 测试清理失败不影响结论
            }
        }
    }

    [Fact]
    public void ProtocolRegistration_RoundTrips()
    {
        if (!OperatingSystem.IsWindows()) return;

        var scheme = "dshnotch-test-" + Guid.NewGuid().ToString("N")[..8];
        try
        {
            Assert.True(ProtocolRegistration.Register(scheme, @"C:\Windows\notepad.exe"));

            var command = ProtocolRegistration.ReadCommand(scheme);
            Assert.Equal("\"C:\\Windows\\notepad.exe\" --open-dsh", command);
        }
        finally
        {
            ProtocolRegistration.Unregister(scheme);
        }
    }

    [Fact]
    public void StartupRegistration_RoundTrips()
    {
        if (!OperatingSystem.IsWindows()) return;

        var valueName = "DSHNotchTest-" + Guid.NewGuid().ToString("N")[..8];
        try
        {
            Assert.True(StartupRegistration.SetEnabled(true, @"C:\Windows\notepad.exe", valueName));
            Assert.Contains("notepad.exe", StartupRegistration.GetCommand(valueName));

            Assert.True(StartupRegistration.SetEnabled(false, valueName: valueName));
            Assert.Null(StartupRegistration.GetCommand(valueName));
        }
        finally
        {
            StartupRegistration.SetEnabled(false, valueName: valueName);
        }
    }

    [Fact]
    public void DshLocator_UsesConfiguredPathWhenItExists()
    {
        var file = Path.Combine(Path.GetTempPath(), "dshnotch-dsh-" + Guid.NewGuid().ToString("N") + ".exe");
        File.WriteAllText(file, string.Empty);
        try
        {
            var settings = new Settings { DshExecutablePath = file };

            Assert.Equal(file, DshLocator.Find(settings));
        }
        finally
        {
            File.Delete(file);
        }
    }
}
