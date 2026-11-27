package uptime.app.risks;

import java.util.UUID;
import uptime.app.accounts.AccountDirectory.Member;

record RiskVersion(UUID riskId, UUID id, UUID authorId, long revision, Status status,
                   DraftFields fields, UUID historicalOwnerId, boolean submitted) {
    enum Status { DRAFT, IN_REVIEW, RETURNED, APPROVED, WITHDRAWN, CLOSED }

    boolean ownedBy(Member member) {
        return authorId.equals(member.id());
    }

    boolean visibleTo(Member member) {
        return ownedBy(member) || member.reviewer() && submitted;
    }

    boolean editable() {
        return status == Status.DRAFT || status == Status.RETURNED;
    }

    boolean open() {
        return editable() || status == Status.IN_REVIEW;
    }
}
