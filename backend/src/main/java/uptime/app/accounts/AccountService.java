package uptime.app.accounts;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.security.crypto.password.Pbkdf2PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import uptime.app.http.ApiProblem;

@Service
class AccountService implements AccountDirectory {
    private final AccountStore store;
    private final SessionTokens tokens;
    private final Pbkdf2PasswordEncoder passwords = Pbkdf2PasswordEncoder.defaultsForSpringSecurity_v5_8();
    private final String dummyHash = passwords.encode(SessionTokens.generate());

    AccountService(AccountStore store, SessionTokens tokens) {
        this.store = store;
        this.tokens = tokens;
    }

    @Transactional
    public SignIn signIn(String login, String password) {
        var credentials = store.lockByLogin(login).orElse(null);
        boolean matches = passwords.matches(password, credentials == null ? dummyHash : credentials.passwordHash());
        if (credentials == null || !matches || !credentials.account().active()) {
            throw new ApiProblem(401, "INVALID_CREDENTIALS", "Не удалось войти с этими учётными данными.");
        }
        return new SignIn(credentials.account(), newSession(credentials.account().id()));
    }

    Optional<Account> findSession(String token) {
        return SessionTokens.valid(token) ? store.findSession(SessionTokens.hash(token)) : Optional.empty();
    }

    Account requireSession(String token) {
        return findSession(token).orElseThrow(ApiProblem::unauthorized);
    }

    Account requireWorkingAccount(String token) {
        Account account = requireSession(token);
        if (account.mustChangePassword()) {
            throw ApiProblem.passwordChangeRequired();
        }
        return account;
    }

    @Override
    public Optional<Member> findMember(String token) {
        return findSession(token).map(account -> new Member(
                account.id(), account.isReviewer(), account.mustChangePassword()));
    }

    @Override
    public Optional<Owner> findOwner(UUID id) {
        return store.findOwner(id);
    }

    @Override
    public void requireSessionCsrf(String sessionToken, String csrfToken) {
        tokens.requireCsrf(csrfToken, sessionToken, true);
    }

    @Transactional
    public void signOut(String token) {
        lockSession(token);
        store.deleteSession(SessionTokens.hash(token));
    }

    @Transactional
    public String changePassword(String token, String current, String replacement) {
        var credentials = lockSession(token);
        if (!passwords.matches(current, credentials.passwordHash())) {
            throw new ApiProblem(403, "INVALID_CURRENT_PASSWORD", "Текущий пароль неверен.");
        }
        if (current.equals(replacement)) {
            throw new ApiProblem(400, "INVALID_REQUEST", "Новый пароль должен отличаться от текущего.");
        }
        UUID id = credentials.account().id();
        store.setPassword(id, passwords.encode(replacement), false);
        store.deleteSessions(id);
        return newSession(id);
    }

    List<Account> listAccounts(String token) {
        requireAdmin(requireWorkingAccount(token));
        return store.listAccounts();
    }

    List<AccountStore.Participant> listParticipants(String token) {
        requireWorkingAccount(token);
        return store.listParticipants();
    }

    @Transactional
    public TemporaryPassword createAccount(String token, String login, String name, boolean admin, boolean reviewer) {
        lockAdminSession(token);
        return create(login, name, admin, reviewer);
    }

    @Transactional
    public TemporaryPassword bootstrap(String login, String name) {
        store.lockAdministration();
        if (store.hasAccounts()) {
            throw new IllegalStateException("Первого администратора можно создать только на пустом стенде.");
        }
        return create(login, name, true, false);
    }

    @Transactional
    public Account updateAccount(String token, UUID id, Boolean active, Boolean admin, Boolean reviewer) {
        lockAdminSession(token);
        Account current = lockAccount(id).account();
        var updated = new Account(id, current.login(), current.displayName(),
                active == null ? current.active() : active,
                admin == null ? current.isAdmin() : admin,
                reviewer == null ? current.isReviewer() : reviewer,
                current.mustChangePassword());
        if (current.active() && current.isAdmin() && !(updated.active() && updated.isAdmin())
                && !store.hasOtherActiveAdmin(id)) {
            throw new ApiProblem(409, "LAST_ACTIVE_ADMIN", "Должен остаться хотя бы один активный администратор.");
        }
        if (!updated.equals(current)) {
            store.setAccess(updated);
            store.deleteSessions(id);
        }
        return updated;
    }

    @Transactional
    public TemporaryPassword resetPassword(String token, UUID id) {
        lockAdminSession(token);
        Account account = lockAccount(id).account();
        String temporary = SessionTokens.generate();
        store.setPassword(id, passwords.encode(temporary), true);
        store.deleteSessions(id);
        return new TemporaryPassword(new Account(id, account.login(), account.displayName(), account.active(),
                account.isAdmin(), account.isReviewer(), true), temporary);
    }

    private String newSession(UUID id) {
        String token = SessionTokens.generate();
        store.addSession(SessionTokens.hash(token), id, OffsetDateTime.now(ZoneOffset.UTC)
                .plus(SessionTokens.SESSION_LIFETIME));
        return token;
    }

    private AccountStore.Credentials lockSession(String token) {
        Account account = requireSession(token);
        var locked = lockAccount(account.id());
        // Account updates and session creation serialize on the same account row.
        requireSession(token);
        return locked;
    }

    private void lockAdminSession(String token) {
        store.lockAdministration();
        Account account = lockSession(token).account();
        if (account.mustChangePassword()) {
            throw ApiProblem.passwordChangeRequired();
        }
        requireAdmin(account);
    }

    private AccountStore.Credentials lockAccount(UUID id) {
        return store.lockById(id).orElseThrow(ApiProblem::notFound);
    }

    private static void requireAdmin(Account account) {
        if (!account.isAdmin()) {
            throw ApiProblem.forbidden();
        }
    }

    private TemporaryPassword create(String login, String name, boolean admin, boolean reviewer) {
        var account = new Account(UUID.randomUUID(), login, name, true, admin, reviewer, true);
        String temporary = SessionTokens.generate();
        if (!store.insert(account, passwords.encode(temporary))) {
            throw new ApiProblem(409, "LOGIN_ALREADY_EXISTS", "Такой логин уже занят.");
        }
        return new TemporaryPassword(account, temporary);
    }

    record SignIn(Account account, String sessionToken) {}

    record TemporaryPassword(Account account, String temporaryPassword) {}
}
