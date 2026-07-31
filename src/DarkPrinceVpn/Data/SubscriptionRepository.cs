using System.Net.Http;
using System.Text.Json;
using DarkPrinceVpn.Core;

namespace DarkPrinceVpn.Data;

public sealed record TariffOffer(
    long Id, string Name, string? Description,
    IReadOnlyList<PeriodPrice> Periods, int? TrafficLimitGb, int? DeviceLimit);

public sealed record PeriodPrice(int Days, long PriceKopeks);

public sealed record DevicesInfo(
    int? DeviceLimit, int? ConnectedCount, long? PricePerDeviceKopeks,
    int? MaxDeviceLimit, bool PurchaseAvailable, bool ReduceAvailable,
    string? PurchaseNote);

public sealed record SubscriptionUserInfo(long Upload, long Download, long Total, long Expire);

public sealed class SubscriptionRepository
{
    public static SubscriptionRepository Shared { get; } = new();

    private readonly ApiClient _api = ApiClient.Shared;
    private readonly AppStore _store = AppStore.Shared;

    private SubscriptionRepository() { }

    public string OwnHwid => _store.Hwid;

    public async Task<SubscriptionStatusResponse?> StatusAsync()
    {
        try
        {
            return await _api.GetAsync<SubscriptionStatusResponse>("cabinet/subscription");
        }
        catch (Exception)
        {
            return null;
        }
    }

    public async Task<List<SubscriptionListItem>> SubscriptionsAsync()
    {
        if (!_store.IsLoggedIn) return new List<SubscriptionListItem>();
        try
        {
            var response = await _api.GetAsync<SubscriptionsListResponse>("cabinet/subscriptions");
            return response.Subscriptions;
        }
        catch (Exception)
        {
            return new List<SubscriptionListItem>();
        }
    }

    /// <summary>Ссылка на подписку: при мультитарифе — выбранной, иначе через кабинет.</summary>
    public async Task<string?> ResolveSubscriptionUrlAsync()
    {
        var selectedId = _store.SelectedSubscriptionId;
        if (selectedId is not null)
        {
            var fromList = (await SubscriptionsAsync())
                .FirstOrDefault(item => item.Id == selectedId)?.SubscriptionUrl;
            if (fromList is not null)
            {
                _store.SetSubUrl(selectedId, fromList);
                return fromList;
            }
            if (_store.SubUrl(selectedId) is { } cached) return cached;
        }

        try
        {
            var link = await _api.GetAsync<ConnectionLinkResponse>("cabinet/subscription/connection-link");
            if (link.SubscriptionUrl is { } url)
            {
                _store.SetSubUrl(null, url);
                return url;
            }
        }
        catch (Exception)
        {
        }

        var status = await StatusAsync();
        var fromStatus = status?.SubscriptionUrl ?? _store.SubUrl(null);
        if (fromStatus is not null) _store.SetSubUrl(null, fromStatus);
        return fromStatus;
    }

    public List<ProxyProfile>? CachedServers(long? subId)
    {
        var raw = _store.ServersRaw(subId);
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var profiles = LinkParser.ParseSubscriptionContent(raw);
        return profiles.Count > 0 ? profiles : null;
    }

    public async Task<List<ProxyProfile>> FetchServersAsync(bool forceRefresh = false)
    {
        var subId = _store.SelectedSubscriptionId;
        if (!forceRefresh && CachedServers(subId) is { } cached) return cached;

        try
        {
            var url = await ResolveSubscriptionUrlAsync()
                ?? throw new ApiException("Нет активной подписки");
            return await DownloadSubscriptionAsync(subId, url);
        }
        catch (Exception)
        {
            // сеть недоступна — работаем с сохранённой копией
            if (CachedServers(subId) is { } fallback) return fallback;
            throw;
        }
    }

    /// <summary>
    /// Скачивает подписку и кладёт в кэш. HWID-заголовки нужны панели, чтобы
    /// считать устройства и применять лимит тарифа: устройство регистрируется
    /// именно в момент загрузки подписки, а не при подключении.
    /// </summary>
    public async Task<List<ProxyProfile>> DownloadSubscriptionAsync(long? subId, string url)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Add("User-Agent", "v2rayNG/1.10.7");
        request.Headers.Add("Accept", "text/plain");
        request.Headers.Add("x-hwid", _store.Hwid);
        request.Headers.Add("x-device-os", "Windows");
        request.Headers.Add("x-ver-os", Environment.OSVersion.Version.ToString());
        request.Headers.Add("x-device-model", Environment.MachineName);

        var response = await client.SendAsync(request);
        if (!response.IsSuccessStatusCode)
        {
            throw new ApiException($"Подписка недоступна (HTTP {(int)response.StatusCode})");
        }

        var body = await response.Content.ReadAsStringAsync();
        var profiles = LinkParser.ParseSubscriptionContent(body);
        if (profiles.Count > 0) _store.SetServersRaw(subId, body);
        return profiles;
    }

    // MARK: тарифы

    /// <summary>Ответ purchase-options меняется между версиями бота — разбираем адаптивно.</summary>
    public async Task<List<TariffOffer>> TariffsAsync()
    {
        JsonElement root;
        try
        {
            root = await _api.GetAsync<JsonElement>("cabinet/subscription/purchase-options");
        }
        catch (Exception)
        {
            return new List<TariffOffer>();
        }

        var arrays = new List<JsonElement>();
        void Collect(JsonElement element, int depth)
        {
            if (depth > 3) return;
            if (element.ValueKind == JsonValueKind.Array)
            {
                arrays.Add(element);
                return;
            }
            if (element.ValueKind != JsonValueKind.Object) return;
            foreach (var key in new[] { "tariffs", "items", "options", "plans" })
            {
                if (element.TryGetProperty(key, out var nested)) Collect(nested, depth + 1);
            }
        }
        Collect(root, 0);

        var offers = new List<TariffOffer>();
        foreach (var array in arrays)
        {
            foreach (var item in array.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object) continue;
                if (Json.Long(item, "id") is not { } id) continue;
                var periods = ParsePeriods(item);
                if (periods.Count == 0) continue;

                offers.Add(new TariffOffer(
                    id,
                    Json.String(item, "name") ?? $"Тариф {id}",
                    Json.String(item, "description"),
                    periods,
                    Json.Int(item, "traffic_limit_gb"),
                    Json.Int(item, "device_limit")));
            }
        }
        return offers.GroupBy(offer => offer.Id).Select(group => group.First()).ToList();
    }

    private static List<PeriodPrice> ParsePeriods(JsonElement item)
    {
        var result = new List<PeriodPrice>();
        foreach (var key in new[] { "period_prices", "periods", "prices" })
        {
            if (!item.TryGetProperty(key, out var list) || list.ValueKind != JsonValueKind.Array)
            {
                continue;
            }
            foreach (var period in list.EnumerateArray())
            {
                var days = Json.Int(period, "days") ?? Json.Int(period, "period_days");
                var price = Json.Long(period, "price_kopeks") ?? Json.Long(period, "price");
                if (days is { } d && price is { } p) result.Add(new PeriodPrice(d, p));
            }
            break;
        }
        return result.OrderBy(period => period.Days).ToList();
    }

    public async Task<string?> PurchaseTariffAsync(long tariffId, int periodDays)
    {
        try
        {
            await _api.PostAsync("cabinet/subscription/purchase-tariff",
                new PurchaseTariffRequest { TariffId = tariffId, PeriodDays = periodDays });
            return null;
        }
        catch (Exception error)
        {
            return error.Message;
        }
    }

    public async Task<string?> RenewAsync(int periodDays)
    {
        try
        {
            await _api.PostAsync("cabinet/subscription/renew",
                new RenewRequest { PeriodDays = periodDays });
            return null;
        }
        catch (Exception error)
        {
            return error.Message;
        }
    }

    // MARK: устройства

    private static Dictionary<string, string?> SubQuery(long? id) =>
        new() { ["subscription_id"] = id?.ToString() };

    public async Task<DevicesInfo> DevicesInfoAsync(long? subscriptionId = null)
    {
        int? limit = null;
        int? connected = null;

        try
        {
            var devices = await _api.GetAsync<JsonElement>(
                "cabinet/subscription/devices", SubQuery(subscriptionId));
            limit = Json.Int(devices, "device_limit");
            connected = Json.Int(devices, "total");
        }
        catch (Exception)
        {
        }

        long? price = null;
        int? maxLimit = null;
        var purchaseAvailable = false;
        // почему докупка недоступна — иначе кнопка просто исчезает и непонятно,
        // это ограничение тарифа или сбой запроса
        string? note = null;
        try
        {
            var query = SubQuery(subscriptionId);
            query["devices"] = "1";
            var priceInfo = await _api.GetAsync<JsonElement>(
                "cabinet/subscription/devices/price", query);
            purchaseAvailable = Json.Bool(priceInfo, "available") ?? true;
            price = Json.Long(priceInfo, "price_per_device_kopeks");
            maxLimit = Json.Int(priceInfo, "max_device_limit");
            limit ??= Json.Int(priceInfo, "current_device_limit");
            if (!purchaseAvailable || price is null)
            {
                note = Json.String(priceInfo, "message")
                    ?? Json.String(priceInfo, "reason")
                    ?? Json.String(priceInfo, "detail");
            }
        }
        catch (Exception error)
        {
            note = $"Не удалось узнать цену: {error.Message}";
        }

        var reduceAvailable = false;
        try
        {
            var reduction = await _api.GetAsync<JsonElement>(
                "cabinet/subscription/devices/reduction-info", SubQuery(subscriptionId));
            reduceAvailable = Json.Bool(reduction, "available") ?? false;
            limit ??= Json.Int(reduction, "current_device_limit");
            connected ??= Json.Int(reduction, "connected_devices_count");
        }
        catch (Exception)
        {
        }

        return new DevicesInfo(
            limit, connected, price, maxLimit,
            purchaseAvailable && price is not null, reduceAvailable, note);
    }

    public async Task<List<DeviceDto>> DevicesListAsync(long? subscriptionId = null)
    {
        try
        {
            var response = await _api.GetAsync<DevicesListResponse>(
                "cabinet/subscription/devices", SubQuery(subscriptionId));
            return response.Devices;
        }
        catch (Exception)
        {
            return new List<DeviceDto>();
        }
    }

    public async Task<string?> DeleteDeviceAsync(string hwid, long? subscriptionId = null)
    {
        try
        {
            await _api.DeleteAsync($"cabinet/subscription/devices/{hwid}", SubQuery(subscriptionId));
            return null;
        }
        catch (Exception error)
        {
            return error.Message;
        }
    }

    public async Task<string?> RenameDeviceAsync(string hwid, string name, long? subscriptionId = null)
    {
        try
        {
            await _api.PatchAsync($"cabinet/subscription/devices/{hwid}/name",
                new RenameDeviceRequest { Name = name }, SubQuery(subscriptionId));
            return null;
        }
        catch (Exception error)
        {
            return error.Message;
        }
    }

    public async Task<string?> BuyDevicesAsync(int count, long? subscriptionId = null)
    {
        try
        {
            await _api.PostAsync("cabinet/subscription/devices/purchase",
                new DevicesPurchaseRequest { Devices = count }, SubQuery(subscriptionId));
            return null;
        }
        catch (Exception error)
        {
            return error.Message;
        }
    }
}

/// <summary>Мелкие помощники для ответов переменной формы.</summary>
internal static class Json
{
    public static string? String(JsonElement element, string key) =>
        element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(key, out var value)
        && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    public static int? Int(JsonElement element, string key)
    {
        if (element.ValueKind != JsonValueKind.Object) return null;
        if (!element.TryGetProperty(key, out var value)) return null;
        return value.ValueKind switch
        {
            JsonValueKind.Number => value.TryGetInt32(out var number) ? number : null,
            JsonValueKind.String when int.TryParse(value.GetString(), out var parsed) => parsed,
            _ => null,
        };
    }

    public static long? Long(JsonElement element, string key)
    {
        if (element.ValueKind != JsonValueKind.Object) return null;
        if (!element.TryGetProperty(key, out var value)) return null;
        return value.ValueKind switch
        {
            JsonValueKind.Number => value.TryGetInt64(out var number) ? number : null,
            JsonValueKind.String when long.TryParse(value.GetString(), out var parsed) => parsed,
            _ => null,
        };
    }

    public static bool? Bool(JsonElement element, string key)
    {
        if (element.ValueKind != JsonValueKind.Object) return null;
        if (!element.TryGetProperty(key, out var value)) return null;
        return value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null,
        };
    }
}
