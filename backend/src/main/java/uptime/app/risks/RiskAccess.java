package uptime.app.risks;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.Set;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import uptime.app.accounts.AccountDirectory;
import uptime.app.http.ApiProblem;
import uptime.app.http.SessionCookie;

@Configuration(proxyBeanMethods = false)
class RiskAccess implements HandlerInterceptor, WebMvcConfigurer {
    static final String MEMBER_ATTRIBUTE = "uptime.app.risks.member";
    private static final Set<String> SAFE_METHODS = Set.of("GET", "HEAD", "OPTIONS");
    private final AccountDirectory accounts;

    RiskAccess(AccountDirectory accounts) {
        this.accounts = accounts;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(this).addPathPatterns("/api/risks", "/api/risks/**", "/api/risk-groups",
                "/api/admin/risk-groups", "/api/admin/risk-groups/*");
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        String session = SessionCookie.read(request);
        var member = accounts.findMember(session).orElseThrow(ApiProblem::unauthorized);
        if (member.mustChangePassword()) {
            throw ApiProblem.passwordChangeRequired();
        }
        if (!SAFE_METHODS.contains(request.getMethod())) {
            accounts.requireSessionCsrf(session, request.getHeader(SessionCookie.CSRF_HEADER));
        }
        request.setAttribute(MEMBER_ATTRIBUTE, member);
        return true;
    }
}
