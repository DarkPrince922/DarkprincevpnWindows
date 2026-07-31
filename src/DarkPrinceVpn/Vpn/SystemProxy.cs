using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace DarkPrinceVpn.Vpn;

/// <summary>
/// Режим прокси: прописываем локальный HTTP-вход Xray в системные настройки
/// Windows. Прав администратора не требует — параметры лежат в ветке
/// текущего пользователя.
///
/// Через эти настройки ходят браузеры и большинство приложений, но не все:
/// программы с собственным сетевым стеком (часть игр, торренты) их
/// игнорируют. Для них нужен режим TUN.
/// </summary>
public static class SystemProxy
{
    private const string SettingsKey =
        @"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

    private const int InternetOptionSettingsChanged = 39;
    private const int InternetOptionRefresh = 37;

    [DllImport("wininet.dll", SetLastError = true, CharSet = CharSet.Auto)]
    private static extern bool InternetSetOption(
        IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);

    /// <summary>Адреса, которые всегда идут напрямую, минуя прокси.</summary>
    private const string BypassList =
        "localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;" +
        "172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;" +
        "172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>";

    public static void Enable(int httpPort)
    {
        using var key = Registry.CurrentUser.OpenSubKey(SettingsKey, writable: true)
            ?? throw new InvalidOperationException(
                "Не удалось открыть настройки интернета Windows");

        key.SetValue("ProxyEnable", 1, RegistryValueKind.DWord);
        key.SetValue("ProxyServer", $"127.0.0.1:{httpPort}", RegistryValueKind.String);
        key.SetValue("ProxyOverride", BypassList, RegistryValueKind.String);

        Notify();
    }

    public static void Disable()
    {
        using var key = Registry.CurrentUser.OpenSubKey(SettingsKey, writable: true);
        if (key is null) return;

        key.SetValue("ProxyEnable", 0, RegistryValueKind.DWord);
        Notify();
    }

    /// <summary>Включён ли сейчас наш прокси — чтобы не гасить чужой.</summary>
    public static bool IsOurProxyEnabled(int httpPort)
    {
        using var key = Registry.CurrentUser.OpenSubKey(SettingsKey);
        if (key is null) return false;
        if (key.GetValue("ProxyEnable") is not int enabled || enabled == 0) return false;
        return key.GetValue("ProxyServer") as string == $"127.0.0.1:{httpPort}";
    }

    /// <summary>
    /// Без этого Windows подхватит новые настройки только после перезапуска
    /// приложений — записи в реестр самой по себе мало.
    /// </summary>
    private static void Notify()
    {
        InternetSetOption(IntPtr.Zero, InternetOptionSettingsChanged, IntPtr.Zero, 0);
        InternetSetOption(IntPtr.Zero, InternetOptionRefresh, IntPtr.Zero, 0);
    }
}
