package uptime.app.accounts;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import java.time.Duration;
import java.time.Instant;
import org.springframework.stereotype.Component;
import uptime.app.http.ApiProblem;

@Component
class LoginAttempts {
    private static final Duration WINDOW = Duration.ofMinutes(15);
    private final Cache<String, Window> sources = windows();
    private final Cache<String, Window> logins = windows();

    void record(String login, String address) {
        Instant now = Instant.now();
        reserve(sources, address, 30, now);
        reserve(logins, login, 5, now);
    }

    private static Cache<String, Window> windows() {
        return Caffeine.newBuilder().maximumSize(16_384).expireAfterWrite(WINDOW).build();
    }

    private static void reserve(Cache<String, Window> cache, String key, int limit, Instant now) {
        cache.asMap().compute(key, (ignored, window) -> {
            if (window == null || !now.isBefore(window.until())) {
                return new Window(1, now.plus(WINDOW));
            }
            if (window.attempts() >= limit) {
                long seconds = Duration.between(now, window.until()).toSeconds() + 1;
                throw new ApiProblem(429, "LOGIN_RATE_LIMITED", "Попробуйте войти позже.", seconds);
            }
            return new Window(window.attempts() + 1, window.until());
        });
    }

    private record Window(int attempts, Instant until) {}
}
