package uptime.app.accounts;

import java.util.UUID;

record Account(
        UUID id, String login, String displayName, boolean active,
        boolean isAdmin, boolean isReviewer, boolean mustChangePassword
) {}
