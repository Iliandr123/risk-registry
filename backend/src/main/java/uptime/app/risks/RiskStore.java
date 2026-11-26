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
            :title, :cause, :possibleEvent, :consequences, :owner, :likelihood, :impact,
            :note, :url, :state, :reason
            """;
    private static final String FIELD_COLUMNS = """
            title, cause, possible_event, product_consequences, owner_id, likelihood, impact,
            decision_note, tracker_url, risk_state, closure_reason
            """;

    enum EventAction { SUBMIT, RETURN, APPROVE, WITHDRAW, UNBLOCK, CONFIRM_ASSESSMENT }

    record Risk(UUID id, UUID publishedVersionId, LocalDate assessmentDate) {
        boolean published() {
            return publishedVersionId != null;
        }
    }

    record PublishedRow(RiskVersion version, LocalDate assessmentDate, boolean hasOpenDraft) {}

    record Event(UUID versionId, UUID actorId, EventAction action, OffsetDateTime occurredAt, String comment) {}

    private final JdbcClient jdbc;

    RiskStore(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    void insertRisk(UUID id) {
        jdbc.sql("INSERT INTO risks (id) VALUES (?)").param(id).update();
    }

    Optional<Risk> risk(UUID id, boolean lock) {
        String select = "SELECT id, published_version_id, assessment_date FROM risks WHERE id = ?";
        return jdbc.sql(lock ? select + " FOR UPDATE" : select).param(id).query((row, index) ->
                new Risk(uuid(row, "id"), uuid(row, "published_version_id"),
                        row.getObject("assessment_date", LocalDate.class))).optional();
    }

    RiskVersion insertDraft(UUID riskId, UUID authorId, DraftFields fields) {
        UUID id = UUID.randomUUID();
        bindFields(jdbc.sql("INSERT INTO risk_versions (id, risk_id, author_id, status, " + FIELD_COLUMNS
                        + ") VALUES (:id, :risk, :author, 'DRAFT', " + FIELD_VALUES + ")"), fields)
                .param("id", id).param("risk", riskId).param("author", authorId).update();
        return new RiskVersion(riskId, id, authorId, 1, Status.DRAFT, fields, false);
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

    List<PublishedRow> published(boolean archive) {
        return jdbc.sql("""
                SELECT v.*, true AS submitted, r.assessment_date,
                       EXISTS (SELECT 1 FROM risk_versions d WHERE d.risk_id = r.id AND
                """ + OPEN + """
                       ) AS has_open_draft
                FROM risks r JOIN risk_versions v ON (v.risk_id, v.id) = (r.id, r.published_version_id)
                WHERE (v.risk_state <> 'ACTIVE') = ?
                """).param(archive).query((row, index) -> new PublishedRow(version(row, index),
                        row.getObject("assessment_date", LocalDate.class), row.getBoolean("has_open_draft"))).list();
    }

    RiskVersion save(RiskVersion version, DraftFields fields) {
        bindFields(jdbc.sql("UPDATE risk_versions SET (" + FIELD_COLUMNS + ") = (" + FIELD_VALUES
                        + "), revision = revision + 1 WHERE id = :id"), fields)
                .param("id", version.id()).update();
        return new RiskVersion(version.riskId(), version.id(), version.authorId(), version.revision() + 1,
                version.status(), fields, version.submitted());
    }

    RiskVersion transition(RiskVersion version, Status status) {
        jdbc.sql("UPDATE risk_versions SET status = ?, revision = revision + 1 WHERE id = ?")
                .param(status.name()).param(version.id()).update();
        return new RiskVersion(version.riskId(), version.id(), version.authorId(), version.revision() + 1,
                status, version.fields(), version.submitted() || status == Status.IN_REVIEW);
    }

    void publish(UUID riskId, UUID versionId, LocalDate assessmentDate) {
        jdbc.sql("UPDATE risks SET published_version_id = ?, assessment_date = ? WHERE id = ?")
                .param(versionId).param(assessmentDate).param(riskId).update();
    }

    void append(UUID riskId, UUID versionId, UUID actorId, EventAction action, OffsetDateTime time, String comment) {
        jdbc.sql("""
                INSERT INTO risk_events (risk_id, version_id, actor_id, action, occurred_at, comment)
                VALUES (?, ?, ?, ?, ?, ?)
                """).param(riskId).param(versionId).param(actorId).param(action.name()).param(time).param(comment).update();
    }

    List<Event> events(UUID riskId) {
        return jdbc.sql("SELECT * FROM risk_events WHERE risk_id = ? ORDER BY id")
                .param(riskId).query((row, index) -> new Event(uuid(row, "version_id"), uuid(row, "actor_id"),
                        EventAction.valueOf(row.getString("action")), row.getObject("occurred_at", OffsetDateTime.class),
                        row.getString("comment"))).list();
    }

    private static JdbcClient.StatementSpec bindFields(JdbcClient.StatementSpec query, DraftFields fields) {
        return query.param("title", fields.title()).param("cause", fields.cause())
                .param("possibleEvent", fields.possibleEvent()).param("consequences", fields.productConsequences())
                .param("owner", fields.ownerId()).param("likelihood", fields.likelihood()).param("impact", fields.impact())
                .param("note", fields.decisionNote()).param("url", fields.trackerUrl())
                .param("state", fields.riskState().name()).param("reason", fields.closureReason());
    }

    private static RiskVersion version(ResultSet row, int index) throws SQLException {
        var fields = new DraftFields(row.getString("title"), row.getString("cause"), row.getString("possible_event"),
                row.getString("product_consequences"), uuid(row, "owner_id"), row.getObject("likelihood", Integer.class),
                row.getObject("impact", Integer.class), row.getString("decision_note"), row.getString("tracker_url"),
                RiskState.valueOf(row.getString("risk_state")), row.getString("closure_reason"));
        return new RiskVersion(uuid(row, "risk_id"), uuid(row, "id"), uuid(row, "author_id"),
                row.getLong("revision"), Status.valueOf(row.getString("status")), fields, row.getBoolean("submitted"));
    }

    private static UUID uuid(ResultSet row, String column) throws SQLException {
        return row.getObject(column, UUID.class);
    }
}
