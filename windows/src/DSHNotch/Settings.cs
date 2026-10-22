using System.Text.Json;
using System.Text.Json.Serialization;

namespace DSHNotch;

/// <summary>
/// 用户设置。落在 %APPDATA%\DSHNotch\settings.json，字段名与 docs 中 Windows 一节一致。
/// </summary>
public sealed class Settings
{
    /// <summary>任务结束（kind = turn-end）是否通知，默认开。</summary>
    public bool NotifyTaskDone { get; set; } = true;

    /// <summary>需要用户处理（kind = attention）是否通知，默认开。</summary>
    public bool NotifyAttention { get; set; } = true;

    /// <summary>开机自启（与 HKCU Run 同步）。</summary>
    public bool LaunchAtLogin { get; set; }

    /// <summary>是否已经显示过「已在托盘运行」的首次提示（只提示一次）。</summary>
    public bool TrayIntroShown { get; set; }

    /// <summary>余额低于该值（元）时提醒；0 = 关闭。</summary>
    public double LowBalanceThreshold { get; set; } = 10;

    /// <summary>单次消耗超过该值（元）时提醒；0 = 关闭。</summary>
    public double BurnThreshold { get; set; } = 2;

    /// <summary>手动指定 DSH 可执行文件；为空时按常见安装路径查找。</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? DshExecutablePath { get; set; }

    public static Settings CreateDefault() => new();

    /// <summary>与 Swift NotchSettings 的范围保持一致：余额 0..50，单次消耗 0..20。</summary>
    public void Normalize()
    {
        if (double.IsNaN(LowBalanceThreshold) || double.IsInfinity(LowBalanceThreshold)) LowBalanceThreshold = 10;
        if (double.IsNaN(BurnThreshold) || double.IsInfinity(BurnThreshold)) BurnThreshold = 2;
        LowBalanceThreshold = Math.Clamp(LowBalanceThreshold, 0, 50);
        BurnThreshold = Math.Clamp(BurnThreshold, 0, 20);
        DshExecutablePath = string.IsNullOrWhiteSpace(DshExecutablePath) ? null : DshExecutablePath.Trim();
    }

    public Settings Clone()
    {
        var clone = (Settings)MemberwiseClone();
        clone.Normalize();
        return clone;
    }
}

/// <summary>
/// settings.json 的读写。读失败（缺失/损坏）一律回默认值并写日志：
/// 一个坏掉的设置文件不该让托盘应用起不来。
/// </summary>
public sealed class SettingsStore
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
    };

    private readonly string _path;

    public SettingsStore(string? path = null)
    {
        _path = string.IsNullOrWhiteSpace(path) ? AppPaths.SettingsFile : path;
        Current = Load();
    }

    public string Path => _path;

    public Settings Current { get; private set; }

    public static Settings Load(string path)
    {
        try
        {
            if (!File.Exists(path)) return Settings.CreateDefault();
            var text = File.ReadAllText(path);
            var settings = JsonSerializer.Deserialize<Settings>(text, JsonOptions) ?? Settings.CreateDefault();
            settings.Normalize();
            return settings;
        }
        catch (Exception ex)
        {
            AppLog.Error($"读取设置失败（{path}），使用默认值", ex);
            return Settings.CreateDefault();
        }
    }

    private Settings Load() => Load(_path);

    /// <summary>写盘。先写临时文件再替换，避免进程被杀时留下半截 JSON。</summary>
    public void Save(Settings settings)
    {
        settings.Normalize();
        Current = settings.Clone();
        try
        {
            var directory = System.IO.Path.GetDirectoryName(_path);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            var temp = _path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(settings, JsonOptions));
            if (File.Exists(_path)) File.Replace(temp, _path, null);
            else File.Move(temp, _path);
            AppLog.Write($"设置已保存：{_path}");
        }
        catch (Exception ex)
        {
            AppLog.Error($"保存设置失败（{_path}）", ex);
        }
    }
}
