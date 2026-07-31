using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Web;

namespace DarkPrinceVpn.Core;

/// <summary>
/// Разбор содержимого подписки Remnawave: либо Xray JSON (панель отдаёт его,
/// когда настроены роутинг и балансировщики), либо base64-список ссылок,
/// либо ссылки построчно (vless://, vmess://, trojan://, ss://).
/// </summary>
public static class LinkParser
{
    public static List<ProxyProfile> ParseSubscriptionContent(string content)
    {
        var text = content.Trim();

        if (text.StartsWith('[') || text.StartsWith('{'))
        {
            var fromJson = ParseXrayJsonSubscription(text);
            if (fromJson.Count > 0) return fromJson;
        }

        var looksLikeLinks = text.StartsWith("vless://") || text.StartsWith("vmess://")
            || text.StartsWith("trojan://") || text.StartsWith("ss://");
        var decoded = looksLikeLinks ? text : (TryBase64(text) ?? text);

        var trimmed = decoded.Trim();
        if (trimmed.StartsWith('[') || trimmed.StartsWith('{'))
        {
            var fromJson = ParseXrayJsonSubscription(trimmed);
            if (fromJson.Count > 0) return fromJson;
        }

        return decoded
            .Split('\n', '\r')
            .Select(line => line.Trim())
            .Where(line => line.Length > 0)
            .Select(ParseLink)
            .Where(profile => profile is not null)
            .Select(profile => profile!)
            .ToList();
    }

    /// <summary>
    /// Каждый элемент — полный конфиг Xray (remarks, outbounds, routing,
    /// balancers…). Конфиг сохраняется целиком; имя, адрес, протокол и
    /// транспорт достаются из первого прокси-аутбаунда только для показа.
    /// </summary>
    public static List<ProxyProfile> ParseXrayJsonSubscription(string text)
    {
        var result = new List<ProxyProfile>();
        try
        {
            using var document = JsonDocument.Parse(text);
            var configs = new List<JsonElement>();

            if (document.RootElement.ValueKind == JsonValueKind.Array)
            {
                configs.AddRange(document.RootElement.EnumerateArray()
                    .Where(item => item.ValueKind == JsonValueKind.Object));
            }
            else if (document.RootElement.ValueKind == JsonValueKind.Object
                     && document.RootElement.TryGetProperty("outbounds", out _))
            {
                configs.Add(document.RootElement);
            }

            for (var index = 0; index < configs.Count; index++)
            {
                var config = configs[index];
                if (!config.TryGetProperty("outbounds", out var outbounds)
                    || outbounds.ValueKind != JsonValueKind.Array)
                {
                    continue;
                }

                var protocol = ProxyProtocol.Vless;
                var address = "";
                var port = 443;
                var network = "tcp";
                var security = "none";

                foreach (var outbound in outbounds.EnumerateArray())
                {
                    if (outbound.ValueKind != JsonValueKind.Object) continue;
                    if (!outbound.TryGetProperty("protocol", out var protoElement)) continue;
                    var parsed = ProtocolFrom(protoElement.GetString());
                    if (parsed is null) continue;

                    protocol = parsed.Value;

                    if (outbound.TryGetProperty("settings", out var settings))
                    {
                        var server = FirstServer(settings);
                        if (server is { } serverElement)
                        {
                            address = StringOf(serverElement, "address") ?? address;
                            port = IntOf(serverElement, "port") ?? port;
                        }
                    }

                    if (outbound.TryGetProperty("streamSettings", out var stream))
                    {
                        network = StringOf(stream, "network") ?? network;
                        security = StringOf(stream, "security") ?? security;
                    }
                    break;
                }

                var remarks = StringOf(config, "remarks");
                var name = !string.IsNullOrWhiteSpace(remarks)
                    ? remarks!
                    : (address.Length > 0 ? address : $"Конфиг {index + 1}");

                result.Add(new ProxyProfile
                {
                    Protocol = protocol,
                    Name = name,
                    Address = address.Length > 0 ? address : "-",
                    Port = port,
                    UserId = "",
                    Network = network,
                    Security = security,
                    RawConfig = config.GetRawText(),
                });
            }
        }
        catch (JsonException)
        {
            return new List<ProxyProfile>();
        }
        return result;
    }

    /// <summary>
    /// Все адреса серверов из конфига. Нужны режиму TUN: до этих узлов
    /// прокладываются отдельные маршруты мимо туннеля, иначе трафик ядра
    /// уходит в собственный туннель и соединение зацикливается.
    /// </summary>
    public static List<string> ServerAddresses(ProxyProfile profile)
    {
        if (profile.RawConfig is null)
        {
            return profile.Address is { Length: > 0 } and not "-"
                ? new List<string> { profile.Address }
                : new List<string>();
        }

        var addresses = new List<string>();
        try
        {
            using var document = JsonDocument.Parse(profile.RawConfig);
            if (!document.RootElement.TryGetProperty("outbounds", out var outbounds)
                || outbounds.ValueKind != JsonValueKind.Array)
            {
                return addresses;
            }

            foreach (var outbound in outbounds.EnumerateArray())
            {
                if (outbound.ValueKind != JsonValueKind.Object) continue;
                if (!outbound.TryGetProperty("settings", out var settings)) continue;

                foreach (var key in new[] { "vnext", "servers" })
                {
                    if (!settings.TryGetProperty(key, out var list)
                        || list.ValueKind != JsonValueKind.Array)
                    {
                        continue;
                    }
                    foreach (var server in list.EnumerateArray())
                    {
                        var address = StringOf(server, "address");
                        if (!string.IsNullOrWhiteSpace(address)) addresses.Add(address!);
                    }
                }
            }
        }
        catch (JsonException)
        {
        }
        return addresses.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }

    // MARK: ссылки

    public static ProxyProfile? ParseLink(string link)
    {
        try
        {
            if (link.StartsWith("vless://")) return ParseVless(link);
            if (link.StartsWith("trojan://")) return ParseTrojan(link);
            if (link.StartsWith("vmess://")) return ParseVmess(link);
            if (link.StartsWith("ss://")) return ParseShadowsocks(link);
        }
        catch (Exception)
        {
            return null;
        }
        return null;
    }

    private static ProxyProfile? ParseVless(string link)
    {
        var uri = new Uri(link);
        var query = HttpUtility.ParseQueryString(uri.Query);
        var userId = uri.UserInfo;
        if (string.IsNullOrEmpty(userId)) return null;

        return new ProxyProfile
        {
            Protocol = ProxyProtocol.Vless,
            Name = FragmentName(uri, uri.Host),
            Address = uri.Host,
            Port = uri.Port > 0 ? uri.Port : 443,
            UserId = userId,
            Flow = query["flow"],
            Encryption = query["encryption"] ?? "none",
            Network = query["type"] ?? "tcp",
            Security = query["security"] ?? "none",
            Sni = query["sni"],
            Alpn = query["alpn"],
            Fingerprint = query["fp"],
            AllowInsecure = query["allowInsecure"] is "1" or "true",
            PublicKey = query["pbk"],
            ShortId = query["sid"],
            SpiderX = query["spx"],
            Host = query["host"],
            Path = query["path"],
            ServiceName = query["serviceName"],
            GrpcMultiMode = query["mode"] == "multi",
            HeaderType = query["headerType"],
        };
    }

    private static ProxyProfile? ParseTrojan(string link)
    {
        var uri = new Uri(link);
        var query = HttpUtility.ParseQueryString(uri.Query);
        var password = Uri.UnescapeDataString(uri.UserInfo);
        if (string.IsNullOrEmpty(password)) return null;

        return new ProxyProfile
        {
            Protocol = ProxyProtocol.Trojan,
            Name = FragmentName(uri, uri.Host),
            Address = uri.Host,
            Port = uri.Port > 0 ? uri.Port : 443,
            UserId = password,
            Network = query["type"] ?? "tcp",
            Security = query["security"] ?? "tls",
            Sni = query["sni"],
            Alpn = query["alpn"],
            Fingerprint = query["fp"],
            AllowInsecure = query["allowInsecure"] is "1" or "true",
            Host = query["host"],
            Path = query["path"],
            ServiceName = query["serviceName"],
            GrpcMultiMode = query["mode"] == "multi",
        };
    }

    private static ProxyProfile? ParseVmess(string link)
    {
        var payload = link["vmess://".Length..];
        var decoded = TryBase64(payload);
        if (decoded is null) return null;

        using var document = JsonDocument.Parse(decoded);
        var root = document.RootElement;

        string? Str(string key) => root.TryGetProperty(key, out var value)
            ? value.ValueKind == JsonValueKind.Number ? value.ToString() : value.GetString()
            : null;

        var address = Str("add");
        var id = Str("id");
        if (address is null || id is null) return null;

        var network = Str("net") ?? "tcp";
        return new ProxyProfile
        {
            Protocol = ProxyProtocol.Vmess,
            Name = Str("ps") ?? address,
            Address = address,
            Port = int.TryParse(Str("port"), out var port) ? port : 443,
            UserId = id,
            Network = network,
            Security = Str("tls") == "tls" ? "tls" : "none",
            Sni = Blank(Str("sni")),
            Alpn = Blank(Str("alpn")),
            Fingerprint = Blank(Str("fp")),
            Host = Blank(Str("host")),
            Path = Blank(Str("path")),
            ServiceName = network == "grpc" ? Blank(Str("path")) : null,
            HeaderType = Str("type") is { } type && type != "none" ? Blank(type) : null,
            VmessSecurity = Str("scy") ?? "auto",
        };
    }

    private static ProxyProfile? ParseShadowsocks(string link)
    {
        // Форма 1: ss://base64(method:password)@host:port#name
        try
        {
            var uri = new Uri(link);
            if (!string.IsNullOrEmpty(uri.Host) && !string.IsNullOrEmpty(uri.UserInfo))
            {
                var plain = TryBase64(PadBase64(uri.UserInfo)) ?? uri.UserInfo;
                var parts = plain.Split(':', 2);
                if (parts.Length == 2)
                {
                    return new ProxyProfile
                    {
                        Protocol = ProxyProtocol.Shadowsocks,
                        Name = FragmentName(uri, uri.Host),
                        Address = uri.Host,
                        Port = uri.Port > 0 ? uri.Port : 8388,
                        UserId = parts[1],
                        Encryption = parts[0],
                    };
                }
            }
        }
        catch (UriFormatException)
        {
        }

        // Форма 2: ss://base64(method:password@host:port)#name
        var withoutScheme = link["ss://".Length..];
        var body = withoutScheme.Split('#')[0];
        var decodedBody = TryBase64(PadBase64(body));
        if (decodedBody is null) return null;

        var match = Regex.Match(decodedBody, @"^(.+?):(.+)@(.+):(\d+)$");
        if (!match.Success) return null;

        var fragment = withoutScheme.Contains('#')
            ? Uri.UnescapeDataString(withoutScheme[(withoutScheme.IndexOf('#') + 1)..])
            : null;

        return new ProxyProfile
        {
            Protocol = ProxyProtocol.Shadowsocks,
            Name = string.IsNullOrWhiteSpace(fragment) ? match.Groups[3].Value : fragment!,
            Address = match.Groups[3].Value,
            Port = int.TryParse(match.Groups[4].Value, out var port) ? port : 8388,
            UserId = match.Groups[2].Value,
            Encryption = match.Groups[1].Value,
        };
    }

    // MARK: вспомогательное

    private static ProxyProtocol? ProtocolFrom(string? value) => value switch
    {
        "vless" => ProxyProtocol.Vless,
        "vmess" => ProxyProtocol.Vmess,
        "trojan" => ProxyProtocol.Trojan,
        "shadowsocks" => ProxyProtocol.Shadowsocks,
        _ => null,
    };

    private static JsonElement? FirstServer(JsonElement settings)
    {
        foreach (var key in new[] { "vnext", "servers" })
        {
            if (settings.TryGetProperty(key, out var list)
                && list.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in list.EnumerateArray()) return item;
            }
        }
        return null;
    }

    private static string? StringOf(JsonElement element, string key) =>
        element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(key, out var value)
        && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static int? IntOf(JsonElement element, string key)
    {
        if (element.ValueKind != JsonValueKind.Object) return null;
        if (!element.TryGetProperty(key, out var value)) return null;
        return value.ValueKind switch
        {
            JsonValueKind.Number => value.GetInt32(),
            JsonValueKind.String when int.TryParse(value.GetString(), out var parsed) => parsed,
            _ => null,
        };
    }

    private static string FragmentName(Uri uri, string fallback)
    {
        var fragment = uri.Fragment.TrimStart('#');
        if (string.IsNullOrWhiteSpace(fragment)) return fallback;
        return Uri.UnescapeDataString(fragment);
    }

    private static string? Blank(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value;

    private static string? TryBase64(string text)
    {
        try
        {
            var cleaned = text.Replace("\n", "").Replace("\r", "").Replace(" ", "");
            return Encoding.UTF8.GetString(Convert.FromBase64String(PadBase64(cleaned)));
        }
        catch (FormatException)
        {
            return null;
        }
    }

    private static string PadBase64(string value)
    {
        var cleaned = value.Replace('-', '+').Replace('_', '/');
        var remainder = cleaned.Length % 4;
        return remainder == 0 ? cleaned : cleaned + new string('=', 4 - remainder);
    }
}
