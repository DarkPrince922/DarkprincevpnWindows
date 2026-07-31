using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;

namespace DarkPrinceVpn.Data;

public sealed class ApiException : Exception
{
    public ApiException(string message) : base(message) { }

    public static ApiException FromStatus(HttpStatusCode code, string? serverMessage)
    {
        if (!string.IsNullOrWhiteSpace(serverMessage)) return new ApiException(serverMessage!);
        var text = (int)code switch
        {
            400 or 422 => "Неверные данные. Проверьте введённые значения.",
            401 => "Неверный логин или пароль.",
            403 => "Доступ запрещён.",
            404 => "Сервис не найден. Проверьте адрес кабинета.",
            429 => "Слишком много попыток. Подождите немного.",
            >= 500 and <= 599 => "Сервер временно недоступен.",
            _ => $"Ошибка сервера ({(int)code}).",
        };
        return new ApiException(text);
    }
}

/// <summary>
/// Клиент кабинета Bedolaga. Токен обновляется в одну «нитку»: без этого
/// несколько одновременных запросов ротируют refresh-токен наперегонки и
/// пользователя выбрасывает из аккаунта.
/// </summary>
public sealed class ApiClient
{
    public static ApiClient Shared { get; } = new();

    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(30) };
    private readonly AppStore _store = AppStore.Shared;
    private readonly SemaphoreSlim _refreshLock = new(1, 1);

    private ApiClient()
    {
        _http.DefaultRequestHeaders.Add("Accept", "application/json");
    }

    public async Task<T> GetAsync<T>(
        string path,
        IReadOnlyDictionary<string, string?>? query = null,
        bool authorized = true)
    {
        var response = await SendAsync(HttpMethod.Get, path, query, null, authorized);
        return await ReadAsync<T>(response, HttpMethod.Get, path, query, null, authorized);
    }

    public async Task<T> PostAsync<T>(
        string path,
        object? body,
        IReadOnlyDictionary<string, string?>? query = null,
        bool authorized = true)
    {
        var response = await SendAsync(HttpMethod.Post, path, query, body, authorized);
        return await ReadAsync<T>(response, HttpMethod.Post, path, query, body, authorized);
    }

    public async Task PostAsync(
        string path,
        object? body,
        IReadOnlyDictionary<string, string?>? query = null,
        bool authorized = true)
    {
        var response = await SendAsync(HttpMethod.Post, path, query, body, authorized);
        await EnsureSuccessAsync(response, HttpMethod.Post, path, query, body, authorized);
    }

    public async Task DeleteAsync(string path, IReadOnlyDictionary<string, string?>? query = null)
    {
        var response = await SendAsync(HttpMethod.Delete, path, query, null, true);
        await EnsureSuccessAsync(response, HttpMethod.Delete, path, query, null, true);
    }

    public async Task PatchAsync(
        string path,
        object? body,
        IReadOnlyDictionary<string, string?>? query = null)
    {
        var response = await SendAsync(HttpMethod.Patch, path, query, body, true);
        await EnsureSuccessAsync(response, HttpMethod.Patch, path, query, body, true);
    }

    /// <summary>
    /// Опрос подтверждения входа через Telegram: 202 — ещё ждём, 410 — токен
    /// протух. Код возвращаем как есть, решает вызывающий.
    /// </summary>
    public async Task<(int Status, AuthResponse? Auth)> PollDeepLinkAsync(string token)
    {
        try
        {
            var response = await SendAsync(
                HttpMethod.Post, "cabinet/auth/deeplink/poll", null,
                new DeepLinkPollRequest { Token = token }, authorized: false);
            var auth = response.IsSuccessStatusCode
                ? await response.Content.ReadFromJsonAsync<AuthResponse>()
                : null;
            return ((int)response.StatusCode, auth);
        }
        catch (Exception)
        {
            return (0, null);
        }
    }

    private async Task<HttpResponseMessage> SendAsync(
        HttpMethod method,
        string path,
        IReadOnlyDictionary<string, string?>? query,
        object? body,
        bool authorized)
    {
        var url = $"{_store.BaseUrl}/api/{path}";
        if (query is not null)
        {
            var pairs = query
                .Where(pair => pair.Value is not null)
                .Select(pair => $"{Uri.EscapeDataString(pair.Key)}={Uri.EscapeDataString(pair.Value!)}")
                .ToList();
            if (pairs.Count > 0) url += "?" + string.Join("&", pairs);
        }

        var request = new HttpRequestMessage(method, url);
        if (body is not null) request.Content = JsonContent.Create(body, body.GetType());

        if (authorized)
        {
            if (await EnsureFreshTokenAsync() && _store.AccessToken is { } token)
            {
                request.Headers.Authorization =
                    new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
            }
        }

        try
        {
            return await _http.SendAsync(request);
        }
        catch (HttpRequestException error)
        {
            throw new ApiException($"Нет соединения с кабинетом: {error.Message}");
        }
        catch (TaskCanceledException)
        {
            throw new ApiException("Кабинет не ответил вовремя.");
        }
    }

    private async Task<T> ReadAsync<T>(
        HttpResponseMessage response,
        HttpMethod method,
        string path,
        IReadOnlyDictionary<string, string?>? query,
        object? body,
        bool authorized)
    {
        response = await RetryIfUnauthorizedAsync(response, method, path, query, body, authorized);

        if (!response.IsSuccessStatusCode)
        {
            throw ApiException.FromStatus(response.StatusCode, await ServerMessageAsync(response));
        }

        var text = await response.Content.ReadAsStringAsync();
        if (string.IsNullOrWhiteSpace(text))
        {
            throw new ApiException("Сервер вернул пустой ответ.");
        }
        try
        {
            return JsonSerializer.Deserialize<T>(text)
                   ?? throw new ApiException("Сервер вернул неожиданный ответ.");
        }
        catch (JsonException)
        {
            throw new ApiException("Сервер вернул неожиданный ответ.");
        }
    }

    private async Task EnsureSuccessAsync(
        HttpResponseMessage response,
        HttpMethod method,
        string path,
        IReadOnlyDictionary<string, string?>? query,
        object? body,
        bool authorized)
    {
        response = await RetryIfUnauthorizedAsync(response, method, path, query, body, authorized);
        if (!response.IsSuccessStatusCode)
        {
            throw ApiException.FromStatus(response.StatusCode, await ServerMessageAsync(response));
        }
    }

    /// <summary>Токен мог протухнуть, пока запрос был в пути.</summary>
    private async Task<HttpResponseMessage> RetryIfUnauthorizedAsync(
        HttpResponseMessage response,
        HttpMethod method,
        string path,
        IReadOnlyDictionary<string, string?>? query,
        object? body,
        bool authorized)
    {
        if (response.StatusCode != HttpStatusCode.Unauthorized || !authorized) return response;
        if (!await RefreshTokensAsync()) return response;
        return await SendAsync(method, path, query, body, authorized: true);
    }

    private static async Task<string?> ServerMessageAsync(HttpResponseMessage response)
    {
        try
        {
            var text = await response.Content.ReadAsStringAsync();
            using var document = JsonDocument.Parse(text);
            foreach (var key in new[] { "detail", "message", "error" })
            {
                if (document.RootElement.TryGetProperty(key, out var value)
                    && value.ValueKind == JsonValueKind.String)
                {
                    return value.GetString();
                }
            }
        }
        catch (Exception)
        {
        }
        return null;
    }

    private async Task<bool> EnsureFreshTokenAsync()
    {
        if (_store.RefreshToken is null) return false;
        if (_store.AccessExpiresAt is not { } expires) return _store.AccessToken is not null;
        // обновляем заранее, чтобы не ловить 401 на каждом первом запросе
        if (expires - DateTimeOffset.UtcNow > TimeSpan.FromSeconds(60)) return true;
        return await RefreshTokensAsync();
    }

    private async Task<bool> RefreshTokensAsync()
    {
        await _refreshLock.WaitAsync();
        try
        {
            if (_store.RefreshToken is not { } refresh) return false;
            // пока ждали очередь, токен мог обновить кто-то другой
            if (_store.AccessExpiresAt is { } expires
                && expires - DateTimeOffset.UtcNow > TimeSpan.FromSeconds(60))
            {
                return true;
            }

            var request = new HttpRequestMessage(HttpMethod.Post, $"{_store.BaseUrl}/api/cabinet/auth/refresh")
            {
                Content = JsonContent.Create(new RefreshRequest { RefreshToken = refresh }),
            };
            var response = await _http.SendAsync(request);
            if (!response.IsSuccessStatusCode)
            {
                if (response.StatusCode == HttpStatusCode.Unauthorized) _store.ClearSession();
                return false;
            }

            var auth = await response.Content.ReadFromJsonAsync<AuthResponse>();
            if (auth?.AccessToken is null) return false;

            _store.AccessToken = auth.AccessToken;
            if (auth.RefreshToken is not null) _store.RefreshToken = auth.RefreshToken;
            _store.AccessExpiresAt = auth.ExpiresIn is { } seconds
                ? DateTimeOffset.UtcNow.AddSeconds(seconds)
                : null;
            return true;
        }
        catch (Exception)
        {
            return false;
        }
        finally
        {
            _refreshLock.Release();
        }
    }
}
