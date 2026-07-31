using DarkPrinceVpn.Core;

namespace DarkPrinceVpn.Vpn;

public enum VpnMode
{
    /// <summary>Системный прокси: без прав администратора, но не для всех программ.</summary>
    Proxy,

    /// <summary>Виртуальный адаптер: весь трафик системы, нужны права администратора.</summary>
    Tun,
}

public enum VpnState
{
    Disconnected,
    Connecting,
    Connected,
}

/// <summary>
/// Общий выключатель: поднимает ядро и, в зависимости от режима, либо
/// прописывает системный прокси, либо разворачивает туннель.
///
/// Всё, что здесь происходит, — блокирующее: запуск процессов, разрешение
/// имён, вызовы route и netsh, ожидание появления адаптера. В режиме TUN это
/// легко складывается в десяток секунд, поэтому наружу торчат только
/// асинхронные методы: на потоке интерфейса эта работа превращала окно
/// в белый прямоугольник «программа не отвечает».
/// </summary>
public sealed class VpnController : IDisposable
{
    private readonly XrayProcess _xray = new();
    private readonly TunManager _tun = new();

    /// <summary>Операции не должны накладываться друг на друга.</summary>
    private readonly SemaphoreSlim _gate = new(1, 1);

    public VpnState State { get; private set; } = VpnState.Disconnected;
    public VpnMode Mode { get; private set; } = VpnMode.Proxy;
    public ProxyProfile? ActiveProfile { get; private set; }
    public string? LastError { get; private set; }

    /// <summary>Идёт подключение или отключение — кнопку стоит придержать.</summary>
    public bool IsBusy { get; private set; }

    public event Action? Changed;

    public async Task ConnectAsync(ProxyProfile profile, VpnMode mode)
    {
        await _gate.WaitAsync();
        try
        {
            SetBusy(true);
            Mode = mode;
            ActiveProfile = profile;
            LastError = null;
            SetState(VpnState.Connecting);

            await Task.Run(() =>
            {
                Teardown();
                try
                {
                    _xray.Start(profile);

                    switch (mode)
                    {
                        case VpnMode.Proxy:
                            SystemProxy.Enable(XrayConfigBuilder.HttpPort);
                            break;
                        case VpnMode.Tun:
                            _tun.Start(profile);
                            break;
                    }
                }
                catch (Exception error)
                {
                    LastError = error.Message;
                    Teardown();
                }
            });

            SetState(LastError is null ? VpnState.Connected : VpnState.Disconnected);
        }
        finally
        {
            SetBusy(false);
            _gate.Release();
        }
    }

    public async Task DisconnectAsync()
    {
        await _gate.WaitAsync();
        try
        {
            SetBusy(true);
            await Task.Run(Teardown);
            SetState(VpnState.Disconnected);
        }
        finally
        {
            SetBusy(false);
            _gate.Release();
        }
    }

    /// <summary>Мгновенная смена узла: гасим и поднимаем заново тем же режимом.</summary>
    public async Task SwitchServerAsync(ProxyProfile profile)
    {
        if (State == VpnState.Disconnected)
        {
            ActiveProfile = profile;
            Changed?.Invoke();
            return;
        }
        await ConnectAsync(profile, Mode);
    }

    /// <summary>
    /// Остановка при закрытии окна. Ждать бесконечно нельзя — если ядро
    /// зависло, приложение обязано выйти всё равно, иначе задача останется
    /// висеть в диспетчере.
    /// </summary>
    public void ShutdownBlocking(TimeSpan timeout)
    {
        var worker = Task.Run(Teardown);
        worker.Wait(timeout);
    }

    /// <summary>Снятие всего поднятого. Вызывается только с фонового потока.</summary>
    private void Teardown()
    {
        // системный прокси гасим только свой: пользователь мог настроить
        // собственный, и затирать его чужими руками нельзя
        try
        {
            if (SystemProxy.IsOurProxyEnabled(XrayConfigBuilder.HttpPort))
            {
                SystemProxy.Disable();
            }
        }
        catch (Exception)
        {
        }

        _tun.Stop();
        _xray.Stop();
    }

    public IReadOnlyList<string> CoreLog => _xray.RecentLog;

    private void SetState(VpnState state)
    {
        State = state;
        Changed?.Invoke();
    }

    private void SetBusy(bool busy)
    {
        IsBusy = busy;
        Changed?.Invoke();
    }

    public void Dispose()
    {
        ShutdownBlocking(TimeSpan.FromSeconds(6));
        _xray.Dispose();
        _tun.Dispose();
        _gate.Dispose();
    }
}
