namespace DarkPrinceVpn.Core;

public enum ProxyProtocol
{
    Vless,
    Vmess,
    Trojan,
    Shadowsocks,
}

/// <summary>
/// Один узел из подписки Remnawave. Если панель отдала подписку в формате
/// Xray JSON, полный конфиг лежит в <see cref="RawConfig"/> — тогда роутинг,
/// правила и балансировщики панели сохраняются целиком, а приложение
/// подменяет только inbounds.
/// </summary>
public sealed class ProxyProfile
{
    public ProxyProtocol Protocol { get; init; } = ProxyProtocol.Vless;
    public string Name { get; init; } = "";
    public string Address { get; init; } = "";
    public int Port { get; init; } = 443;

    /// <summary>vless/vmess: uuid; trojan/ss: пароль.</summary>
    public string UserId { get; init; } = "";

    public string? Flow { get; init; }
    public string? Encryption { get; init; }
    public string Network { get; init; } = "tcp";
    public string Security { get; init; } = "none";
    public string? Sni { get; init; }
    public string? Alpn { get; init; }
    public string? Fingerprint { get; init; }
    public bool AllowInsecure { get; init; }
    public string? PublicKey { get; init; }
    public string? ShortId { get; init; }
    public string? SpiderX { get; init; }
    public string? Host { get; init; }
    public string? Path { get; init; }
    public string? ServiceName { get; init; }
    public bool GrpcMultiMode { get; init; }
    public string? HeaderType { get; init; }
    public string VmessSecurity { get; init; } = "auto";
    public string? RawConfig { get; init; }

    /// <summary>
    /// Как узел выглядит в списке: протокол, шифрование и транспорт. Адрес
    /// и домен намеренно не показываем — пользователю они ничего не говорят,
    /// а на скриншоте выдают инфраструктуру.
    /// </summary>
    public string TransportLabel
    {
        get
        {
            var parts = new List<string> { Protocol.ToString().ToLowerInvariant() };
            if (!string.IsNullOrWhiteSpace(Security) && Security != "none") parts.Add(Security);
            parts.Add(NetworkLabel);
            return string.Join(" · ", parts);
        }
    }

    private string NetworkLabel => Network.ToLowerInvariant() switch
    {
        "ws" => "websocket",
        "grpc" => "gRPC",
        "h2" or "http" => "http/2",
        "kcp" => "mkcp",
        "" => "tcp",
        var other => other,
    };
}
