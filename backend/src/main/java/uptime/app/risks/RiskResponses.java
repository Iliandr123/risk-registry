package uptime.app.risks;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import uptime.app.accounts.AccountDirectory.Owner;
import uptime.app.risks.DraftFields.RiskState;
import uptime.app.risks.RiskStore.EventAction;
import uptime.app.risks.RiskVersion.Status;

final class RiskResponses {
    private RiskResponses() {}

    enum Category { LOW, MEDIUM, HIGH }

    enum ProposalKind { FIRST, EDIT }

    record Participant(UUID id, String displayName) {}

    record Identity(UUID riskId, UUID versionId, long revision, Status status) {
        Identity(RiskVersion version) {
            this(version.riskId(), version.id(), version.revision(), version.status());
        }
    }

    record Proposal(UUID riskId, UUID versionId, long revision, Status status, ProposalKind kind,
                    Participant author, DraftFields fields) {}

    record Listing<T>(String view, List<T> items) {}

    record Priority(int score, Category category, boolean criticalImpact) {
        static Priority from(DraftFields fields) {
            int score = fields.likelihood() * fields.impact();
            Category category = score < 20 ? Category.LOW : score < 40 ? Category.MEDIUM : Category.HIGH;
            return new Priority(score, category, fields.impact() >= 9);
        }
    }

    record Assessment(LocalDate date, LocalDate reviewDueDate, boolean reviewRequired) {
        static Assessment from(LocalDate date, RiskState state, LocalDate today) {
            LocalDate due = date.plusMonths(3);
            return new Assessment(date, due, state == RiskState.ACTIVE && !today.isBefore(due));
        }
    }

    record Summary(UUID riskId, UUID publishedVersionId, String title, Owner owner, int likelihood,
                   int impact, Priority priority, RiskState riskState, Assessment assessment, boolean hasOpenDraft) {}

    record Snapshot(UUID versionId, String title, String cause, String possibleEvent, String productConsequences,
                    Owner owner, int likelihood, int impact, Priority priority, String decisionNote,
                    String trackerUrl, RiskState riskState, String closureReason) {}

    record Unblock(UUID versionId, long revision, String authorDisplayName) {}

    record Published(UUID riskId, Snapshot snapshot, Assessment assessment, boolean hasOpenDraft,
                     @JsonInclude(JsonInclude.Include.NON_NULL) Unblock unblock) {}

    record Event(UUID versionId, Participant actor, EventAction action, OffsetDateTime occurredAt, String comment) {}

    record History(UUID riskId, List<Snapshot> publishedVersions, List<Event> events) {}
}
