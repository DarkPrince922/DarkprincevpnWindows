using System.Diagnostics;
using System.IO;
using DarkPrinceVpn.Core;

namespace DarkPrinceVpn.Vpn;

/// <summary>
/// Ядро Xray работает отдельным процессом рядом с приложением. Так проще,
/// чем встраивать библиотеку: обновить ядро можно заменой одного файла, а
/// падение ядра не уносит с собой интерфейс.
/// </summary>
public sealed class XrayProcess : IDisposable
{
    private Process? _process;
    private string? _configPath;

    public bool IsRunning => _process is { HasExited: false };

    /// <summary>Последние строки вывода ядра — показываем их при ошибке.</summary>
    public IReadOnlyList<string> RecentLog => _log.ToList();
    private readonly Queue<string> _log = new();
    private const int LogLimit = 200;

    public static string ExecutablePath =>
        Path.Combine(AppPaths.CoreDirectory, "xray.exe");

    public void Start(ProxyProfile profile)
    {
        Stop();

        if (!File.Exists(ExecutablePath))
        {
            throw new FileNotFoundException(
                $"Не найдено ядро Xray: {ExecutablePath}. " +
                "Запустите scripts/fetch-cores.ps1 или переустановите приложение.");
        }

        Directory.CreateDirectory(AppPaths.DataDirectory);
        _configPath = Path.Combine(AppPaths.DataDirectory, "xray-config.json");
        File.WriteAllText(_configPath, XrayConfigBuilder.Build(profile));

        var info = new ProcessStartInfo
        {
            FileName = ExecutablePath,
            Arguments = $"run -c \"{_configPath}\"",
            WorkingDirectory = AppPaths.CoreDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        // ядро ищет geoip.dat и geosite.dat рядом с собой
        info.Environment["XRAY_LOCATION_ASSET"] = AppPaths.CoreDirectory;

        _process = new Process { StartInfo = info, EnableRaisingEvents = true };
        _process.OutputDataReceived += (_, e) => Append(e.Data);
        _process.ErrorDataReceived += (_, e) => Append(e.Data);

        _process.Start();
        _process.BeginOutputReadLine();
        _process.BeginErrorReadLine();

        // ядро падает сразу, если конфиг не принят, — даём ему мгновение
        // и проверяем, чтобы не сообщать об успешном подключении зря
        if (_process.WaitForExit(700))
        {
            var tail = string.Join(Environment.NewLine, RecentLog.TakeLast(5));
            throw new InvalidOperationException(
                $"Ядро завершилось сразу после запуска.{Environment.NewLine}{tail}");
        }
    }

    public void Stop()
    {
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
            // процесс мог завершиться сам, пока мы его закрывали
        }
        finally
        {
            _process.Dispose();
            _process = null;
        }
    }

    private void Append(string? line)
    {
        if (string.IsNullOrWhiteSpace(line)) return;
        lock (_log)
        {
            _log.Enqueue(line);
            while (_log.Count > LogLimit) _log.Dequeue();
        }
    }

    public void Dispose() => Stop();
}

/// <summary>Где приложение держит ядро, настройки и логи.</summary>
public static class AppPaths
{
    /// <summary>Ядро и мост лежат рядом с exe — их ставит установщик.</summary>
    public static string CoreDirectory =>
        Path.Combine(AppContext.BaseDirectory, "core");

    /// <summary>Настройки и кэш подписки — в профиле пользователя.</summary>
    public static string DataDirectory =>
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "DarkPrinceVPN");
}
