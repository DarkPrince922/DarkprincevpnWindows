using System.ComponentModel;
using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using DarkPrinceVpn.Core;
using DarkPrinceVpn.Data;
using DarkPrinceVpn.Ui;
using DarkPrinceVpn.Vpn;

namespace DarkPrinceVpn;

public partial class MainWindow : Window
{
    private readonly VpnController _vpn = new();
    private readonly AppStore _store = AppStore.Shared;
    private readonly AuthRepository _auth = AuthRepository.Shared;
    private readonly SubscriptionRepository _subscriptions = SubscriptionRepository.Shared;

    private readonly List<ProxyProfile> _servers = new();
    private List<SubscriptionListItem> _subscriptionList = new();
    private ProxyProfile? _selected;
    private bool _registerMode;
    private CancellationTokenSource? _telegramPolling;
    private bool _updatingPicker;
    private bool _closing;

    public MainWindow()
    {
        InitializeComponent();
        // рамка окна по умолчанию светлая и выбивается из тёмного оформления
        DarkTitleBar.Apply(this, Color.FromRgb(0x0A, 0x0E, 0x17));

        _vpn.Changed += () => Dispatcher.Invoke(RenderVpn);
        Closing += OnClosing;

        ModeTun.IsChecked = _store.TunMode;
        ModeProxy.IsChecked = !_store.TunMode;

        if (_auth.IsLoggedIn) ShowMain();
        RenderVpn();

        // следы прошлого запуска, если его завершили жёстко
        if (TunManager.IsElevated()) Task.Run(TunManager.ClearStaleState);
    }

    /// <summary>
    /// Закрытие окна. Снятие туннеля — это вызовы route и netsh, каждый из
    /// которых может думать секунды; на потоке интерфейса окно бы зависло, а
    /// без ограничения по времени задача осталась бы висеть в диспетчере.
    /// Поэтому окно прячем сразу, работу делаем фоном и в любом случае
    /// выходим.
    /// </summary>
    private void OnClosing(object? sender, CancelEventArgs e)
    {
        if (_closing) return;
        _closing = true;
        _telegramPolling?.Cancel();

        e.Cancel = true;
        Hide();

        var teardown = Task.Run(() =>
        {
            try
            {
                _vpn.Dispose();
            }
            catch (Exception)
            {
            }
        });

        _ = Task.WhenAny(teardown, Task.Delay(TimeSpan.FromSeconds(10)))
            .ContinueWith(_ => Environment.Exit(0));
    }

    // ================= Вход =================

    private void OnToggleRegister(object sender, RoutedEventArgs e)
    {
        _registerMode = !_registerMode;
        LoginTitle.Text = _registerMode ? "Регистрация" : "Вход";
        EmailButton.Content = _registerMode ? "Зарегистрироваться" : "Войти";
        ToggleRegisterButton.Content = _registerMode
            ? "Уже есть аккаунт? Войти"
            : "Нет аккаунта? Зарегистрируйтесь";
        var referralVisibility = _registerMode ? Visibility.Visible : Visibility.Collapsed;
        ReferralBox.Visibility = referralVisibility;
        ReferralLabel.Visibility = referralVisibility;
        ForgotButton.Visibility = _registerMode ? Visibility.Collapsed : Visibility.Visible;
    }

    private async void OnEmailSubmit(object sender, RoutedEventArgs e)
    {
        var email = EmailBox.Text.Trim();
        var password = PasswordBox.Password;
        if (!email.Contains('@') || password.Length < 6)
        {
            LoginError.Text = "Введите почту и пароль не короче шести символов.";
            return;
        }

        EmailButton.IsEnabled = false;
        LoginError.Text = "";
        LoginMessage.Text = "";
        try
        {
            if (_registerMode)
            {
                var (success, message) = await _auth.EmailRegisterAsync(
                    email, password, ReferralBox.Text);
                if (success && _auth.IsLoggedIn) ShowMain();
                else if (success) LoginMessage.Text = message;
                else LoginError.Text = message;
            }
            else
            {
                var failure = await _auth.EmailLoginAsync(email, password);
                if (failure is null) ShowMain();
                else LoginError.Text = failure;
            }
        }
        finally
        {
            EmailButton.IsEnabled = true;
        }
    }

    private async void OnForgotPassword(object sender, RoutedEventArgs e)
    {
        var email = EmailBox.Text.Trim();
        if (!email.Contains('@'))
        {
            LoginError.Text = "Укажите почту, на которую отправить письмо.";
            return;
        }
        await _auth.ForgotPasswordAsync(email);
        LoginMessage.Text = "Если такой e-mail зарегистрирован, мы отправили письмо для сброса пароля.";
    }

    private void OnTelegramLogin(object sender, RoutedEventArgs e)
    {
        _telegramPolling?.Cancel();
        _telegramPolling = new CancellationTokenSource();
        var token = _telegramPolling.Token;

        TelegramButton.IsEnabled = false;
        LoginError.Text = "";
        LoginMessage.Text = "Открываем Telegram…";

        _ = _auth.TelegramDeepLinkAsync(update => Dispatcher.Invoke(() =>
        {
            switch (update)
            {
                case DeepLinkAuthEvent.OpenTelegram open:
                    // на компьютере надёжнее вести через t.me: у части
                    // пользователей Telegram не установлен как приложение
                    OpenExternal(open.WebUri);
                    LoginMessage.Text = "Откройте Telegram и нажмите «Start», ждём подтверждения…";
                    break;
                case DeepLinkAuthEvent.Success:
                    TelegramButton.IsEnabled = true;
                    ShowMain();
                    break;
                case DeepLinkAuthEvent.Failed failed:
                    TelegramButton.IsEnabled = true;
                    LoginMessage.Text = "";
                    LoginError.Text = failed.Message;
                    break;
            }
        }), token);
    }

    private static void OpenExternal(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
        }
        catch (Exception)
        {
        }
    }

    // ================= Основное окно =================

    private async void ShowMain()
    {
        LoginPanel.Visibility = Visibility.Collapsed;
        MainPanel.Visibility = Visibility.Visible;
        AccountText.Text = _auth.CurrentUser?.DisplayName ?? "—";
        await RefreshAllAsync();
    }

    private async Task RefreshAllAsync()
    {
        StatusBar.Text = "Загружаю данные кабинета…";
        // сохранённая подписка показывается сразу, до всякой сети
        if (_subscriptions.CachedServers(_store.SelectedSubscriptionId) is { } cached)
        {
            ShowServers(cached);
        }

        _subscriptionList = await _subscriptions.SubscriptionsAsync();
        _updatingPicker = true;
        SubscriptionPicker.ItemsSource = _subscriptionList;
        SubscriptionPicker.Visibility = _subscriptionList.Count > 1
            ? Visibility.Visible
            : Visibility.Collapsed;
        var current = _subscriptionList.FirstOrDefault(item => item.Id == _store.SelectedSubscriptionId)
                      ?? _subscriptionList.FirstOrDefault(item => item.IsActive)
                      ?? _subscriptionList.FirstOrDefault();
        if (current is not null)
        {
            _store.SelectedSubscriptionId = current.Id;
            SubscriptionPicker.SelectedItem = current;
        }
        _updatingPicker = false;

        await LoadServersAsync(force: true);
        RenderSubscription(current);
        await LoadExtrasAsync();
        StatusBar.Text = "";
    }

    private async Task LoadServersAsync(bool force)
    {
        try
        {
            ShowServers(await _subscriptions.FetchServersAsync(force));
            HomeError.Text = "";
        }
        catch (Exception error)
        {
            if (_servers.Count == 0) HomeError.Text = error.Message;
        }
    }

    private void ShowServers(List<ProxyProfile> servers)
    {
        _servers.Clear();
        _servers.AddRange(servers);
        ServerList.ItemsSource = null;
        ServerList.ItemsSource = _servers;

        var index = _store.SelectedServer(_store.SelectedSubscriptionId);
        if (index >= _servers.Count) index = 0;
        if (_servers.Count > 0)
        {
            ServerList.SelectedIndex = index;
            _selected = _servers[index];
        }
        RenderVpn();
    }

    private void RenderSubscription(SubscriptionListItem? current)
    {
        SubscriptionTitle.Text = current?.DisplayName ?? "Подписка";

        var parts = new List<string>();
        if (current?.EndDate is { } endDate && DateTime.TryParse(endDate[..Math.Min(10, endDate.Length)], out var parsed))
        {
            var days = Math.Max(0, (parsed.Date - DateTime.Today).Days);
            parts.Add($"Осталось {days} дн.");
        }
        if (current?.TrafficUsedGb is { } used)
        {
            // ноль в лимите означает безлимит, а не «нисколько»
            var limit = current.TrafficLimitGb is { } value && value > 0
                ? $"{value:F0} ГБ"
                : "∞";
            parts.Add($"Трафик: {used:F1} ГБ / {limit}");
        }
        if (current?.DeviceLimit is { } deviceLimit) parts.Add($"Устройств: {deviceLimit}");
        SubscriptionDetails.Text = parts.Count > 0 ? string.Join("   ", parts) : "";
    }

    private async void OnSubscriptionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_updatingPicker) return;
        if (SubscriptionPicker.SelectedItem is not SubscriptionListItem item) return;

        _store.SelectedSubscriptionId = item.Id;
        if (_vpn.State != VpnState.Disconnected) await _vpn.DisconnectAsync();

        if (_subscriptions.CachedServers(item.Id) is { } cached) ShowServers(cached);
        await LoadServersAsync(force: true);
        RenderSubscription(item);
    }

    private async void OnRefreshServers(object sender, RoutedEventArgs e)
    {
        StatusBar.Text = "Обновляю подписку…";
        await LoadServersAsync(force: true);
        StatusBar.Text = "";
    }

    private async void OnServerSelected(object sender, SelectionChangedEventArgs e)
    {
        if (ServerList.SelectedItem is not ProxyProfile profile) return;
        _selected = profile;
        _store.SetSelectedServer(_store.SelectedSubscriptionId, ServerList.SelectedIndex);
        RenderVpn();
        // при поднятом туннеле сразу переключаемся на выбранный узел
        if (_vpn.State != VpnState.Disconnected) await _vpn.SwitchServerAsync(profile);
    }

    // ================= Подключение =================

    private async void OnPowerClick(object sender, RoutedEventArgs e)
    {
        if (_vpn.IsBusy) return;

        if (_vpn.State != VpnState.Disconnected)
        {
            await _vpn.DisconnectAsync();
            return;
        }

        if (_selected is null)
        {
            HomeError.Text = "Сначала дождитесь загрузки подписки и выберите сервер.";
            return;
        }

        var mode = ModeTun.IsChecked == true ? VpnMode.Tun : VpnMode.Proxy;
        _store.TunMode = mode == VpnMode.Tun;

        if (mode == VpnMode.Tun && !TunManager.IsElevated())
        {
            HomeError.Text =
                "Режим TUN требует прав администратора. Закройте приложение и запустите " +
                "его через «Запуск от имени администратора».";
            return;
        }

        HomeError.Text = "";
        await _vpn.ConnectAsync(_selected, mode);
    }

    private void RenderVpn()
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
                StateText.Text = _vpn.Mode == VpnMode.Tun
                    ? "Поднимаю туннель… это занимает несколько секунд"
                    : "Подключение…";
                PowerIcon.Foreground = muted;
                PowerRing.Stroke = muted;
                break;
            default:
                StateText.Text = _vpn.IsBusy
                    ? "Отключение…"
                    : "Нажмите для подключения";
                PowerIcon.Foreground = muted;
                PowerRing.Stroke = outline;
                break;
        }

        // пока идёт работа, повторные нажатия только запутают состояние
        PowerButton.IsEnabled = !_vpn.IsBusy;

        SelectedServerText.Text = _selected is null
            ? "Сервер не выбран"
            : $"{_selected.Name}\n{_selected.TransportLabel}";

        ModeProxy.IsEnabled = _vpn.State == VpnState.Disconnected;
        ModeTun.IsEnabled = _vpn.State == VpnState.Disconnected;

        if (_vpn.LastError is { } error) HomeError.Text = error;
    }

    // ================= Тарифы, баланс, устройства =================

    private async Task LoadExtrasAsync()
    {
        var balance = await BalanceRepository.Shared.BalanceAsync();
        BalanceText.Text = balance is { } kopeks ? Format.Rubles(kopeks) : "—";

        var referral = await BalanceRepository.Shared.ReferralAsync();
        ReferralText.Text = referral?.ShareLink is { } link
            ? $"{link}\nПриглашено: {referral.TotalReferrals ?? 0}"
            : "Реферальная программа недоступна.";

        DeviceList.ItemsSource = await _subscriptions.DevicesListAsync(_store.SelectedSubscriptionId);

        await LoadPlansAsync();
    }

    private async Task LoadPlansAsync()
    {
        PlansPanel.Children.Clear();
        var tariffs = await _subscriptions.TariffsAsync();
        if (tariffs.Count == 0)
        {
            PlansPanel.Children.Add(new TextBlock
            {
                Text = "Тарифы недоступны.",
                Foreground = (Brush)FindResource("SecondaryTextBrush"),
                FontSize = 12,
            });
            return;
        }

        var owned = _subscriptionList
            .Where(item => item.TariffId is not null)
            .Select(item => item.TariffId!.Value)
            .ToHashSet();

        foreach (var tariff in tariffs)
        {
            var panel = new StackPanel { Margin = new Thickness(0, 0, 0, 14) };
            panel.Children.Add(new TextBlock
            {
                Text = tariff.Name,
                FontSize = 15,
                FontWeight = FontWeights.SemiBold,
                Foreground = (Brush)FindResource("TextBrush"),
            });

            var facts = new List<string>();
            if (tariff.TrafficLimitGb is { } traffic)
            {
                facts.Add(traffic > 0 ? $"{traffic} ГБ" : "Безлимитный трафик");
            }
            // лимит устройств показываем по своей подписке, если тариф куплен
            var limit = _subscriptionList
                .FirstOrDefault(item => item.TariffId == tariff.Id)?.DeviceLimit
                ?? tariff.DeviceLimit;
            if (limit is { } devices) facts.Add($"Устройств: {devices}");
            if (facts.Count > 0)
            {
                panel.Children.Add(new TextBlock
                {
                    Text = string.Join("   ", facts),
                    FontSize = 12,
                    Margin = new Thickness(0, 2, 0, 8),
                    Foreground = (Brush)FindResource("SecondaryTextBrush"),
                });
            }

            var isOwned = owned.Contains(tariff.Id);
            foreach (var period in tariff.Periods)
            {
                var button = new Button
                {
                    Content = $"{(isOwned ? "Продлить" : "Купить")} · {period.Days} дн. · {Format.Rubles(period.PriceKopeks)}",
                    Margin = new Thickness(0, 0, 0, 6),
                };
                var captured = tariff;
                var capturedPeriod = period;
                button.Click += async (_, _) =>
                {
                    button.IsEnabled = false;
                    StatusBar.Text = "Оформляю…";
                    var error = isOwned
                        ? await _subscriptions.RenewAsync(capturedPeriod.Days)
                        : await _subscriptions.PurchaseTariffAsync(captured.Id, capturedPeriod.Days);
                    StatusBar.Text = error ?? "Готово! Обновляю данные…";
                    if (error is null) await RefreshAllAsync();
                    button.IsEnabled = true;
                };
                panel.Children.Add(button);
            }

            PlansPanel.Children.Add(panel);
        }
    }

    private async void OnApplyPromo(object sender, RoutedEventArgs e)
    {
        var code = PromoBox.Text.Trim();
        if (code.Length == 0) return;
        var (success, message) = await BalanceRepository.Shared.ActivatePromoAsync(code);
        BalanceMessage.Text = message;
        if (success) await LoadExtrasAsync();
    }

    private void OnOpenCabinet(object sender, RoutedEventArgs e) =>
        OpenExternal(_store.BaseUrl);

    private async void OnDeleteDevice(object sender, RoutedEventArgs e)
    {
        if (DeviceList.SelectedItem is not DeviceDto device) return;
        var confirm = MessageBox.Show(
            $"Отключить «{device.Title}»? Устройство потеряет доступ и освободит место в лимите.",
            "Отключить устройство", MessageBoxButton.OKCancel, MessageBoxImage.Warning);
        if (confirm != MessageBoxResult.OK) return;

        var error = await _subscriptions.DeleteDeviceAsync(device.Hwid, _store.SelectedSubscriptionId);
        StatusBar.Text = error ?? "Устройство отключено";
        DeviceList.ItemsSource = await _subscriptions.DevicesListAsync(_store.SelectedSubscriptionId);
    }

    private async void OnLogout(object sender, RoutedEventArgs e)
    {
        await _vpn.DisconnectAsync();
        await _auth.LogoutAsync();
        MainPanel.Visibility = Visibility.Collapsed;
        LoginPanel.Visibility = Visibility.Visible;
        EmailBox.Text = "";
        PasswordBox.Password = "";
    }
}

internal static class Format
{
    public static string Rubles(long kopeks)
    {
        var value = kopeks / 100.0;
        return Math.Abs(value - Math.Round(value)) < 0.001
            ? $"{value:F0} ₽"
            : $"{value:F2} ₽";
    }
}
