using System.Text.Json;
using System.Text.Json.Nodes;

namespace DarkPrinceVpn.Core;

/// <summary>
/// Сборка конфигурации Xray-core. В отличие от мобильных версий здесь два
/// локальных входа: SOCKS для режима TUN и HTTP для системного прокси —
/// Windows умеет ходить через прокси только по HTTP-протоколу настройки.
/// </summary>
public static class XrayConfigBuilder
{
    public const int SocksPort = 10808;
    public const int HttpPort = 10809;

    public static string Build(ProxyProfile profile)
    {
        if (profile.RawConfig is { } raw)
        {
            var merged = BuildFromRawConfig(raw);
            if (merged is not null) return merged;
        }
        return BuildFromParsedProfile(profile);
    }

    /// <summary>
    /// Подписка в формате Xray JSON: конфиг панели используется как есть —
    /// роутинг, правила и балансировщики сохраняются. Подменяем только
    /// inbounds на локальные и включаем статистику, если её нет.
    /// </summary>
    private static string? BuildFromRawConfig(string raw)
    {
        JsonNode? node;
        try
        {
            node = JsonNode.Parse(raw);
        }
        catch (JsonException)
        {
            return null;
        }
        if (node is not JsonObject config) return null;

        config["inbounds"] = new JsonArray(SocksInbound(), HttpInbound());
        config["stats"] ??= new JsonObject();
        config["policy"] ??= new JsonObject
        {
            ["system"] = new JsonObject
            {
                ["statsOutboundUplink"] = true,
                ["statsOutboundDownlink"] = true,
            },
        };
        config["log"] ??= new JsonObject { ["loglevel"] = "warning" };

        return config.ToJsonString();
    }

    private static JsonObject SocksInbound() => new()
    {
        ["tag"] = "socks",
        ["listen"] = "127.0.0.1",
        ["port"] = SocksPort,
        ["protocol"] = "socks",
        ["settings"] = new JsonObject
        {
            ["auth"] = "noauth",
            ["udp"] = true,
        },
        ["sniffing"] = new JsonObject
        {
            ["enabled"] = true,
            ["destOverride"] = new JsonArray("http", "tls"),
            ["routeOnly"] = false,
        },
    };

    private static JsonObject HttpInbound() => new()
    {
        ["tag"] = "http",
        ["listen"] = "127.0.0.1",
        ["port"] = HttpPort,
        ["protocol"] = "http",
        ["settings"] = new JsonObject(),
        ["sniffing"] = new JsonObject
        {
            ["enabled"] = true,
            ["destOverride"] = new JsonArray("http", "tls"),
            ["routeOnly"] = false,
        },
    };

    private static string BuildFromParsedProfile(ProxyProfile profile)
    {
        var config = new JsonObject
        {
            ["log"] = new JsonObject { ["loglevel"] = "warning" },
            ["stats"] = new JsonObject(),
            ["policy"] = new JsonObject
            {
                ["system"] = new JsonObject
                {
                    ["statsOutboundUplink"] = true,
                    ["statsOutboundDownlink"] = true,
                },
            },
            ["dns"] = new JsonObject
            {
                ["servers"] = new JsonArray("1.1.1.1", "8.8.8.8"),
            },
            ["inbounds"] = new JsonArray(SocksInbound(), HttpInbound()),
            ["outbounds"] = new JsonArray(
                BuildOutbound(profile),
                new JsonObject
                {
                    ["tag"] = "direct",
                    ["protocol"] = "freedom",
                    ["settings"] = new JsonObject(),
                },
                new JsonObject
                {
                    ["tag"] = "block",
                    ["protocol"] = "blackhole",
                    ["settings"] = new JsonObject(),
                }),
            ["routing"] = new JsonObject
            {
                ["domainStrategy"] = "IPIfNonMatch",
                ["rules"] = new JsonArray(new JsonObject
                {
                    ["type"] = "field",
                    ["ip"] = new JsonArray(
                        "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
                        "127.0.0.0/8", "169.254.0.0/16", "100.64.0.0/10"),
                    ["outboundTag"] = "direct",
                }),
            },
        };
        return config.ToJsonString();
    }

    private static JsonObject BuildOutbound(ProxyProfile p)
    {
        var outbound = new JsonObject { ["tag"] = "proxy" };

        switch (p.Protocol)
        {
            case ProxyProtocol.Vless:
            {
                var user = new JsonObject
                {
                    ["id"] = p.UserId,
                    ["encryption"] = p.Encryption ?? "none",
                    ["level"] = 8,
                };
                if (p.Flow is { } flow) user["flow"] = flow;
                outbound["protocol"] = "vless";
                outbound["settings"] = new JsonObject
                {
                    ["vnext"] = new JsonArray(new JsonObject
                    {
                        ["address"] = p.Address,
                        ["port"] = p.Port,
                        ["users"] = new JsonArray(user),
                    }),
                };
                break;
            }
            case ProxyProtocol.Vmess:
            {
                outbound["protocol"] = "vmess";
                outbound["settings"] = new JsonObject
                {
                    ["vnext"] = new JsonArray(new JsonObject
                    {
                        ["address"] = p.Address,
                        ["port"] = p.Port,
                        ["users"] = new JsonArray(new JsonObject
                        {
                            ["id"] = p.UserId,
                            ["security"] = p.VmessSecurity,
                            ["alterId"] = 0,
                            ["level"] = 8,
                        }),
                    }),
                };
                break;
            }
            case ProxyProtocol.Trojan:
            {
                outbound["protocol"] = "trojan";
                outbound["settings"] = new JsonObject
                {
                    ["servers"] = new JsonArray(new JsonObject
                    {
                        ["address"] = p.Address,
                        ["port"] = p.Port,
                        ["password"] = p.UserId,
                        ["level"] = 8,
                    }),
                };
                break;
            }
            case ProxyProtocol.Shadowsocks:
            {
                outbound["protocol"] = "shadowsocks";
                outbound["settings"] = new JsonObject
                {
                    ["servers"] = new JsonArray(new JsonObject
                    {
                        ["address"] = p.Address,
                        ["port"] = p.Port,
                        ["method"] = p.Encryption ?? "aes-256-gcm",
                        ["password"] = p.UserId,
                        ["level"] = 8,
                    }),
                };
                break;
            }
        }

        outbound["streamSettings"] = BuildStreamSettings(p);
        outbound["mux"] = new JsonObject { ["enabled"] = false };
        return outbound;
    }

    private static JsonObject BuildStreamSettings(ProxyProfile p)
    {
        var stream = new JsonObject
        {
            ["network"] = p.Network,
            ["security"] = p.Security,
        };

        switch (p.Security)
        {
            case "tls":
            {
                var tls = new JsonObject
                {
                    ["serverName"] = p.Sni ?? p.Host ?? p.Address,
                    ["allowInsecure"] = p.AllowInsecure,
                };
                if (p.Fingerprint is { } fingerprint) tls["fingerprint"] = fingerprint;
                if (p.Alpn is { } alpn)
                {
                    var list = new JsonArray();
                    foreach (var item in alpn.Split(',')) list.Add(item.Trim());
                    tls["alpn"] = list;
                }
                stream["tlsSettings"] = tls;
                break;
            }
            case "reality":
                stream["realitySettings"] = new JsonObject
                {
                    ["serverName"] = p.Sni ?? "",
                    ["fingerprint"] = p.Fingerprint ?? "chrome",
                    ["publicKey"] = p.PublicKey ?? "",
                    ["shortId"] = p.ShortId ?? "",
                    ["spiderX"] = p.SpiderX ?? "",
                };
                break;
        }

        switch (p.Network)
        {
            case "ws":
            {
                var ws = new JsonObject { ["path"] = p.Path ?? "/" };
                if (p.Host is { } host)
                {
                    ws["headers"] = new JsonObject { ["Host"] = host };
                }
                stream["wsSettings"] = ws;
                break;
            }
            case "grpc":
                stream["grpcSettings"] = new JsonObject
                {
                    ["serviceName"] = p.ServiceName ?? "",
                    ["multiMode"] = p.GrpcMultiMode,
                };
                break;
            case "httpupgrade":
            {
                var settings = new JsonObject { ["path"] = p.Path ?? "/" };
                if (p.Host is { } host) settings["host"] = host;
                stream["httpupgradeSettings"] = settings;
                break;
            }
            case "xhttp":
            {
                var settings = new JsonObject { ["path"] = p.Path ?? "/" };
                if (p.Host is { } host) settings["host"] = host;
                stream["xhttpSettings"] = settings;
                break;
            }
            case "tcp" when p.HeaderType == "http":
                stream["tcpSettings"] = new JsonObject
                {
                    ["header"] = new JsonObject
                    {
                        ["type"] = "http",
                        ["request"] = new JsonObject
                        {
                            ["path"] = new JsonArray(p.Path ?? "/"),
                            ["headers"] = new JsonObject
                            {
                                ["Host"] = new JsonArray(p.Host ?? ""),
                            },
                        },
                    },
                };
                break;
        }

        return stream;
    }
}
