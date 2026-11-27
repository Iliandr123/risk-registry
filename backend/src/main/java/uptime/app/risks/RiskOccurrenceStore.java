package uptime.app.risks;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import uptime.app.risks.RiskOccurrence.Content;
import uptime.app.risks.RiskOccurrence.Cursor;
import uptime.app.risks.RiskResponses.Participant;

@Repository
class RiskOccurrenceStore {
    private static final String SELECT = """
            SELECT o.id, o.text, o.url, o.author_id, a.display_name, o.created_at, o.revision
            FROM risk_occurrences o JOIN accounts a ON a.id = o.author_id
            WHERE o.risk_id = ?
            """;
    private final JdbcClient jdbc;

    RiskOccurrenceStore(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    List<RiskOccurrence> page(UUID riskId, Cursor cursor, int limit) {
        String boundary = cursor == null ? "" : "AND (o.created_at, o.id) < (?, ?) ";
        var query = jdbc.sql(SELECT + boundary + "ORDER BY o.created_at DESC, o.id DESC LIMIT ?").param(riskId);
        if (cursor != null) {
            query.param(cursor.createdAt()).param(cursor.id());
        }
        return query.param(limit).query(RiskOccurrenceStore::map).list();
    }

    Optional<RiskOccurrence> find(UUID riskId, UUID id) {
        return jdbc.sql(SELECT + "AND o.id = ?").param(riskId).param(id).query(RiskOccurrenceStore::map).optional();
    }

    RiskOccurrence insert(UUID riskId, UUID authorId, Content content) {
        UUID id = UUID.randomUUID();
        jdbc.sql("INSERT INTO risk_occurrences (id, risk_id, author_id, text, url) VALUES (?, ?, ?, ?, ?)")
                .param(id).param(riskId).param(authorId).param(content.text()).param(content.url()).update();
        return find(riskId, id).orElseThrow();
    }

    RiskOccurrence update(UUID riskId, UUID id, Content content) {
        jdbc.sql("UPDATE risk_occurrences SET text = ?, url = ?, revision = revision + 1 WHERE risk_id = ? AND id = ?")
                .param(content.text()).param(content.url()).param(riskId).param(id).update();
        return find(riskId, id).orElseThrow();
    }

    void delete(UUID riskId, UUID id) {
        jdbc.sql("DELETE FROM risk_occurrences WHERE risk_id = ? AND id = ?").param(riskId).param(id).update();
    }

    private static RiskOccurrence map(ResultSet row, int index) throws SQLException {
        var author = new Participant(row.getObject("author_id", UUID.class), row.getString("display_name"));
        var createdAt = row.getObject("created_at", OffsetDateTime.class).withOffsetSameInstant(ZoneOffset.UTC);
        return new RiskOccurrence(row.getObject("id", UUID.class), row.getString("text"), row.getString("url"),
                author, createdAt, row.getLong("revision"));
    }
}
