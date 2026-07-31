using System.IO;
using System.Threading;
using System.Windows;
using DarkPrinceVpn.Vpn;

namespace DarkPrinceVpn;

public partial class App : Application
{
    /// <summary>
    /// Одно приложение на пользователя. Два экземпляра не поделят локальные
    /// порты ядра и одни настройки, а второй запуск обычно означает, что про
    /// первый просто забыли.
    /// </summary>
    private static Mutex? _instanceLock;

    protected override void OnStartup(StartupEventArgs e)
    {
        // ловим всё: без этого любая ошибка на старте закрывает процесс
        // молча, и снаружи это выглядит как «приложение не запускается»
        DispatcherUnhandledException += (_, args) =>
        {
            Report(args.Exception, "Ошибка в приложении");
            args.Handled = true;

            // если окно так и не появилось, продолжать нечего: без него
            // приложение осталось бы работать невидимым процессом
            if (MainWindow is not { IsVisible: true }) Shutdown();
        };
        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
        {
            if (args.ExceptionObject is Exception error) Report(error, "Ошибка в приложении");
        };
        System.Threading.Tasks.TaskScheduler.UnobservedTaskException += (_, args) =>
        {
            Log("Фоновая задача: " + args.Exception);
            args.SetObserved();
        };

        _instanceLock = new Mutex(true, @"Local\DarkPrinceVPN", out var first);
        if (!first)
        {
            MessageBox.Show(
                "DarkPrince VPN уже запущен. Если окна нет, снимите задачу " +
                "DarkPrinceVPN в диспетчере задач и запустите приложение снова.",
                "DarkPrince VPN", MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown();
            return;
        }

        Log($"Запуск. Версия {typeof(App).Assembly.GetName().Version}, " +
            $"каталог {AppContext.BaseDirectory}");

        base.OnStartup(e);
    }

    /// <summary>Показать ошибку человеку и оставить след в журнале.</summary>
    private static void Report(Exception error, string title)
    {
        Log(error.ToString());
        try
        {
            MessageBox.Show(
                $"{error.Message}{Environment.NewLine}{Environment.NewLine}" +
                $"Подробности записаны в {LogPath}",
                title, MessageBoxButton.OK, MessageBoxImage.Error);
        }
        catch (Exception)
        {
            // если даже окно показать не вышло, запись в журнале уже есть
        }
    }

    private static string LogPath => Path.Combine(AppPaths.DataDirectory, "app.log");

    private static void Log(string message)
    {
        try
        {
            Directory.CreateDirectory(AppPaths.DataDirectory);
            File.AppendAllText(
                LogPath,
                $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {message}{Environment.NewLine}");
        }
        catch (Exception)
        {
        }
    }
}
