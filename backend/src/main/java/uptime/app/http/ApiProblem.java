package uptime.app.http;

public final class ApiProblem extends RuntimeException {
    private final int status;
    private final String code;
    private final long retryAfter;

    public ApiProblem(int status, String code, String message) {
        this(status, code, message, 0);
    }

    public ApiProblem(int status, String code, String message, long retryAfter) {
        super(message);
        this.status = status;
        this.code = code;
        this.retryAfter = retryAfter;
    }

    public static ApiProblem unauthorized() {
        return new ApiProblem(401, "AUTHENTICATION_REQUIRED", "Войдите в приложение.");
    }

    public static ApiProblem forbidden() {
        return new ApiProblem(403, "FORBIDDEN", "У вас нет прав на это действие.");
    }

    public static ApiProblem passwordChangeRequired() {
        return new ApiProblem(403, "PASSWORD_CHANGE_REQUIRED", "Смените временный пароль.");
    }

    public static ApiProblem invalidRequest() {
        return new ApiProblem(400, "INVALID_REQUEST", "Проверьте поля запроса.");
    }

    public static ApiProblem notFound() {
        return new ApiProblem(404, "NOT_FOUND", "Запись не найдена.");
    }

    int status() {
        return status;
    }

    String code() {
        return code;
    }

    long retryAfter() {
        return retryAfter;
    }
}
