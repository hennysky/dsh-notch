using DSHNotch;

namespace DSHNotch.Tests;

public sealed class SettingsTests
{
    private static string TempPath() =>
        Path.Combine(Path.GetTempPath(), "dshnotch-settings-" + Guid.NewGuid().ToString("N"), "settings.json");

    [Fact]
    public void Defaults_MatchDocumentedValues()
    {
        var settings = Settings.CreateDefault();

        Assert.True(settings.NotifyTaskDone);
        Assert.True(settings.NotifyAttention);
        Assert.False(settings.LaunchAtLogin);
        Assert.Equal(10, settings.LowBalanceThreshold);
        Assert.Equal(2, settings.BurnThreshold);
        Assert.Null(settings.DshExecutablePath);
    }

    [Fact]
    public void SaveLoad_RoundTrips()
    {
        var path = TempPath();
        try
        {
            var store = new SettingsStore(path);
            var settings = new Settings
            {
                NotifyTaskDone = false,
                NotifyAttention = false,
                LaunchAtLogin = true,
                LowBalanceThreshold = 5.5,
                BurnThreshold = 3,
                DshExecutablePath = @"C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe",
            };

            store.Save(settings);
            Assert.True(File.Exists(path));

            var reloaded = new SettingsStore(path).Current;
            Assert.False(reloaded.NotifyTaskDone);
            Assert.False(reloaded.NotifyAttention);
            Assert.True(reloaded.LaunchAtLogin);
            Assert.Equal(5.5, reloaded.LowBalanceThreshold);
            Assert.Equal(3, reloaded.BurnThreshold);
            Assert.Equal(settings.DshExecutablePath, reloaded.DshExecutablePath);
        }
        finally
        {
            var directory = Path.GetDirectoryName(path);
            if (directory is not null && Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void Save_WritesCamelCaseFieldNames()
    {
        var path = TempPath();
        try
        {
            new SettingsStore(path).Save(new Settings());
            var json = File.ReadAllText(path);

            Assert.Contains("\"notifyTaskDone\"", json);
            Assert.Contains("\"notifyAttention\"", json);
            Assert.Contains("\"launchAtLogin\"", json);
            Assert.Contains("\"lowBalanceThreshold\"", json);
            Assert.Contains("\"burnThreshold\"", json);
        }
        finally
        {
            var directory = Path.GetDirectoryName(path);
            if (directory is not null && Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void Load_ReturnsDefaults_WhenFileMissing()
    {
        var path = TempPath();
        var settings = new SettingsStore(path).Current;

        Assert.True(settings.NotifyTaskDone);
        Assert.Equal(10, settings.LowBalanceThreshold);
    }

    [Fact]
    public void Load_ReturnsDefaults_WhenFileCorrupt()
    {
        var path = TempPath();
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        try
        {
            File.WriteAllText(path, "{ definite not json");
            var settings = new SettingsStore(path).Current;

            Assert.True(settings.NotifyTaskDone);
            Assert.Equal(2, settings.BurnThreshold);
        }
        finally
        {
            Directory.Delete(Path.GetDirectoryName(path)!, recursive: true);
        }
    }

    [Fact]
    public void Normalize_ClampsThresholdsAndTrimsPath()
    {
        var settings = new Settings
        {
            LowBalanceThreshold = 999,
            BurnThreshold = -5,
            DshExecutablePath = "   ",
        };

        settings.Normalize();

        Assert.Equal(50, settings.LowBalanceThreshold);
        Assert.Equal(0, settings.BurnThreshold);
        Assert.Null(settings.DshExecutablePath);
    }

    [Fact]
    public void Save_ClampsBeforeWriting()
    {
        var path = TempPath();
        try
        {
            new SettingsStore(path).Save(new Settings { LowBalanceThreshold = -3, BurnThreshold = 99 });
            var reloaded = new SettingsStore(path).Current;

            Assert.Equal(0, reloaded.LowBalanceThreshold);
            Assert.Equal(20, reloaded.BurnThreshold);
        }
        finally
        {
            var directory = Path.GetDirectoryName(path);
            if (directory is not null && Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void Clone_IsIndependent()
    {
        var original = new Settings();
        var clone = original.Clone();
        clone.NotifyTaskDone = false;

        Assert.True(original.NotifyTaskDone);
        Assert.False(clone.NotifyTaskDone);
    }
}
