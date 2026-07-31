using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using DarkPrinceVpn.Core;

namespace DarkPrinceVpn.Vpn;

/// <summary>
/// Режим TUN: виртуальный адаптер забирает весь трафик системы и отдаёт его
/// в локальный SOCKS ядра. В отличие от режима прокси работает для любых
/// программ, включая те, что системные настройки игнорируют.
///
/// Главная тонкость — не зациклить трафик. Сам Xray ходит к серверу через
/// обычную сеть, и если весь трафик уйдёт в туннель, ядро начнёт слать
/// пакеты в собственный туннель. Поэтому до адресов серверов прокладываются
/// отдельные маршруты через физический шлюз, и делать это надо ДО того, как
/// поднят туннель, пока DNS ещё работает напрямую.
///
/// Требует прав администратора: создание адаптера и правка таблицы
/// маршрутов иначе недоступны.
/// </summary>
public sealed class TunManager : IDisposable
{
    private const string AdapterName = "DarkPrinceTun";
    private const string TunAddress = "198.18.0.1";
    private const string TunMask = "255.255.255.0";

    private Process? _process;
    private readonly List<string> _serverRoutes = new();
    private bool _defaultRoutesAdded;
    private string? _gateway;

    public static string ExecutablePath =>
        Path.Combine(AppPaths.CoreDirectory, "tun2socks.exe");

    public bool IsRunning => _process is { HasExited: false };

    public void Start(ProxyProfile profile)
    {
        if (!File.Exists(ExecutablePath))
        {
            throw new FileNotFoundException(
                $"Не найден мост tun2socks: {ExecutablePath}. " +
                "Запустите scripts/fetch-cores.ps1 или переустановите приложение.");
        }
        if (!IsElevated())
        {
            throw new UnauthorizedAccessException(
                "Режим TUN требует запуска от имени администратора.");
        }

        var (gateway, _) = FindDefaultRoute()
            ?? throw new InvalidOperationException(
                "Не удалось определить основной шлюз — проверьте подключение к сети.");
        _gateway = gateway;

        // 1. Маршруты до серверов мимо туннеля — пока DNS ещё прямой
        foreach (var ip in ResolveServers(profile))
        {
            if (Run("route", $"add {ip} mask 255.255.255.255 {gateway} metric 1"))
            {
                _serverRoutes.Add(ip);
            }
        }
        if (_serverRoutes.Count == 0)
        {
            throw new InvalidOperationException(
                "Не удалось проложить маршрут до сервера. Без него весь трафик, " +
                "включая трафик самого ядра, ушёл бы в туннель и соединение " +
                "зациклилось бы.");
        }

        // 2. Мост TUN → SOCKS; адаптер создаётся самим tun2socks
        var info = new ProcessStartInfo
        {
            FileName = ExecutablePath,
            Arguments =
                $"-device tun://{AdapterName} " +
                $"-proxy socks5://127.0.0.1:{XrayConfigBuilder.SocksPort} " +
                "-loglevel warning",
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
        };
        _process = new Process { StartInfo = info };
        _process.Start();

        // 3. Адаптер появляется не мгновенно — ждём его и настраиваем
        var adapter = WaitForAdapter(TimeSpan.FromSeconds(12))
            ?? throw new InvalidOperationException(
                "Виртуальный адаптер не появился. Проверьте, что рядом с " +
                "приложением лежит wintun.dll.");

        Run("netsh", $"interface ip set address name=\"{AdapterName}\" " +
                     $"static {TunAddress} {TunMask}");
        Run("netsh", $"interface ip set dns name=\"{AdapterName}\" static 1.1.1.1");
        Run("netsh", $"interface ip add dns name=\"{AdapterName}\" 8.8.8.8 index=2");

        // 4. Две половинки вместо маршрута по умолчанию: так исходный
        //    маршрут остаётся на месте и восстанавливать его не нужно
        var index = adapter.GetIPProperties().GetIPv4Properties().Index;
        _defaultRoutesAdded =
            Run("route", $"add 0.0.0.0 mask 128.0.0.0 {TunAddress} metric 1 if {index}") &&
            Run("route", $"add 128.0.0.0 mask 128.0.0.0 {TunAddress} metric 1 if {index}");

        if (!_defaultRoutesAdded)
        {
            Stop();
            throw new InvalidOperationException(
                "Не удалось направить трафик в туннель — маршруты не добавились.");
        }
    }

    public void Stop()
    {
        if (_defaultRoutesAdded)
        {
            Run("route", $"delete 0.0.0.0 mask 128.0.0.0 {TunAddress}");
            Run("route", $"delete 128.0.0.0 mask 128.0.0.0 {TunAddress}");
            _defaultRoutesAdded = false;
        }

        foreach (var ip in _serverRoutes)
        {
            Run("route", $"delete {ip} mask 255.255.255.255");
        }
        _serverRoutes.Clear();
        _gateway = null;

        if (_process is null) return;
        try
        {
            if (!_process.HasExited)
            {
                _process.Kill(entireProcessTree: true);
                _process.WaitForExit(3000);
            }
        }
        catch (Exception)
        {
        }
        finally
        {
            _process.Dispose();
            _process = null;
        }
    }

    /// <summary>
    /// Адреса всех серверов конфига, приведённые к IP. Панель отдаёт конфиг
    /// с балансировщиком, поэтому серверов может быть несколько — маршрут
    /// нужен до каждого.
    /// </summary>
    private static List<string> ResolveServers(ProxyProfile profile)
    {
        var result = new List<string>();
        foreach (var address in LinkParser.ServerAddresses(profile))
        {
            if (IPAddress.TryParse(address, out var direct))
            {
                if (direct.AddressFamily == AddressFamily.InterNetwork)
                {
                    result.Add(direct.ToString());
                }
                continue;
            }
            try
            {
                var resolved = Dns.GetHostAddresses(address)
                    .Where(ip => ip.AddressFamily == AddressFamily.InterNetwork)
                    .Select(ip => ip.ToString());
                result.AddRange(resolved);
            }
            catch (Exception)
            {
                // домен не разрешился — пропускаем, остальные могут сработать
            }
        }
        return result.Distinct().ToList();
    }

    /// <summary>Шлюз и индекс интерфейса, через который система выходит в сеть.</summary>
    public static (string Gateway, int InterfaceIndex)? FindDefaultRoute()
    {
        foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (nic.OperationalStatus != OperationalStatus.Up) continue;
            if (nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
            if (nic.Name == AdapterName) continue;

            var properties = nic.GetIPProperties();
            var gateway = properties.GatewayAddresses
                .Select(entry => entry.Address)
                .FirstOrDefault(address =>
                    address.AddressFamily == AddressFamily.InterNetwork
                    && !address.Equals(IPAddress.Any));
            if (gateway is null) continue;

            try
            {
                return (gateway.ToString(), properties.GetIPv4Properties().Index);
            }
            catch (NetworkInformationException)
            {
            }
        }
        return null;
    }

    private static NetworkInterface? WaitForAdapter(TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            var adapter = NetworkInterface.GetAllNetworkInterfaces()
                .FirstOrDefault(nic => nic.Name == AdapterName);
            if (adapter is not null) return adapter;
            Thread.Sleep(300);
        }
        return null;
    }

    public static bool IsElevated()
    {
        using var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
        var principal = new System.Security.Principal.WindowsPrincipal(identity);
        return principal.IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
    }

    private static bool Run(string file, string arguments)
    {
        try
        {
            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = file,
                Arguments = arguments,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            });
            if (process is null) return false;
            process.WaitForExit(8000);
            return process.ExitCode == 0;
        }
        catch (Exception)
        {
            return false;
        }
    }

    public void Dispose() => Stop();
}
