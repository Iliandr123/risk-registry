package uptime.app.risks;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import uptime.app.accounts.AccountDirectory.Participant;
import uptime.app.risks.DraftFields.RiskState;
import uptime.app.risks.RiskVersion.Status;

@Repository
class RiskStore {
    private static final String OPEN = "status IN ('DRAFT', 'IN_REVIEW', 'RETURNED')";
    private static final String SUBMITTED = """
            EXISTS (SELECT 1 FROM risk_events e WHERE e.version_id = v.id AND e.action = 'SUBMIT')
            """;
    private static final String VERSIONS = "SELECT v.*, " + SUBMITTED + " AS submitted FROM risk_versions v ";
    private static final String FIELD_VALUES = """
            :title, :cause, :possibleEvent, :consequences, :likelihood, :impact,
            :note, :url, :state, :reason
            """;
    private static final String FIELD_COLUMNS = """
            title, cause, possible_event, product_consequences, likelihood, impact,
            decision_note, tracker_url, risk_state, closure_reason
            """;

    enum EventAction {
        SUBMIT, RETURN, APPROVE, WITHDRAW, UNBLOCK, CONFIRM_ASSESSMENT, ASSIGNMENT_CHANGED, ASSIGNMENT_MIGRATED,
        GROUP_CHANGED;

        boolean isAssignment() {
            return this == ASSIGNMENT_CHANGED || this == ASSIGNMENT_MIGRATED;
        }
    }

    record Risk(UUID id, UUID publishedVersionId, LocalDate assessmentDate, UUID assigneeId, long assignmentRevision,
                UUID groupId, long groupRevision) {
        boolean published() {
            return publishedVersionId != null;
        }
    }

    record PublishedRow(RiskVersion version, LocalDate assessmentDate, boolean hasOpenDraft, Participant assignee,
                        RiskGroup group) {}

    record Event(UUID versionId, UUID actorId, EventAction action, OffsetDateTime occurredAt, String comment,
                 UUID previousAssigneeId, UUID newAssigneeId, boolean firstPublicationWithGroupHistory,
                 String initialGroupName, String previousGroupName, String newGroupName) {}

    private final JdbcClient jdbc;

    RiskStore(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    void insertRisk(UUID id) {
        jdbc.sql("INSERT INTO risks (id) VALUES (?)").param(id).update();
    }

    Optional<Risk> risk(UUID id, boolean lock) {
        String select = """
                SELECT id, published_version_id, assessment_date, assignee_id, assignment_revision, group_id, group_revision
                FROM risks WHERE id = ?
                """;
        return jdbc.sql(lock ? select + " FOR UPDATE" : select).param(id).query((row, index) ->
                new Risk(uuid(row, "id"), uuid(row, "published_version_id"),
                        row.getObject("assessment_date", LocalDate.class),
                        uuid(row, "assignee_id"), row.getLong("assignment_revision"),
                        uuid(row, "group_id"), row.getLong("group_revision"))).optional();
    }

    RiskVersion insertDraft(UUID riskId, UUID authorId, DraftFields fields, UUID proposedGroupId) {
        UUID id = UUID.randomUUID();
        bindFields(jdbc.sql("INSERT INTO risk_versions (id, risk_id, author_id, status, proposed_group_id, "
                        + FIELD_COLUMNS + ") VALUES (:id, :risk, :author, 'DRAFT', :groupId, " + FIELD_VALUES + ")"), fields)
                .param("id", id).param("risk", riskId).param("author", authorId).param("groupId", proposedGroupId).update();
        return new RiskVersion(riskId, id, authorId, 1, Status.DRAFT, fields, null, false, proposedGroupId);
    }

    Optional<RiskVersion> version(UUID riskId, UUID versionId) {
        return jdbc.sql(VERSIONS + "WHERE v.risk_id = ? AND v.id = ?")
                .param(riskId).param(versionId).query(RiskStore::version).optional();
    }

    Optional<RiskVersion> draft(UUID riskId) {
        return jdbc.sql(VERSIONS + "WHERE v.risk_id = ? AND " + OPEN)
                .param(riskId).query(RiskStore::version).optional();
    }

    List<RiskVersion> versions(UUID riskId) {
        return jdbc.sql(VERSIONS + "WHERE v.risk_id = ?")
                .param(riskId).query(RiskStore::version).list();
    }

    List<RiskVersion> proposals(UUID authorId) {
        if (authorId == null) {
            return jdbc.sql(VERSIONS + "WHERE v.status = 'IN_REVIEW' ORDER BY v.risk_id")
                    .query(RiskStore::version).list();
        }
        return jdbc.sql(VERSIONS + "WHERE v.author_id = ? AND v.status <> 'APPROVED' ORDER BY v.risk_id, v.id")
                .param(authorId).query(RiskStore::version).list();
    }

    List<PublishedRow> published(boolean archive, UUID groupId, boolean ungrouped) {
        return jdbc.sql("""
                SELECT v.*, true AS submitted, r.assessment_date, r.assignee_id,
                       a.display_name AS assignee_name, a.active AS assignee_active,
                       r.group_id, g.name AS group_name,
                       EXISTS (SELECT 1 FROM risk_versions d WHERE d.risk_id = r.id AND
                """ + OPEN + """
                       ) AS has_open_draft
                FROM risks r JOIN risk_versions v ON (v.risk_id, v.id) = (r.id, r.published_version_id)
                LEFT JOIN accounts a ON a.id = r.assignee_id
                LEFT JOIN risk_groups g ON g.id = r.group_id
                WHERE (v.risk_state <> 'ACTIVE') = :archive
                    AND (:groupId::uuid IS NULL OR r.group_id = :groupId)
                    AND (NOT :ungrouped OR r.group_id IS NULL)
                """).param("archive", archive).param("groupId", groupId).param("ungrouped", ungrouped)
                .query((row, index) -> {
                    UUID assigneeId = uuid(row, "assignee_id");
                    Participant assignee = assigneeId == null ? null : new Participant(
                            assigneeId, row.getString("assignee_name"), row.getBoolean("assignee_active"));
                    UUID currentGroupId = uuid(row, "group_id");
                    RiskGroup group = currentGroupId == null ? null : new RiskGroup(currentGroupId, row.getString("group_name"));
                    return new PublishedRow(version(row, index), row.getObject("assessment_date", LocalDate.class),
                            row.getBoolean("has_open_draft"), assignee, group);
                }).list();
    }

    UUID firstApprovedAuthor(UUID riskId) {
        return jdbc.sql("""
                SELECT v.author_id
                FROM risk_events e JOIN risk_versions v ON (v.risk_id, v.id) = (e.risk_id, e.version_id)
                WHERE e.risk_id = ? AND e.action = 'APPROVE'
                ORDER BY e.id LIMIT 1
                """).param(riskId).query(UUID.class).single();
    }

    RiskVersion save(RiskVersion version, DraftFields fields, UUID proposedGroupId) {
        bindFields(jdbc.sql("UPDATE risk_versions SET (" + FIELD_COLUMNS + ") = (" + FIELD_VALUES
                        + "), proposed_group_id = :groupId, revision = revision + 1 WHERE id = :id"), fields)
                .param("id", version.id()).param("groupId", proposedGroupId).update();
        return new RiskVersion(version.riskId(), version.id(), version.authorId(), version.revision() + 1,
                version.status(), fields, version.historicalOwnerId(), version.submitted(), proposedGroupId);
    }

    RiskVersion transition(RiskVersion version, Status status) {
        jdbc.sql("UPDATE risk_versions SET status = ?, revision = revision + 1 WHERE id = ?")
                .param(status.name()).param(version.id()).update();
        return new RiskVersion(version.riskId(), version.id(), version.authorId(), version.revision() + 1,
                status, version.fields(), version.historicalOwnerId(), version.submitted() || status == Status.IN_REVIEW,
                version.proposedGroupId());
    }

    void publish(UUID riskId, UUID versionId, LocalDate assessmentDate) {
        jdbc.sql("UPDATE risks SET published_version_id = ?, assessment_date = ? WHERE id = ?")
                .param(versionId).param(assessmentDate).param(riskId).update();
    }

    void publishFirst(RiskVersion version, UUID actorId, OffsetDateTime time, String comment, String initialGroupName) {
        jdbc.sql("UPDATE risks SET published_version_id = ?, assessment_date = ?, group_id = ? WHERE id = ?")
                .param(version.id()).param(time.toLocalDate()).param(version.proposedGroupId()).param(version.riskId())
                .update();
        jdbc.sql("""
                INSERT INTO risk_events (risk_id, version_id, actor_id, action, occurred_at, comment,
                                         first_publication_with_group_history, initial_group_name)
                VALUES (?, ?, ?, 'APPROVE', ?, ?, true, ?)
                """).param(version.riskId()).param(version.id()).param(actorId).param(time).param(comment)
                .param(initialGroupName).update();
    }

    void append(UUID riskId, UUID versionId, UUID actorId, EventAction action, OffsetDateTime time, String comment) {
        jdbc.sql("""
                INSERT INTO risk_events (risk_id, version_id, actor_id, action, occurred_at, comment)
                VALUES (?, ?, ?, ?, ?, ?)
                """).param(riskId).param(versionId).param(actorId).param(action.name()).param(time).param(comment).update();
    }

    void changeAssignment(Risk risk, UUID assigneeId, UUID actorId, OffsetDateTime time) {
        jdbc.sql("UPDATE risks SET assignee_id = ?, assignment_revision = assignment_revision + 1 WHERE id = ?")
                .param(assigneeId).param(risk.id()).update();
        jdbc.sql("""
                INSERT INTO risk_events (risk_id, version_id, actor_id, action, occurred_at,
                                         previous_assignee_id, new_assignee_id)
                VALUES (?, ?, ?, 'ASSIGNMENT_CHANGED', ?, ?, ?)
                """).param(risk.id()).param(risk.publishedVersionId()).param(actorId).param(time)
                .param(risk.assigneeId()).param(assigneeId).update();
    }

    void changeGroup(Risk risk, UUID groupId, UUID actorId, OffsetDateTime time, String previousName, String newName) {
        jdbc.sql("UPDATE risks SET group_id = ?, group_revision = group_revision + 1 WHERE id = ?")
                .param(groupId).param(risk.id()).update();
        jdbc.sql("""
                INSERT INTO risk_events (risk_id, version_id, actor_id, action, occurred_at,
                                         previous_group_name, new_group_name)
                VALUES (?, ?, ?, 'GROUP_CHANGED', ?, ?, ?)
                """).param(risk.id()).param(risk.publishedVersionId()).param(actorId).param(time)
                .param(previousName).param(newName).update();
    }

    List<Event> events(UUID riskId) {
        return jdbc.sql("SELECT * FROM risk_events WHERE risk_id = ? ORDER BY id")
                .param(riskId).query((row, index) -> new Event(uuid(row, "version_id"), uuid(row, "actor_id"),
                        EventAction.valueOf(row.getString("action")), row.getObject("occurred_at", OffsetDateTime.class),
                        row.getString("comment"), uuid(row, "previous_assignee_id"), uuid(row, "new_assignee_id"),
                        row.getBoolean("first_publication_with_group_history"), row.getString("initial_group_name"),
                        row.getString("previous_group_name"), row.getString("new_group_name"))).list();
    }

    private static JdbcClient.StatementSpec bindFields(JdbcClient.StatementSpec query, DraftFields fields) {
        return query.param("title", fields.title()).param("cause", fields.cause())
                .param("possibleEvent", fields.possibleEvent()).param("consequences", fields.productConsequences())
                .param("likelihood", fields.likelihood()).param("impact", fields.impact())
                .param("note", fields.decisionNote()).param("url", fields.trackerUrl())
                .param("state", fields.riskState().name()).param("reason", fields.closureReason());
    }

    private static RiskVersion version(ResultSet row, int index) throws SQLException {
        var fields = new DraftFields(row.getString("title"), row.getString("cause"), row.getString("possible_event"),
                row.getString("product_consequences"), row.getObject("likelihood", Integer.class),
                row.getObject("impact", Integer.class), row.getString("decision_note"), row.getString("tracker_url"),
                RiskState.valueOf(row.getString("risk_state")), row.getString("closure_reason"));
        return new RiskVersion(uuid(row, "risk_id"), uuid(row, "id"), uuid(row, "author_id"),
                row.getLong("revision"), Status.valueOf(row.getString("status")), fields, uuid(row, "owner_id"),
                row.getBoolean("submitted"), uuid(row, "proposed_group_id"));
    }

    private static UUID uuid(ResultSet row, String column) throws SQLException {
        return row.getObject(column, UUID.class);
    }
}
