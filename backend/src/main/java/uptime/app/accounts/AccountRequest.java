package uptime.app.accounts;

import java.util.Set;
import tools.jackson.databind.JsonNode;
import uptime.app.http.ApiProblem;

record AccountRequest(JsonNode value) {
    AccountRequest(JsonNode value, String... fields) {
        this(value);
        Set<String> allowed = Set.of(fields);
        if (value == null || !value.isObject()
                || value.properties().stream().anyMatch(field -> !allowed.contains(field.getKey()))) {
            throw ApiProblem.invalidRequest();
        }
    }

    String text(String field) {
        JsonNode node = value.get(field);
        if (node == null || !node.isString() || node.asString().isBlank()) {
            throw ApiProblem.invalidRequest();
        }
        return node.asString();
    }

    String password(String field) {
        JsonNode node = value.get(field);
        if (node == null || !node.isString() || node.asString().isEmpty()) {
            throw ApiProblem.invalidRequest();
        }
        return node.asString();
    }

    Boolean flag(String field) {
        JsonNode node = value.get(field);
        if (node == null) {
            return null;
        }
        if (!node.isBoolean()) {
            throw ApiProblem.invalidRequest();
        }
        return node.asBoolean();
    }
}
