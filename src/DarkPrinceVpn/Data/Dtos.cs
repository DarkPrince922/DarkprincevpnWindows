using System.Text.Json.Serialization;

namespace DarkPrinceVpn.Data;

// Кабинет отдаёт поля в snake_case; имена задаём явно, чтобы не зависеть
// от настроек сериализатора.

public sealed class DeepLinkRequestResponse
{
    [JsonPropertyName("token")] public string Token { get; set; } = "";
    [JsonPropertyName("bot_username")] public string? BotUsername { get; set; }
    [JsonPropertyName("expires_in")] public int ExpiresIn { get; set; } = 300;
}

public sealed class DeepLinkPollRequest
{
    [JsonPropertyName("token")] public string Token { get; set; } = "";
}

public sealed class EmailLoginRequest
{
    [JsonPropertyName("email")] public string Email { get; set; } = "";
    [JsonPropertyName("password")] public string Password { get; set; } = "";
}

public sealed class EmailRegisterRequest
{
    [JsonPropertyName("email")] public string Email { get; set; } = "";
    [JsonPropertyName("password")] public string Password { get; set; } = "";
    [JsonPropertyName("language")] public string Language { get; set; } = "ru";
    [JsonPropertyName("referral_code")] public string? ReferralCode { get; set; }
}

public sealed class ForgotPasswordRequest
{
    [JsonPropertyName("email")] public string Email { get; set; } = "";
}

public sealed class RefreshRequest
{
    [JsonPropertyName("refresh_token")] public string RefreshToken { get; set; } = "";
}

public sealed class LogoutRequest
{
    [JsonPropertyName("refresh_token")] public string RefreshToken { get; set; } = "";
}

public sealed class UserDto
{
    [JsonPropertyName("id")] public long? Id { get; set; }
    [JsonPropertyName("telegram_id")] public long? TelegramId { get; set; }
    [JsonPropertyName("email")] public string? Email { get; set; }
    [JsonPropertyName("username")] public string? Username { get; set; }
    [JsonPropertyName("first_name")] public string? FirstName { get; set; }
    [JsonPropertyName("balance_kopeks")] public long? BalanceKopeks { get; set; }

    public string DisplayName
    {
        get
        {
            if (!string.IsNullOrWhiteSpace(Email)) return Email!;
            if (!string.IsNullOrWhiteSpace(Username)) return "@" + Username;
            if (TelegramId is { } id) return $"Telegram ID: {id}";
            return "—";
        }
    }
}

public sealed class AuthResponse
{
    [JsonPropertyName("access_token")] public string? AccessToken { get; set; }
    [JsonPropertyName("refresh_token")] public string? RefreshToken { get; set; }
    [JsonPropertyName("expires_in")] public long? ExpiresIn { get; set; }
    [JsonPropertyName("user")] public UserDto? User { get; set; }
    /// <summary>Регистрация может попросить подтвердить почту вместо выдачи токенов.</summary>
    [JsonPropertyName("message")] public string? Message { get; set; }
}

public sealed class SubscriptionStatusResponse
{
    [JsonPropertyName("status")] public string? Status { get; set; }
    [JsonPropertyName("is_active")] public bool? IsActive { get; set; }
    [JsonPropertyName("end_date")] public string? EndDate { get; set; }
    [JsonPropertyName("days_left")] public int? DaysLeft { get; set; }
    [JsonPropertyName("traffic_used_gb")] public double? TrafficUsedGb { get; set; }
    [JsonPropertyName("traffic_limit_gb")] public double? TrafficLimitGb { get; set; }
    [JsonPropertyName("device_limit")] public int? DeviceLimit { get; set; }
    [JsonPropertyName("subscription_url")] public string? SubscriptionUrl { get; set; }
    [JsonPropertyName("tariff_name")] public string? TariffName { get; set; }
}

public sealed class SubscriptionListItem
{
    [JsonPropertyName("id")] public long Id { get; set; }
    [JsonPropertyName("status")] public string? Status { get; set; }
    [JsonPropertyName("tariff_id")] public long? TariffId { get; set; }
    [JsonPropertyName("tariff_name")] public string? TariffName { get; set; }
    [JsonPropertyName("traffic_limit_gb")] public double? TrafficLimitGb { get; set; }
    [JsonPropertyName("traffic_used_gb")] public double? TrafficUsedGb { get; set; }
    [JsonPropertyName("device_limit")] public int? DeviceLimit { get; set; }
    [JsonPropertyName("end_date")] public string? EndDate { get; set; }
    [JsonPropertyName("subscription_url")] public string? SubscriptionUrl { get; set; }
    [JsonPropertyName("is_trial")] public bool? IsTrial { get; set; }

    public string DisplayName
    {
        get
        {
            if (!string.IsNullOrWhiteSpace(TariffName)) return TariffName!;
            return IsTrial == true ? "Пробная подписка" : $"Подписка #{Id}";
        }
    }

    public bool IsActive =>
        Status?.ToLowerInvariant() is "active" or "trial" or "активна";
}

public sealed class SubscriptionsListResponse
{
    [JsonPropertyName("subscriptions")] public List<SubscriptionListItem> Subscriptions { get; set; } = new();
}

public sealed class ConnectionLinkResponse
{
    [JsonPropertyName("subscription_url")] public string? SubscriptionUrl { get; set; }
}

public sealed class DeviceDto
{
    [JsonPropertyName("hwid")] public string Hwid { get; set; } = "";
    [JsonPropertyName("platform")] public string? Platform { get; set; }
    [JsonPropertyName("device_model")] public string? DeviceModel { get; set; }
    [JsonPropertyName("local_name")] public string? LocalName { get; set; }
    [JsonPropertyName("created_at")] public string? CreatedAt { get; set; }

    public string Title
    {
        get
        {
            foreach (var candidate in new[] { LocalName, DeviceModel, Platform })
            {
                if (!string.IsNullOrWhiteSpace(candidate)) return candidate!;
            }
            return "Устройство";
        }
    }

    public string? Subtitle
    {
        get
        {
            var parts = new[] { Platform, DeviceModel }
                .Where(part => !string.IsNullOrWhiteSpace(part) && part != Title)
                .ToList();
            return parts.Count == 0 ? null : string.Join(" · ", parts);
        }
    }
}

public sealed class DevicesListResponse
{
    [JsonPropertyName("devices")] public List<DeviceDto> Devices { get; set; } = new();
    [JsonPropertyName("device_limit")] public int? DeviceLimit { get; set; }
    [JsonPropertyName("total")] public int? Total { get; set; }
}

public sealed class RenameDeviceRequest
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
}

public sealed class PurchaseTariffRequest
{
    [JsonPropertyName("tariff_id")] public long TariffId { get; set; }
    [JsonPropertyName("period_days")] public int PeriodDays { get; set; }
}

public sealed class RenewRequest
{
    [JsonPropertyName("period_days")] public int PeriodDays { get; set; }
}

public sealed class DevicesPurchaseRequest
{
    [JsonPropertyName("devices")] public int Devices { get; set; }
}

public sealed class BalanceResponse
{
    [JsonPropertyName("balance_kopeks")] public long? BalanceKopeks { get; set; }
    [JsonPropertyName("balance_rubles")] public double? BalanceRubles { get; set; }

    public long Kopeks =>
        BalanceKopeks ?? (BalanceRubles is { } rubles ? (long)Math.Round(rubles * 100) : 0);
}

public sealed class TopupRequest
{
    [JsonPropertyName("amount_kopeks")] public long AmountKopeks { get; set; }
    [JsonPropertyName("payment_method")] public string PaymentMethod { get; set; } = "";
    [JsonPropertyName("language")] public string Language { get; set; } = "ru";
}

public sealed class TopupResponse
{
    [JsonPropertyName("payment_url")] public string? PaymentUrl { get; set; }
    [JsonPropertyName("message")] public string? Message { get; set; }
}

public sealed class PromoActivateRequest
{
    [JsonPropertyName("code")] public string Code { get; set; } = "";
}

public sealed class PromoActivateResponse
{
    [JsonPropertyName("success")] public bool? Success { get; set; }
    [JsonPropertyName("message")] public string? Message { get; set; }
    [JsonPropertyName("bonus_description")] public string? BonusDescription { get; set; }
}

public sealed class ReferralInfoResponse
{
    [JsonPropertyName("referral_code")] public string? ReferralCode { get; set; }
    [JsonPropertyName("referral_link")] public string? ReferralLink { get; set; }
    [JsonPropertyName("bot_referral_link")] public string? BotReferralLink { get; set; }
    [JsonPropertyName("total_referrals")] public int? TotalReferrals { get; set; }
    [JsonPropertyName("total_earnings_kopeks")] public long? TotalEarningsKopeks { get; set; }
    [JsonPropertyName("commission_percent")] public double? CommissionPercent { get; set; }

    public string? ShareLink => BotReferralLink ?? ReferralLink;
}
