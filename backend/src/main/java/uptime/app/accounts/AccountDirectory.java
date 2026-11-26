package uptime.app.accounts;

import java.util.Optional;
import java.util.UUID;

public interface AccountDirectory {
    Optional<Member> findMember(String sessionToken);

    void requireSessionCsrf(String sessionToken, String csrfToken);

    Optional<Owner> findOwner(UUID id);

    /** Holds the owner's row until the calling transaction ends. */
    Optional<Owner> lockOwner(UUID id);

    record Member(UUID id, boolean reviewer, boolean mustChangePassword) {}

    record Owner(UUID id, String displayName, boolean active) {}
}
