package uptime.app.http;

import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;

public final class SessionCookie {
    public static final String NAME = "__Host-risk_session";
    public static final String CSRF_HEADER = "X-CSRF-Token";

    private SessionCookie() {}

    public static String read(HttpServletRequest request) {
        Cookie[] cookies = request.getCookies();
        if (cookies != null) {
            for (Cookie cookie : cookies) {
                if (NAME.equals(cookie.getName())) {
                    return cookie.getValue();
                }
            }
        }
        return null;
    }
}
