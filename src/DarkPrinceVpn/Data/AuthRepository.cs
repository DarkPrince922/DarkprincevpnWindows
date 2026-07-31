namespace DarkPrinceVpn.Data;

public abstract record DeepLinkAuthEvent
{
    /// <summary>Ссылку нужно открыть в Telegram.</summary>
    public sealed record OpenTelegram(string TelegramUri, string WebUri) : DeepLinkAuthEvent;
    public sealed record Waiting : DeepLinkAuthEvent;
    public sealed record Success(UserDto? User) : DeepLinkAuthEvent;
    public sealed record Failed(string Message) : DeepLinkAuthEvent;
}

public sealed class AuthRepository
{
    public static AuthRepository Shared { get; } = new();

    private readonly ApiClient _api = ApiClient.Shared;
    private readonly AppStore _store = AppStore.Shared;

    private AuthRepository() { }

    public bool IsLoggedIn => _store.IsLoggedIn;
    public UserDto? CurrentUser => _store.User;

    private void Save(AuthResponse auth)
    {
        if (auth.AccessToken is null) return;
        _store.AccessToken = auth.AccessToken;
        _store.RefreshToken = auth.RefreshToken;
        _store.AccessExpiresAt = auth.ExpiresIn is { } seconds
            ? DateTimeOffset.UtcNow.AddSeconds(seconds)
            : null;
        if (auth.User is not null) _store.User = auth.User;
    }

    /// <summary>
    /// Вход через Telegram: запрашиваем одноразовый токен, отдаём ссылку на
    /// бота и опрашиваем сервер, пока пользователь не нажмёт «Start».
    /// </summary>
    public async Task TelegramDeepLinkAsync(
        Action<DeepLinkAuthEvent> onEvent,
        CancellationToken cancellation = default)
    {
        DeepLinkRequestResponse request;
        try
        {
            request = await _api.PostAsync<DeepLinkRequestResponse>(
                "cabinet/auth/deeplink/request", null, authorized: false);
        }
        catch (Exception error)
        {
            onEvent(new DeepLinkAuthEvent.Failed(error.Message));
            return;
        }

        if (request.BotUsername is not { } bot)
        {
            onEvent(new DeepLinkAuthEvent.Failed("Сервер не вернул имя бота"));
            return;
        }

        var startParam = $"webauth_{request.Token}";
        onEvent(new DeepLinkAuthEvent.OpenTelegram(
            $"tg://resolve?domain={bot}&start={startParam}",
            $"https://t.me/{bot}?start={startParam}"));

        var deadline = DateTimeOffset.UtcNow.AddSeconds(request.ExpiresIn);
        while (DateTimeOffset.UtcNow < deadline)
        {
            if (cancellation.IsCancellationRequested) return;

            var (status, auth) = await _api.PollDeepLinkAsync(request.Token);
            switch (status)
            {
                case 200 when auth?.AccessToken is not null:
                    Save(auth);
                    onEvent(new DeepLinkAuthEvent.Success(auth.User));
                    return;
                case 200:
                    onEvent(new DeepLinkAuthEvent.Failed("Пустой ответ сервера"));
                    return;
                case 410:
                    onEvent(new DeepLinkAuthEvent.Failed("Время авторизации истекло, попробуйте ещё раз"));
                    return;
                default:
                    onEvent(new DeepLinkAuthEvent.Waiting());
                    break;
            }

            try
            {
                await Task.Delay(2000, cancellation);
            }
            catch (TaskCanceledException)
            {
                return;
            }
        }
        onEvent(new DeepLinkAuthEvent.Failed("Время авторизации истекло, попробуйте ещё раз"));
    }

    /// <summary>Возвращает null при успехе, иначе текст ошибки.</summary>
    public async Task<string?> EmailLoginAsync(string email, string password)
    {
        try
        {
            var auth = await _api.PostAsync<AuthResponse>(
                "cabinet/auth/email/login",
                new EmailLoginRequest { Email = email.Trim(), Password = password },
                authorized: false);
            if (auth.AccessToken is null) return auth.Message ?? "Не удалось войти";
            Save(auth);
            return null;
        }
        catch (Exception error)
        {
            return error.Message;
        }
    }

    /// <summary>
    /// При успехе без токенов сервер прислал письмо для подтверждения почты.
    /// </summary>
    public async Task<(bool Success, string? Message)> EmailRegisterAsync(
        string email, string password, string? referralCode)
    {
        try
        {
            var auth = await _api.PostAsync<AuthResponse>(
                "cabinet/auth/email/register/standalone",
                new EmailRegisterRequest
                {
                    Email = email.Trim(),
                    Password = password,
                    ReferralCode = string.IsNullOrWhiteSpace(referralCode) ? null : referralCode.Trim(),
                },
                authorized: false);

            if (auth.AccessToken is not null)
            {
                Save(auth);
                return (true, null);
            }
            return (true, auth.Message ?? "Подтвердите e-mail по ссылке из письма, затем войдите.");
        }
        catch (Exception error)
        {
            return (false, error.Message);
        }
    }

    public async Task ForgotPasswordAsync(string email)
    {
        try
        {
            await _api.PostAsync(
                "cabinet/auth/password/forgot",
                new ForgotPasswordRequest { Email = email.Trim() },
                authorized: false);
        }
        catch (Exception)
        {
        }
    }

    public async Task LogoutAsync()
    {
        if (_store.RefreshToken is { } refresh)
        {
            try
            {
                await _api.PostAsync("cabinet/auth/logout",
                    new LogoutRequest { RefreshToken = refresh });
            }
            catch (Exception)
            {
            }
        }
        _store.ClearSession();
    }
}
