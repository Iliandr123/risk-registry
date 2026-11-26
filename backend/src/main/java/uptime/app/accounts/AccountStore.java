package uptime.app.accounts;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
class AccountStore {
    private final JdbcClient jdbc;

    AccountStore(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    Optional<Credentials> lockByLogin(String login) {
        return jdbc.sql("SELECT * FROM accounts WHERE login = ? FOR UPDATE")
                .param(login)
                .query((row, index) -> new Credentials(account(row, index), row.getString("password_hash")))
                .optional();
    }

    Optional<Credentials> lockById(UUID id) {
        return jdbc.sql("SELECT * FROM accounts WHERE id = ? FOR UPDATE")
                .param(id)
                .query((row, index) -> new Credentials(account(row, index), row.getString("password_hash")))
                .optional();
    }

    Optional<Account> findSession(byte[] tokenHash) {
        return jdbc.sql("""
                SELECT a.*
                FROM sessions s JOIN accounts a ON a.id = s.account_id
                WHERE s.token_hash = ? AND s.expires_at > statement_timestamp() AND a.active
                """)
                .param(tokenHash).query(AccountStore::account).optional();
    }

    void addSession(byte[] tokenHash, UUID id, OffsetDateTime expiresAt) {
        jdbc.sql("DELETE FROM sessions WHERE expires_at <= statement_timestamp()").update();
        jdbc.sql("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)")
                .param(tokenHash).param(id).param(expiresAt).update();
    }

    void deleteSession(byte[] tokenHash) {
        jdbc.sql("DELETE FROM sessions WHERE token_hash = ?").param(tokenHash).update();
    }

    void deleteSessions(UUID id) {
        jdbc.sql("DELETE FROM sessions WHERE account_id = ?").param(id).update();
    }

    void setPassword(UUID id, String hash, boolean temporary) {
        jdbc.sql("UPDATE accounts SET password_hash = ?, must_change_password = ? WHERE id = ?")
                .param(hash).param(temporary).param(id).update();
    }

    List<Account> listAccounts() {
        return jdbc.sql("SELECT * FROM accounts ORDER BY display_name, id").query(AccountStore::account).list();
    }

    Optional<AccountDirectory.Owner> findOwner(UUID id) {
        return jdbc.sql("SELECT id, display_name, active FROM accounts WHERE id = ? FOR SHARE")
                .param(id)
                .query((row, index) -> new AccountDirectory.Owner(
                        row.getObject("id", UUID.class), row.getString("display_name"), row.getBoolean("active")))
                .optional();
    }

    List<Participant> listParticipants() {
        return jdbc.sql("SELECT id, display_name FROM accounts WHERE active ORDER BY display_name, id")
                .query((row, index) -> new Participant(
                        row.getObject("id", UUID.class), row.getString("display_name")))
                .list();
    }

    boolean insert(Account account, String hash) {
        return jdbc.sql("""
                INSERT INTO accounts (id, login, display_name, password_hash, must_change_password,
                                      active, is_admin, is_reviewer)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (login) DO NOTHING
                """)
                .param(account.id()).param(account.login()).param(account.displayName()).param(hash)
                .param(account.mustChangePassword()).param(account.active()).param(account.isAdmin())
                .param(account.isReviewer()).update() == 1;
    }

    void setAccess(Account account) {
        jdbc.sql("UPDATE accounts SET active = ?, is_admin = ?, is_reviewer = ? WHERE id = ?")
                .param(account.active()).param(account.isAdmin()).param(account.isReviewer())
                .param(account.id()).update();
    }

    void lockAdministration() {
        // PostgreSQL releases this transaction-scoped lock on both commit and rollback.
        jdbc.sql("SELECT 1 FROM pg_advisory_xact_lock(1094927188, 1)").query(Integer.class).single();
    }

    boolean hasAccounts() {
        return jdbc.sql("SELECT EXISTS (SELECT 1 FROM accounts)").query(Boolean.class).single();
    }

    boolean hasOtherActiveAdmin(UUID excluded) {
        return jdbc.sql("SELECT EXISTS (SELECT 1 FROM accounts WHERE active AND is_admin AND id <> ?)")
                .param(excluded).query(Boolean.class).single();
    }

    private static Account account(ResultSet row, int index) throws SQLException {
        return new Account(row.getObject("id", UUID.class), row.getString("login"),
                row.getString("display_name"), row.getBoolean("active"), row.getBoolean("is_admin"),
                row.getBoolean("is_reviewer"), row.getBoolean("must_change_password"));
    }

    record Credentials(Account account, String passwordHash) {}

    record Participant(UUID id, String displayName) {}
}
