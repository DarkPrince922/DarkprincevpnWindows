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
/// </summary>
public sealed class VpnController : IDisposable
{
    private readonly XrayProcess _xray = new();
    private readonly TunManager _tun = new();

    public VpnState State { get; private set; } = VpnState.Disconnected;
    public VpnMode Mode { get; private set; } = VpnMode.Proxy;
    public ProxyProfile? ActiveProfile { get; private set; }
    public string? LastError { get; private set; }

    public event Action? Changed;

    public void Connect(ProxyProfile profile, VpnMode mode)
    {
        Disconnect();

        Mode = mode;
        ActiveProfile = profile;
        LastError = null;
        SetState(VpnState.Connecting);

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

            SetState(VpnState.Connected);
        }
        catch (Exception error)
        {
            LastError = error.Message;
            Disconnect();
        }
    }

    public void Disconnect()
    {
        // системный прокси гасим только свой: пользователь мог настроить
        // собственный, и затирать его чужими руками нельзя
        if (SystemProxy.IsOurProxyEnabled(XrayConfigBuilder.HttpPort))
        {
            try
            {
                SystemProxy.Disable();
            }
            catch (Exception)
            {
            }
        }

        _tun.Stop();
        _xray.Stop();
        SetState(VpnState.Disconnected);
    }

    /// <summary>Мгновенная смена узла: гасим и поднимаем заново тем же режимом.</summary>
    public void SwitchServer(ProxyProfile profile)
    {
        if (State == VpnState.Disconnected)
        {
            ActiveProfile = profile;
            Changed?.Invoke();
            return;
        }
        Connect(profile, Mode);
    }

    public IReadOnlyList<string> CoreLog => _xray.RecentLog;

    private void SetState(VpnState state)
    {
        State = state;
        Changed?.Invoke();
    }

    public void Dispose()
    {
        Disconnect();
        _xray.Dispose();
        _tun.Dispose();
    }
}
