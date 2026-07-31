using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using DarkPrinceVpn.Vpn;

namespace DarkPrinceVpn.Data;

/// <summary>
/// Настройки, кэш подписки и токены. Токены шифруются средствами Windows
/// (DPAPI) и привязываются к учётной записи: файл, скопированный на другой
/// компьютер, расшифровать не выйдет.
/// </summary>
public sealed class AppStore
{
    public static AppStore Shared { get; } = new();

    private readonly string _settingsPath;
    private readonly string _tokensPath;
    private Settings _settings;

    private AppStore()
    {
        Directory.CreateDirectory(AppPaths.DataDirectory);
        _settingsPath = Path.Combine(AppPaths.DataDirectory, "settings.json");
        _tokensPath = Path.Combine(AppPaths.DataDirectory, "session.bin");
        _settings = Load();
    }

    private sealed class Settings
    {
        public string BaseUrl { get; set; } = "https://cabinet.darkprincepanel.ru";
        public string Hwid { get; set; } = "";
        public long? SelectedSubscriptionId { get; set; }
        public string? UserJson { get; set; }
        public bool TunMode { get; set; }
        public Dictionary<string, string> ServersRaw { get; set; } = new();
        public Dictionary<string, string> SubUrls { get; set; } = new();
        public Dictionary<string, int> SelectedServer { get; set; } = new();
    }

    private sealed class Session
    {
        public string? AccessToken { get; set; }
        public string? RefreshToken { get; set; }
        public long ExpiresAtUnix { get; set; }
    }

    private Session _session = new();

    // MARK: настройки

    public string BaseUrl
    {
        get => _settings.BaseUrl;
        set { _settings.BaseUrl = value.TrimEnd('/'); Save(); }
    }

    /// <summary>
    /// Идентификатор этого компьютера для учёта в панели. Живёт в настройках,
    /// один на установку — переустановка приложения не должна съедать ещё
    /// одно место в лимите устройств.
    /// </summary>
    public string Hwid
    {
        get
        {
            if (string.IsNullOrEmpty(_settings.Hwid))
            {
                _settings.Hwid = Guid.NewGuid().ToString();
                Save();
            }
            return _settings.Hwid;
        }
    }

    public long? SelectedSubscriptionId
    {
        get => _settings.SelectedSubscriptionId;
        set { _settings.SelectedSubscriptionId = value; Save(); }
    }

    public bool TunMode
    {
        get => _settings.TunMode;
        set { _settings.TunMode = value; Save(); }
    }

    public UserDto? User
    {
        get
        {
            if (_settings.UserJson is not { } json) return null;
            try
            {
                return JsonSerializer.Deserialize<UserDto>(json);
            }
            catch (JsonException)
            {
                return null;
            }
        }
        set
        {
            _settings.UserJson = value is null ? null : JsonSerializer.Serialize(value);
            Save();
        }
    }

    // Данные каждой подписки лежат отдельно, поэтому переключение между
    // тарифами ничего не теряет и работает без сети.

    private static string Key(long? id) => id?.ToString() ?? "default";

    public string? ServersRaw(long? id) =>
        _settings.ServersRaw.TryGetValue(Key(id), out var value) ? value : null;

    public void SetServersRaw(long? id, string? raw)
    {
        if (raw is null) _settings.ServersRaw.Remove(Key(id));
        else _settings.ServersRaw[Key(id)] = raw;
        Save();
    }

    public string? SubUrl(long? id) =>
        _settings.SubUrls.TryGetValue(Key(id), out var value) ? value : null;

    public void SetSubUrl(long? id, string? url)
    {
        if (url is null) _settings.SubUrls.Remove(Key(id));
        else _settings.SubUrls[Key(id)] = url;
        Save();
    }

    public int SelectedServer(long? id) =>
        _settings.SelectedServer.TryGetValue(Key(id), out var value) ? value : 0;

    public void SetSelectedServer(long? id, int index)
    {
        _settings.SelectedServer[Key(id)] = index;
        Save();
    }

    // MARK: сессия

    public string? AccessToken
    {
        get => _session.AccessToken;
        set { _session.AccessToken = value; SaveSession(); }
    }

    public string? RefreshToken
    {
        get => _session.RefreshToken;
        set { _session.RefreshToken = value; SaveSession(); }
    }

    public DateTimeOffset? AccessExpiresAt
    {
        get => _session.ExpiresAtUnix > 0
            ? DateTimeOffset.FromUnixTimeSeconds(_session.ExpiresAtUnix)
            : null;
        set
        {
            _session.ExpiresAtUnix = value?.ToUnixTimeSeconds() ?? 0;
            SaveSession();
        }
    }

    public bool IsLoggedIn => !string.IsNullOrEmpty(_session.RefreshToken);

    public void ClearSession()
    {
        _session = new Session();
        SaveSession();
        User = null;
    }

    // MARK: хранение

    private Settings Load()
    {
        try
        {
            if (File.Exists(_settingsPath))
            {
                var loaded = JsonSerializer.Deserialize<Settings>(File.ReadAllText(_settingsPath));
                if (loaded is not null) _settings = loaded;
            }
        }
        catch (Exception)
        {
            // повреждённые настройки не должны мешать запуску
        }
        _settings ??= new Settings();

        try
        {
            if (File.Exists(_tokensPath))
            {
                var encrypted = File.ReadAllBytes(_tokensPath);
                var plain = ProtectedData.Unprotect(encrypted, null, DataProtectionScope.CurrentUser);
                _session = JsonSerializer.Deserialize<Session>(Encoding.UTF8.GetString(plain))
                           ?? new Session();
            }
        }
        catch (Exception)
        {
            // файл сессии с чужого компьютера или битый — начинаем с чистой
            _session = new Session();
        }

        return _settings;
    }

    private void Save()
    {
        try
        {
            File.WriteAllText(_settingsPath, JsonSerializer.Serialize(_settings));
        }
        catch (IOException)
        {
        }
    }

    private void SaveSession()
    {
        try
        {
            var plain = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(_session));
            var encrypted = ProtectedData.Protect(plain, null, DataProtectionScope.CurrentUser);
            File.WriteAllBytes(_tokensPath, encrypted);
        }
        catch (Exception)
        {
        }
    }
}
