using System.IO;
using System.Net.Http;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using DarkPrinceVpn.Core;
using DarkPrinceVpn.Vpn;

namespace DarkPrinceVpn;

public partial class MainWindow : Window
{
    private readonly VpnController _vpn = new();
    private readonly List<ProxyProfile> _servers = new();
    private ProxyProfile? _selected;

    private static readonly string CachePath =
        Path.Combine(AppPaths.DataDirectory, "subscription.txt");
    private static readonly string UrlPath =
        Path.Combine(AppPaths.DataDirectory, "subscription-url.txt");

    public MainWindow()
    {
        InitializeComponent();
        _vpn.Changed += () => Dispatcher.Invoke(Render);
        Closing += (_, _) => _vpn.Dispose();
        LoadCached();
        Render();
    }

    /// <summary>
    /// Сохранённая подписка показывается сразу, до всякой сети: приложение
    /// открывается с готовым списком серверов даже без интернета.
    /// </summary>
    private void LoadCached()
    {
        try
        {
            if (File.Exists(UrlPath)) SubscriptionUrl.Text = File.ReadAllText(UrlPath).Trim();
            if (!File.Exists(CachePath)) return;
            ShowServers(LinkParser.ParseSubscriptionContent(File.ReadAllText(CachePath)));
        }
        catch (IOException)
        {
        }
    }

    private async void OnLoadClick(object sender, RoutedEventArgs e)
    {
        var url = SubscriptionUrl.Text.Trim();
        if (url.Length == 0)
        {
            ErrorText.Text = "Вставьте ссылку на подписку.";
            return;
        }

        LoadButton.IsEnabled = false;
        ErrorText.Text = "";
        try
        {
            var content = await DownloadSubscription(url);
            var servers = LinkParser.ParseSubscriptionContent(content);
            if (servers.Count == 0)
            {
                ErrorText.Text = "По ссылке не нашлось серверов. Проверьте подписку.";
                return;
            }

            Directory.CreateDirectory(AppPaths.DataDirectory);
            await File.WriteAllTextAsync(CachePath, content);
            await File.WriteAllTextAsync(UrlPath, url);
            ShowServers(servers);
        }
        catch (Exception error)
        {
            ErrorText.Text = $"Не удалось загрузить подписку: {error.Message}";
        }
        finally
        {
            LoadButton.IsEnabled = true;
        }
    }

    /// <summary>
    /// User-Agent v2rayNG заставляет Remnawave отдать конфиги, а не страницу
    /// для браузера.
    /// </summary>
    private static async Task<string> DownloadSubscription(string url)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        client.DefaultRequestHeaders.Add("User-Agent", "v2rayNG/1.10.7");
        client.DefaultRequestHeaders.Add("Accept", "text/plain");
        return await client.GetStringAsync(url);
    }

    private void ShowServers(List<ProxyProfile> servers)
    {
        _servers.Clear();
        _servers.AddRange(servers);
        ServerList.ItemsSource = null;
        ServerList.ItemsSource = _servers;
        if (_servers.Count > 0)
        {
            ServerList.SelectedIndex = 0;
            _selected = _servers[0];
        }
    }

    private void OnServerSelected(object sender, SelectionChangedEventArgs e)
    {
        if (ServerList.SelectedItem is not ProxyProfile profile) return;
        _selected = profile;
        // при поднятом туннеле сразу переключаемся на выбранный узел
        if (_vpn.State != VpnState.Disconnected) _vpn.SwitchServer(profile);
    }

    private void OnPowerClick(object sender, RoutedEventArgs e)
    {
        if (_vpn.State != VpnState.Disconnected)
        {
            _vpn.Disconnect();
            return;
        }

        if (_selected is null)
        {
            ErrorText.Text = "Сначала загрузите подписку и выберите сервер.";
            return;
        }

        var mode = ModeTun.IsChecked == true ? VpnMode.Tun : VpnMode.Proxy;
        if (mode == VpnMode.Tun && !TunManager.IsElevated())
        {
            ErrorText.Text =
                "Режим TUN требует прав администратора. Закройте приложение и " +
                "запустите его через «Запуск от имени администратора».";
            return;
        }

        ErrorText.Text = "";
        _vpn.Connect(_selected, mode);
    }

    private void Render()
    {
        var gold = (Brush)FindResource("GoldBrush");
        var muted = (Brush)FindResource("SecondaryTextBrush");
        var outline = (Brush)FindResource("OutlineBrush");

        switch (_vpn.State)
        {
            case VpnState.Connected:
                StateText.Text = _vpn.Mode == VpnMode.Tun
                    ? "Подключено · весь трафик"
                    : "Подключено · системный прокси";
                PowerIcon.Foreground = gold;
                PowerRing.Stroke = gold;
                break;
            case VpnState.Connecting:
                StateText.Text = "Подключение…";
                PowerIcon.Foreground = muted;
                PowerRing.Stroke = muted;
                break;
            default:
                StateText.Text = "Нажмите для подключения";
                PowerIcon.Foreground = muted;
                PowerRing.Stroke = outline;
                break;
        }

        ModeProxy.IsEnabled = _vpn.State == VpnState.Disconnected;
        ModeTun.IsEnabled = _vpn.State == VpnState.Disconnected;

        if (_vpn.LastError is { } error) ErrorText.Text = error;
    }
}
