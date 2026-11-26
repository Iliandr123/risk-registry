package uptime.app.accounts;

import java.util.Optional;
import java.util.UUID;

public interface AccountDirectory {
    Optional<Member> findMember(String sessionToken);

    void requireSessionCsrf(String sessionToken, String csrfToken);

    /** When called within a transaction, holds the owner's row until that transaction ends. */
    Optional<Owner> findOwner(UUID id);

    record Member(UUID id, boolean reviewer, boolean mustChangePassword) {}

    record Owner(UUID id, String displayName, boolean active) {}
}
