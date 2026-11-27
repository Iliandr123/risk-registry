package uptime.app.risks;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
class RiskGroupStore {
    private final JdbcClient jdbc;

    RiskGroupStore(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    List<RiskGroup> list() {
        return jdbc.sql("SELECT id, name FROM risk_groups ORDER BY normalized_name, id")
                .query(RiskGroupStore::group).list();
    }

    Optional<RiskGroup> find(UUID id) {
        return jdbc.sql("SELECT id, name FROM risk_groups WHERE id = ?")
                .param(id).query(RiskGroupStore::group).optional();
    }

    void insert(RiskGroup group, String normalizedName) {
        jdbc.sql("INSERT INTO risk_groups (id, name, normalized_name) VALUES (?, ?, ?)")
                .param(group.id()).param(group.name()).param(normalizedName).update();
    }

    boolean rename(RiskGroup group, String normalizedName) {
        return jdbc.sql("UPDATE risk_groups SET name = ?, normalized_name = ? WHERE id = ?")
                .param(group.name()).param(normalizedName).param(group.id()).update() == 1;
    }

    Map<UUID, RiskGroup> lockForHistory(UUID... groupIds) {
        var ids = Stream.of(groupIds).filter(id -> id != null).distinct().toList();
        if (ids.isEmpty()) {
            return Map.of();
        }
        return jdbc.sql("SELECT id, name FROM risk_groups WHERE id IN (:ids) ORDER BY id FOR SHARE")
                .param("ids", ids).query(RiskGroupStore::group).list().stream()
                .collect(Collectors.toMap(RiskGroup::id, Function.identity()));
    }

    private static RiskGroup group(ResultSet row, int index) throws SQLException {
        return new RiskGroup(row.getObject("id", UUID.class), row.getString("name"));
    }
}
