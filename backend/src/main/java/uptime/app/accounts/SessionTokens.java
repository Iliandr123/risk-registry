package uptime.app.accounts;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.Base64;
import java.util.regex.Pattern;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.stereotype.Component;
import uptime.app.http.ApiProblem;

@Component
class SessionTokens {
    static final Duration SESSION_LIFETIME = Duration.ofHours(12);
    static final Duration CSRF_CONTEXT_LIFETIME = Duration.ofMinutes(15);
    private static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9_-]{43}");
    private static final Base64.Encoder ENCODER = Base64.getUrlEncoder().withoutPadding();
    private static final SecureRandom RANDOM = new SecureRandom();
    private final SecretKeySpec csrfKey = new SecretKeySpec(RANDOM.generateSeed(32), "HmacSHA256");

    static String generate() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return ENCODER.encodeToString(bytes);
    }

    static boolean valid(String value) {
        return value != null && TOKEN.matcher(value).matches();
    }

    static byte[] hash(String token) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.US_ASCII));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    String csrf(String context, boolean authenticated) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(csrfKey);
            mac.update(authenticated ? (byte) 1 : (byte) 0);
            return ENCODER.encodeToString(mac.doFinal(context.getBytes(StandardCharsets.US_ASCII)));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    void requireCsrf(String presented, String context, boolean authenticated) {
        if (!valid(context) || !valid(presented) || !MessageDigest.isEqual(
                presented.getBytes(StandardCharsets.US_ASCII),
                csrf(context, authenticated).getBytes(StandardCharsets.US_ASCII))) {
            throw new ApiProblem(403, "CSRF_REJECTED", "Обновите CSRF-токен и повторите запрос.");
        }
    }
}
