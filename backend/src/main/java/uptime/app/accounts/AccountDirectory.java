package uptime.app.accounts;

import java.util.Optional;
import java.util.UUID;

public interface AccountDirectory {
    Optional<Member> findMember(String sessionToken);

    void requireSessionCsrf(String sessionToken, String csrfToken);

    Optional<Participant> findParticipant(UUID id);

    /** Holds a shared lock on the participant's row until the calling transaction ends. */
    Optional<Participant> lockParticipant(UUID id);

    record Member(UUID id, boolean reviewer, boolean admin, boolean mustChangePassword) {}

    record Participant(UUID id, String displayName, boolean active) {}
}
