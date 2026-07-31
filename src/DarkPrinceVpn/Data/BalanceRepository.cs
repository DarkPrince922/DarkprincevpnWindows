namespace DarkPrinceVpn.Data;

public sealed class BalanceRepository
{
    public static BalanceRepository Shared { get; } = new();

    private readonly ApiClient _api = ApiClient.Shared;

    private BalanceRepository() { }

    public async Task<long?> BalanceAsync()
    {
        try
        {
            var response = await _api.GetAsync<BalanceResponse>("cabinet/balance");
            return response.Kopeks;
        }
        catch (Exception)
        {
            return null;
        }
    }

    public async Task<ReferralInfoResponse?> ReferralAsync()
    {
        try
        {
            return await _api.GetAsync<ReferralInfoResponse>("cabinet/referral");
        }
        catch (Exception)
        {
            return null;
        }
    }

    public async Task<(bool Success, string Message)> ActivatePromoAsync(string code)
    {
        try
        {
            var response = await _api.PostAsync<PromoActivateResponse>(
                "cabinet/promocode/activate",
                new PromoActivateRequest { Code = code.Trim() });
            var text = response.BonusDescription ?? response.Message ?? "Промокод активирован";
            return (response.Success ?? true, text);
        }
        catch (Exception error)
        {
            return (false, error.Message);
        }
    }
}
