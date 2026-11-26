package uptime.app.accounts;

import static uptime.app.http.SessionCookie.CSRF_HEADER;
import static uptime.app.http.SessionCookie.NAME;

import jakarta.servlet.http.HttpServletRequest;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.CookieValue;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import uptime.app.http.ApiProblem;

@RestController
@RequestMapping("/api")
class AccountController {
    private static final String CSRF_COOKIE = "__Host-risk_csrf";
    private final AccountService accounts;
    private final SessionTokens tokens;
    private final LoginAttempts attempts;

    AccountController(AccountService accounts, SessionTokens tokens, LoginAttempts attempts) {
        this.accounts = accounts;
        this.tokens = tokens;
        this.attempts = attempts;
    }

    @GetMapping("/csrf")
    ResponseEntity<CsrfToken> csrf(@CookieValue(name = NAME, required = false) String session,
            @CookieValue(name = CSRF_COOKIE, required = false) String context) {
        if (accounts.findSession(session).isPresent()) {
            return ResponseEntity.ok(new CsrfToken(tokens.csrf(session, true)));
        }
        if (SessionTokens.valid(context)) {
            return ResponseEntity.ok(new CsrfToken(tokens.csrf(context, false)));
        }
        String freshContext = SessionTokens.generate();
        return ResponseEntity.ok()
                .header(HttpHeaders.SET_COOKIE, cookie(CSRF_COOKIE, freshContext, SessionTokens.CSRF_CONTEXT_LIFETIME))
                .body(new CsrfToken(tokens.csrf(freshContext, false)));
    }

    @PostMapping("/session")
    ResponseEntity<Account> signIn(@CookieValue(name = CSRF_COOKIE, required = false) String context,
            @RequestHeader(name = CSRF_HEADER, required = false) String csrf, @RequestBody JsonNode body,
            HttpServletRequest request) {
        tokens.requireCsrf(csrf, context, false);
        var input = new AccountRequest(body, "login", "password");
        String login = input.text("login");
        String password = input.password("password");
        attempts.record(login, request.getRemoteAddr());
        var signedIn = accounts.signIn(login, password);
        return ResponseEntity.ok()
                .header(HttpHeaders.SET_COOKIE, sessionCookie(signedIn.sessionToken()),
                        cookie(CSRF_COOKIE, "", Duration.ZERO))
                .body(signedIn.account());
    }

    @DeleteMapping("/session")
    ResponseEntity<Void> signOut(@CookieValue(name = NAME, required = false) String session,
            @RequestHeader(name = CSRF_HEADER, required = false) String csrf) {
        requireSessionCsrf(session, csrf);
        accounts.signOut(session);
        return ResponseEntity.noContent().header(HttpHeaders.SET_COOKIE, cookie(NAME, "", Duration.ZERO)).build();
    }

    @GetMapping("/me")
    Account profile(@CookieValue(name = NAME, required = false) String session) {
        return accounts.requireWorkingAccount(session);
    }

    @PostMapping("/me/password")
    ResponseEntity<Void> password(@CookieValue(name = NAME, required = false) String session,
            @RequestHeader(name = CSRF_HEADER, required = false) String csrf, @RequestBody JsonNode body) {
        requireSessionCsrf(session, csrf);
        var input = new AccountRequest(body, "currentPassword", "newPassword");
        String replacementSession = accounts.changePassword(
                session, input.password("currentPassword"), input.password("newPassword"));
        return ResponseEntity.noContent().header(HttpHeaders.SET_COOKIE, sessionCookie(replacementSession)).build();
    }

    @GetMapping("/admin/accounts")
    List<Account> listAccounts(@CookieValue(name = NAME, required = false) String session) {
        return accounts.listAccounts(session);
    }

    @PostMapping("/admin/accounts")
    ResponseEntity<AccountService.TemporaryPassword> createAccount(
            @CookieValue(name = NAME, required = false) String session,
            @RequestHeader(name = CSRF_HEADER, required = false) String csrf, @RequestBody JsonNode body) {
        requireSessionCsrf(session, csrf);
        var input = new AccountRequest(body, "login", "displayName", "isAdmin", "isReviewer");
        return ResponseEntity.status(201).body(accounts.createAccount(session,
                input.text("login"), input.text("displayName"),
                Boolean.TRUE.equals(input.flag("isAdmin")), Boolean.TRUE.equals(input.flag("isReviewer"))));
    }

    @PatchMapping("/admin/accounts/{id}")
    Account updateAccount(@CookieValue(name = NAME, required = false) String session,
            @RequestHeader(name = CSRF_HEADER, required = false) String csrf, @PathVariable String id,
            @RequestBody JsonNode body) {
        requireSessionCsrf(session, csrf);
        var input = new AccountRequest(body, "active", "isAdmin", "isReviewer");
        if (body.isEmpty()) {
            throw ApiProblem.invalidRequest();
        }
        return accounts.updateAccount(session, accountId(id),
                input.flag("active"), input.flag("isAdmin"), input.flag("isReviewer"));
    }

    @PostMapping("/admin/accounts/{id}/reset-password")
    AccountService.TemporaryPassword resetPassword(@CookieValue(name = NAME, required = false) String session,
            @RequestHeader(name = CSRF_HEADER, required = false) String csrf, @PathVariable String id) {
        requireSessionCsrf(session, csrf);
        return accounts.resetPassword(session, accountId(id));
    }

    @GetMapping("/participants")
    List<AccountStore.Participant> listParticipants(@CookieValue(name = NAME, required = false) String session) {
        return accounts.listParticipants(session);
    }

    private void requireSessionCsrf(String session, String csrf) {
        accounts.requireSession(session);
        accounts.requireSessionCsrf(session, csrf);
    }

    private static UUID accountId(String value) {
        try {
            UUID id = UUID.fromString(value);
            if (id.toString().equalsIgnoreCase(value)) {
                return id;
            }
        } catch (IllegalArgumentException ignored) {
            // Invalid identifiers have no corresponding account.
        }
        throw ApiProblem.notFound();
    }

    private static String sessionCookie(String token) {
        return cookie(NAME, token, SessionTokens.SESSION_LIFETIME);
    }

    private static String cookie(String name, String value, Duration age) {
        return ResponseCookie.from(name, value).maxAge(age).path("/")
                .secure(true).httpOnly(true).sameSite("Lax").build().toString();
    }

    private record CsrfToken(String token) {}
}
